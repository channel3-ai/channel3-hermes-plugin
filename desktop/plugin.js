// Channel3 — inline product cards for the Hermes Desktop transcript.
//
// The agent searches through the Channel3 MCP server this package bundles
// (mcp.json) and the bundled skill tells it to show results as directives
// carrying product ids only:
//
//   ::channel3-products{ids="LZeQAgT,RsMjV5x,AybWRtH"}   a row of compact cards
//   ::channel3-product{id="LZeQAgT"}                     one detailed card
//
// The cards load everything else themselves from the same public MCP endpoint
// (keyless free tier, CORS-open): `get_products` for the initial data and the
// UI-only `get_details` tool to re-resolve a variant when the user picks a
// color or size. Variant clicks never go through the model.
//
// Constraints this file lives under, all enforced by the host:
//   - loaded uncompiled, so no JSX syntax: jsx()/jsxs() calls only;
//   - the only resolvable imports are @hermes/plugin-sdk, react and
//     react/jsx-runtime, so everything stays in this one file;
//   - directive attributes are untrusted model output, and so is anything a
//     network response could smuggle into a link: ids are pattern-checked,
//     images must come from the Channel3 CDN, buy links from Channel3's
//     redirect host.

import { Button, host, icons, Skeleton, TRANSCRIPT_DIRECTIVE_AREA } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const MCP_URL = 'https://mcp.trychannel3.com/'
const IMAGE_HOSTS = ['cdn.trychannel3.com']
const BUY_HOSTS = ['buy.trychannel3.com']
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_ROW = 8
const MAX_SWATCHES = 6

// ---------------------------------------------------------------------------
// Channel3 MCP client: one JSON-RPC `tools/call` per request, no session.
// ---------------------------------------------------------------------------

let rpcId = 0

/** The JSON-RPC message in a Streamable HTTP response (plain JSON or SSE). */
function parseRpc(text) {
  const body = text.trim()
  if (body.startsWith('{')) return JSON.parse(body)
  const lines = body.split('\n').filter((line) => line.startsWith('data:'))
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const message = JSON.parse(lines[i].slice(5))
      if (message.result || message.error) return message
    } catch {
      // keep looking: an SSE stream may carry non-JSON keepalives
    }
  }
  throw new Error('Unreadable response from Channel3')
}

async function callTool(name, args) {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  })
  if (!response.ok) throw new Error(`Channel3 returned HTTP ${response.status}`)
  const message = parseRpc(await response.text())
  if (message.error) throw new Error(message.error.message || 'Channel3 error')
  const result = message.result || {}
  if (result.isError) {
    const detail = (result.content || []).map((part) => part.text).filter(Boolean).join(' ')
    throw new Error(detail || 'Channel3 error')
  }
  return result.structuredContent || {}
}

// Module-scope cache so a re-render (or the same product in two messages)
// never refetches. Cleared when the plugin unloads.
const productCache = new Map()

function variantKey(id, selection) {
  const parts = Object.keys(selection).sort().map((name) => `${name}=${selection[name]}`)
  return `${id}|${parts.join('&')}`
}

// Ids the server could not resolve (delisted, no merchant): skipped, never refetched.
const unavailable = new Set()

const NOT_FOUND = /404|NotFound|not found|No available merchant/i

/**
 * Products for `ids`, in the order asked, from cache or one batched call.
 * Unresolvable ids are dropped so one delisted product never blanks the row.
 * A batch with some resolvable ids returns those and omits the rest, but a
 * batch where none resolve comes back as a 404 error, so that error means
 * "all of these are unavailable", not a failure. Other errors (rate limit,
 * network) still throw.
 */
async function loadProducts(ids) {
  const missing = ids.filter((id) => !productCache.has(id) && !unavailable.has(id))
  if (missing.length) {
    let products = []
    try {
      products = (await callTool('get_products', { product_ids: missing })).products || []
    } catch (error) {
      if (!NOT_FOUND.test(String(error && error.message))) throw error
    }
    for (const product of products) {
      if (product && product.id) productCache.set(product.id, product)
    }
    for (const id of missing) {
      if (!productCache.has(id)) unavailable.add(id)
    }
  }
  return ids.map((id) => productCache.get(id)).filter(Boolean)
}

/** The concrete product for a variant selection, resolved server-side. */
async function resolveVariant(product, selection) {
  const key = variantKey(product.id, selection)
  if (productCache.has(key)) return productCache.get(key)
  const data = await callTool('get_details', { product_id: product.id, selected_options: selection })
  if (!data.product) throw new Error('Channel3 returned no product for that option')
  productCache.set(key, data.product)
  productCache.set(data.product.id, data.product)
  return data.product
}

// ---------------------------------------------------------------------------
// Validation and formatting
// ---------------------------------------------------------------------------

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function parseIds(attrs) {
  const raw = text(attrs.ids) || text(attrs.id)
  const ids = raw.split(',').map((id) => id.trim()).filter((id) => PRODUCT_ID.test(id))
  return [...new Set(ids)].slice(0, MAX_ROW)
}

function onHost(url, hosts) {
  if (typeof url !== 'string' || !url) return ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return ''
    return hosts.includes(parsed.hostname.toLowerCase()) ? parsed.toString() : ''
  } catch {
    return ''
  }
}

const imageUrl = (url) => onHost(url, IMAGE_HOSTS)
const buyUrl = (url) => onHost(url, BUY_HOSTS)

function money(price) {
  if (!price || !Number.isFinite(price.price)) return ''
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency || 'USD' }).format(price.price)
  } catch {
    return `$${price.price.toFixed(2)}`
  }
}

function compareAt(price) {
  if (!price || !Number.isFinite(price.compare_at_price) || price.compare_at_price <= price.price) return ''
  return money({ price: price.compare_at_price, currency: price.currency })
}

/**
 * One displayable shot. Channel3's cleaned version (`cleaned_url`: a square
 * crop on a uniform white background) is preferred wherever it exists, so
 * cards line up and fill their tile; raw retailer shots are letterboxed.
 */
function shot(image) {
  const cleaned = imageUrl(image.cleaned_url)
  return { src: cleaned || imageUrl(image.url), cleaned: Boolean(cleaned), alt: text(image.alt_text) }
}

/** The card image: the main shot when it has a cleaned version, else the first cleaned shot, else the main shot. */
function mainImage(product) {
  const images = product.images || []
  const main = images.find((image) => image.is_main_image) || images[0]
  const pick = main && imageUrl(main.cleaned_url) ? main : images.find((image) => imageUrl(image.cleaned_url)) || main
  const picked = pick ? shot(pick) : null
  return picked && picked.src ? picked : null
}

/** Every shot, main first, deduplicated (a cleaned url can equal its raw url). */
function galleryImages(product) {
  const images = [...(product.images || [])].sort((a, b) => Number(Boolean(b.is_main_image)) - Number(Boolean(a.is_main_image)))
  const seen = new Set()
  const out = []
  for (const image of images) {
    const item = shot(image)
    if (!item.src || seen.has(item.src)) continue
    seen.add(item.src)
    out.push(item)
  }
  return out
}

/** In-stock offers first, cheapest first within each group. */
function sortedOffers(product) {
  const rank = (offer) => (offer.availability === 'InStock' ? 0 : 1)
  return [...(product.offers || [])].sort((a, b) => rank(a) - rank(b) || (a.price?.price ?? Infinity) - (b.price?.price ?? Infinity))
}

const AVAILABILITY = {
  InStock: 'In stock',
  OutOfStock: 'Out of stock',
  PreOrder: 'Pre-order',
  BackOrder: 'Backorder',
  LimitedAvailability: 'Limited stock',
  SoldOut: 'Sold out',
  Discontinued: 'Discontinued',
}

function availabilityLabel(offer) {
  const raw = text(offer.availability)
  return AVAILABILITY[raw] || raw.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Availability unknown'
}

function brandOf(product) {
  return text(product.brands?.[0]?.name)
}

function storeName(domain) {
  return text(domain).replace(/^www\./, '')
}

function selectionOf(product) {
  const selection = {}
  for (const entry of product.variants?.selected || []) {
    if (entry && entry.name && entry.label) selection[entry.name] = entry.label
  }
  return selection
}

function features(product) {
  return (product.key_features || []).map(text).filter(Boolean).slice(0, 4)
}

function openLink(ctx, url) {
  if (!url) return
  ctx.os.openExternal(url).then((ok) => {
    if (!ok) host.notify({ kind: 'info', title: 'Open this link in your browser', message: url })
  })
}

// ---------------------------------------------------------------------------
// Styles: theme variables, so the cards reskin with every Hermes theme. Real
// actions use the host's own Button, which carries its hover, focus and
// disabled states; the custom controls below track hover/focus in state
// because inline styles have no :hover.
// ---------------------------------------------------------------------------

// Cards render inside the assistant message's markdown, where Tailwind
// Typography (`.prose img { margin: 2em 0 }`, ...) would restyle our elements.
// `not-prose` on every card root opts out; images also zero their own margins.
const NOT_PROSE = 'not-prose'

const BORDER = '1px solid var(--ui-stroke-secondary)'
const MUTED = 'var(--ui-text-tertiary)'
const SECONDARY = 'var(--ui-text-secondary)'
const PRIMARY = 'var(--ui-text-primary)'
const HOVER_BG = 'var(--ui-control-hover-background)'
const ACTIVE_BG = 'var(--ui-control-active-background)'
const ACCENT = 'var(--ui-accent)'
const FOCUS_RING = '0 0 0 2px color-mix(in srgb, var(--ui-accent) 55%, transparent)'
// Product photography (cleaned shots especially) is shot on white, so the
// tile behind it is white in every theme: any other color shows as a frame.
const PHOTO_BG = '#fff'
const PHOTO_EDGE = 'inset 0 0 0 1px rgba(0, 0, 0, 0.06)'
const IMG = { display: 'block', margin: 0, maxWidth: 'none', width: '100%', height: '100%', boxSizing: 'border-box' }
const EASE = 'cubic-bezier(0.2, 0, 0, 1)'

const S = {
  stack: { display: 'flex', flexDirection: 'column', gap: '10px', margin: '8px 0' },
  row: { display: 'flex', gap: '12px', overflowX: 'auto', padding: '2px 2px 8px', maxWidth: '100%', scrollSnapType: 'x proximity' },
  compact: ({ open, hover, focus }) => ({
    flex: '0 0 184px', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0, padding: '8px', borderRadius: '12px',
    cursor: 'pointer', textAlign: 'left', outline: 'none', scrollSnapAlign: 'start',
    border: open ? `1px solid ${ACCENT}` : BORDER,
    background: open ? ACTIVE_BG : hover ? HOVER_BG : 'transparent',
    boxShadow: focus ? FOCUS_RING : 'none',
    transition: `background 120ms ${EASE}, border-color 120ms ${EASE}, opacity 150ms`,
  }),
  photo: { position: 'relative', aspectRatio: '1 / 1', borderRadius: '8px', overflow: 'hidden', background: PHOTO_BG, boxShadow: PHOTO_EDGE },
  photoImg: (cleaned, loaded, zoom) => ({
    ...IMG,
    objectFit: cleaned ? 'cover' : 'contain',
    padding: cleaned ? 0 : '8%',
    opacity: loaded ? 1 : 0,
    transform: zoom ? 'scale(1.04)' : 'none',
    transition: `opacity 200ms ${EASE}, transform 300ms ${EASE}`,
  }),
  photoEmpty: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(0, 0, 0, 0.25)' },
  badges: { position: 'absolute', top: '6px', left: '6px', display: 'flex', gap: '4px' },
  badge: (tone) => ({
    fontSize: '10px', fontWeight: 600, lineHeight: '16px', padding: '0 6px', borderRadius: '999px',
    background: tone === 'sale' ? 'var(--ui-red)' : 'rgba(0, 0, 0, 0.65)', color: '#fff',
  }),
  cardBody: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '0 2px', minWidth: 0 },
  brand: { fontSize: '11px', fontWeight: 500, color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  // Two lines reserved so prices line up across a row.
  title: { fontSize: '13px', fontWeight: 500, lineHeight: '18px', minHeight: '36px', color: PRIMARY, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
  priceLine: { display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' },
  price: (size) => ({ fontSize: size === 'lg' ? '20px' : '13px', fontWeight: 600, color: PRIMARY, fontVariantNumeric: 'tabular-nums' }),
  was: { fontSize: '11px', color: MUTED, textDecoration: 'line-through', fontVariantNumeric: 'tabular-nums' },
  meta: { fontSize: '11px', color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  swatchRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
  swatch: ({ size, selected, off, hover, focus }) => ({
    width: `${size}px`, height: `${size}px`, borderRadius: '999px', padding: '2px', boxSizing: 'border-box', flex: 'none',
    background: 'transparent', cursor: off ? 'default' : 'pointer', opacity: off ? 0.35 : 1, outline: 'none',
    border: `1.5px solid ${selected ? ACCENT : hover && !off ? 'var(--ui-text-quaternary)' : 'var(--ui-stroke-secondary)'}`,
    boxShadow: focus ? FOCUS_RING : 'none',
    transition: `border-color 120ms ${EASE}`,
  }),
  // Variant thumbnails are full product shots; zooming in past the margins
  // keeps the product legible at swatch size.
  swatchWrap: { display: 'block', width: '100%', height: '100%', borderRadius: '999px', overflow: 'hidden', background: PHOTO_BG },
  swatchImg: { ...IMG, objectFit: 'cover', transform: 'scale(1.4)' },
  chip: ({ selected, off, hover, focus }) => ({
    fontSize: '12px', lineHeight: '16px', padding: '5px 10px', borderRadius: '8px', minWidth: '36px', outline: 'none',
    cursor: off ? 'default' : 'pointer', color: selected ? PRIMARY : off ? MUTED : SECONDARY, fontWeight: selected ? 600 : 400,
    border: selected ? `1.5px solid ${ACCENT}` : BORDER,
    background: selected ? ACTIVE_BG : hover && !off ? HOVER_BG : 'transparent',
    textDecoration: off ? 'line-through' : 'none', opacity: off ? 0.6 : 1, boxShadow: focus ? FOCUS_RING : 'none',
    transition: `background 120ms ${EASE}, border-color 120ms ${EASE}`,
  }),
  more: { fontSize: '11px', color: MUTED, paddingLeft: '2px' },
  detail: {
    position: 'relative', display: 'flex', flexWrap: 'wrap', gap: '20px', padding: '16px', borderRadius: '14px', border: BORDER,
    background: 'var(--ui-bg-elevated)', maxWidth: '46rem', transition: 'opacity 150ms',
  },
  close: { position: 'absolute', top: '10px', right: '10px' },
  media: { flex: '1 1 240px', maxWidth: '300px', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 },
  nav: (side) => ({ position: 'absolute', top: '50%', [side]: '6px', transform: 'translateY(-50%)' }),
  counter: { position: 'absolute', bottom: '6px', right: '6px', fontSize: '10px', lineHeight: '16px', padding: '0 6px', borderRadius: '999px', background: 'rgba(0, 0, 0, 0.55)', color: '#fff' },
  thumbs: { display: 'flex', gap: '6px', overflowX: 'auto', padding: '2px' },
  thumb: ({ active, hover, focus }) => ({
    flex: '0 0 48px', height: '48px', borderRadius: '6px', overflow: 'hidden', padding: 0, cursor: 'pointer', background: PHOTO_BG, outline: 'none',
    border: `1.5px solid ${active ? ACCENT : hover ? 'var(--ui-text-quaternary)' : 'transparent'}`,
    opacity: active || hover ? 1 : 0.75, boxShadow: focus ? FOCUS_RING : PHOTO_EDGE,
    transition: `opacity 120ms ${EASE}, border-color 120ms ${EASE}`,
  }),
  body: { flex: '1 1 280px', display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 },
  heading: { display: 'flex', flexDirection: 'column', gap: '4px', paddingRight: '32px' },
  detailTitle: { fontSize: '16px', fontWeight: 600, lineHeight: 1.3, color: PRIMARY },
  optionLabel: { fontSize: '12px', marginBottom: '6px', color: MUTED },
  optionName: { fontWeight: 600, color: PRIMARY },
  cta: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  section: { fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: MUTED, marginBottom: '2px' },
  bullets: { margin: 0, paddingLeft: '18px', fontSize: '12px', lineHeight: 1.5, color: SECONDARY, listStyle: 'disc' },
  description: (expanded) => ({
    fontSize: '12px', lineHeight: 1.5, color: SECONDARY, whiteSpace: 'pre-line',
    ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
  }),
  offerRow: (first) => ({ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '8px 0', borderTop: first ? 'none' : BORDER }),
  offerStore: { fontSize: '13px', fontWeight: 500, color: PRIMARY, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  stock: (inStock) => ({ fontSize: '11px', color: inStock ? 'var(--ui-green)' : MUTED }),
  error: { fontSize: '12px', color: MUTED, border: BORDER, borderRadius: '10px', padding: '8px 12px', margin: '8px 0', display: 'flex', gap: '10px', alignItems: 'center', justifyContent: 'space-between' },
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Loads `ids` once per distinct list; `retry` re-runs after a failure. */
function useProducts(ids) {
  const key = ids.join(',')
  const [state, setState] = useState({ status: 'loading', products: [], error: '' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    if (!ids.length) {
      setState({ status: 'error', products: [], error: 'No valid product ids in this card.' })
      return undefined
    }
    setState((prev) => ({ ...prev, status: 'loading' }))
    loadProducts(ids).then(
      (products) => live && setState({ status: products.length ? 'ready' : 'error', products, error: products.length ? '' : 'These products are no longer available.' }),
      (error) => live && setState({ status: 'error', products: [], error: error.message || String(error) }),
    )
    return () => {
      live = false
    }
  }, [key, attempt])

  return [state, () => setAttempt((n) => n + 1)]
}

/** One product whose variant can be switched in place. */
function useVariantProduct(initial) {
  const [product, setProduct] = useState(initial)
  const [resolving, setResolving] = useState(false)

  useEffect(() => setProduct(initial), [initial])

  const choose = (name, label) => {
    const selection = { ...selectionOf(product), [name]: label }
    setResolving(true)
    resolveVariant(product, selection).then(
      (next) => {
        setProduct(next)
        setResolving(false)
      },
      (error) => {
        setResolving(false)
        host.notify({ kind: 'error', title: 'Could not load that option', message: error.message || String(error) })
      },
    )
  }

  return { product, resolving, choose }
}

/** Hover and keyboard-focus state for a custom control (inline styles have no :hover / :focus-visible). */
function useInteractive() {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  return [
    { hover, focus },
    {
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      onFocus: (event) => setFocus(event.currentTarget === event.target && event.target.matches(':focus-visible')),
      onBlur: (event) => event.currentTarget === event.target && setFocus(false),
    },
  ]
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Photo({ image, preview, zoom, badges, children }) {
  const shown = preview || image
  const src = shown ? shown.src : ''
  const [state, setState] = useState({ src, loaded: false, failed: false })
  if (state.src !== src) setState({ src, loaded: false, failed: false })
  const loaded = state.src === src && state.loaded
  const failed = state.src === src && state.failed

  return jsxs('div', {
    style: S.photo,
    children: [
      src && !failed
        ? jsx('img', {
            key: src,
            src,
            alt: shown.alt || '',
            loading: 'lazy',
            decoding: 'async',
            draggable: false,
            style: S.photoImg(shown.cleaned, loaded, zoom),
            ref: (node) => node && node.complete && node.naturalWidth > 0 && !loaded && setState({ src, loaded: true, failed: false }),
            onLoad: () => setState({ src, loaded: true, failed: false }),
            onError: () => setState({ src, loaded: false, failed: true }),
          })
        : jsx('div', { style: S.photoEmpty, children: jsx(icons.ImageIcon, { size: 28, 'aria-hidden': true }) }),
      badges && badges.length
        ? jsx('div', { style: S.badges, children: badges.map((badge) => jsx('span', { style: S.badge(badge.tone), children: badge.label }, badge.label)) })
        : null,
      children,
    ],
  })
}

function PriceLine({ offer, size }) {
  if (!offer) return jsx('div', { style: S.meta, children: 'No current offers' })
  const was = compareAt(offer.price)
  return jsxs('div', {
    style: S.priceLine,
    children: [
      jsx('span', { style: S.price(size), children: money(offer.price) }),
      was ? jsx('span', { style: { ...S.was, fontSize: size === 'lg' ? '13px' : '11px' }, children: was }) : null,
    ],
  })
}

function cardBadges(offers) {
  const best = offers[0]
  if (!best) return []
  if (best.availability !== 'InStock' && offers.every((offer) => offer.availability !== 'InStock')) return [{ label: 'Sold out', tone: 'muted' }]
  return compareAt(best.price) ? [{ label: 'Sale', tone: 'sale' }] : []
}

function Swatch({ value, size, selected, off, onChoose, onPreview }) {
  const [state, handlers] = useInteractive()
  const label = text(value.label)
  const thumb = imageUrl(value.thumbnail_url)
  const title = off && !selected ? `${label} (unavailable)` : label
  // Preview the variant's own cleaned shot when it is already loaded; the raw
  // thumbnail is cropped to fill the tile like a cleaned one.
  const preview = (on) => {
    if (!onPreview || !thumb) return
    const loaded = PRODUCT_ID.test(value.product_id || '') && productCache.get(value.product_id)
    onPreview(on ? (loaded && mainImage(loaded)) || { src: thumb, cleaned: true, alt: label } : null)
  }
  return jsx('button', {
    type: 'button',
    title,
    'aria-label': title,
    'aria-pressed': selected,
    disabled: off,
    ...handlers,
    onMouseEnter: () => {
      handlers.onMouseEnter()
      preview(true)
    },
    onMouseLeave: () => {
      handlers.onMouseLeave()
      preview(false)
    },
    onClick: (event) => {
      event.stopPropagation()
      if (!off && !selected) onChoose(label)
    },
    onKeyDown: (event) => event.stopPropagation(),
    style: S.swatch({ size, selected, off, ...state }),
    children: thumb ? jsx('span', { style: S.swatchWrap, children: jsx('img', { src: thumb, alt: '', draggable: false, style: S.swatchImg }) }) : null,
  })
}

function Chip({ value, selected, off, onChoose }) {
  const [state, handlers] = useInteractive()
  const label = text(value.label)
  return jsx('button', {
    type: 'button',
    title: off && !selected ? `${label} (unavailable)` : label,
    'aria-pressed': selected,
    disabled: off,
    ...handlers,
    onClick: (event) => {
      event.stopPropagation()
      if (!off && !selected) onChoose(label)
    },
    onKeyDown: (event) => event.stopPropagation(),
    style: S.chip({ selected, off, ...state }),
    children: label,
  })
}

/** Color-like options (values with thumbnails) render as swatches, the rest as chips. */
function OptionValues({ option, selected, disabled, onChoose, onPreview, limit, size }) {
  const values = (option.values || []).filter((value) => text(value.label))
  const swatches = values.some((value) => imageUrl(value.thumbnail_url))
  const shown = limit ? values.slice(0, limit) : values
  const overflow = values.length - shown.length
  const choose = (label) => onChoose(option.name, label)

  const buttons = shown.map((value) => {
    const label = text(value.label)
    const isSelected = label === selected
    const off = disabled || value.exists === false || value.available === false
    return swatches
      ? jsx(Swatch, { value, size: size || 22, selected: isSelected, off, onChoose: choose, onPreview }, label)
      : jsx(Chip, { value, selected: isSelected, off, onChoose: choose }, label)
  })

  if (overflow > 0) buttons.push(jsx('span', { style: S.more, children: `+${overflow}` }, 'more'))
  return jsx('div', { style: S.swatchRow, role: 'group', 'aria-label': option.name, children: buttons })
}

function CardSkeleton() {
  return jsxs('div', {
    className: NOT_PROSE,
    style: { ...S.compact({}), cursor: 'default' },
    children: [
      jsx(Skeleton, { style: { width: '100%', aspectRatio: '1 / 1', borderRadius: '8px' } }),
      jsxs('div', {
        style: S.cardBody,
        children: [
          jsx(Skeleton, { style: { height: '10px', width: '40%' } }),
          jsx(Skeleton, { style: { height: '12px', width: '90%', marginTop: '6px' } }),
          jsx(Skeleton, { style: { height: '12px', width: '60%', marginTop: '4px' } }),
          jsx(Skeleton, { style: { height: '12px', width: '30%', marginTop: '10px' } }),
        ],
      }),
    ],
  })
}

function DetailSkeleton() {
  return jsxs('div', {
    className: NOT_PROSE,
    style: S.detail,
    children: [
      jsx('div', { style: S.media, children: jsx(Skeleton, { style: { width: '100%', aspectRatio: '1 / 1', borderRadius: '8px' } }) }),
      jsxs('div', {
        style: S.body,
        children: [
          jsx(Skeleton, { style: { height: '10px', width: '25%' } }),
          jsx(Skeleton, { style: { height: '16px', width: '70%' } }),
          jsx(Skeleton, { style: { height: '20px', width: '20%' } }),
          jsx(Skeleton, { style: { height: '32px', width: '45%', marginTop: '8px' } }),
        ],
      }),
    ],
  })
}

function ErrorNote({ message, onRetry }) {
  return jsxs('div', {
    className: NOT_PROSE,
    role: 'alert',
    style: S.error,
    children: [
      jsx('span', { children: `Couldn't load from Channel3: ${message}` }),
      onRetry
        ? jsxs(Button, { variant: 'outline', size: 'xs', onClick: onRetry, children: [jsx(icons.RefreshCw, { 'aria-hidden': true }), 'Retry'] })
        : null,
    ],
  })
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** Clicking the card opens its detail view (on the variant currently shown). */
function CompactCard({ initial, isOpen, onOpen }) {
  const { product, resolving, choose } = useVariantProduct(initial)
  const [state, handlers] = useInteractive()
  const [preview, setPreview] = useState(null)
  const offers = sortedOffers(product)
  const best = offers[0]
  const firstOption = product.variants?.options?.[0]
  const selection = selectionOf(product)
  const stores = offers.length > 1 ? `${storeName(best.domain)} + ${offers.length - 1} more` : best ? storeName(best.domain) : ''
  const open = () => onOpen(product)

  return jsxs('div', {
    role: 'button',
    tabIndex: 0,
    'aria-expanded': isOpen,
    'aria-label': `${product.title}${best ? `, ${money(best.price)}` : ''}: show details`,
    ...handlers,
    onClick: open,
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        open()
      }
    },
    style: { ...S.compact({ open: isOpen, ...state }), opacity: resolving ? 0.7 : 1 },
    children: [
      jsx(Photo, { image: mainImage(product), preview, zoom: state.hover && !preview, badges: cardBadges(offers) }),
      jsxs('div', {
        style: S.cardBody,
        children: [
          jsx('div', { style: S.brand, children: brandOf(product) || ' ' }),
          jsx('div', { style: S.title, title: product.title, children: product.title }),
          jsx('div', { style: { paddingTop: '4px' }, children: jsx(PriceLine, { offer: best }) }),
          stores ? jsx('div', { style: S.meta, children: stores }) : null,
          firstOption
            ? jsx('div', {
                style: { paddingTop: '8px' },
                children: jsx(OptionValues, {
                  option: firstOption, selected: selection[firstOption.name], disabled: resolving, onChoose: choose, onPreview: setPreview, limit: MAX_SWATCHES, size: 20,
                }),
              })
            : null,
        ],
      }),
    ],
  })
}

/** A row of compact cards; the clicked card's detail view expands beneath it. */
function ProductRow({ ctx, attrs }) {
  const ids = parseIds(attrs)
  const [state, retry] = useProducts(ids)
  // { rowId, product }: the card it came from, and the variant it was showing.
  const [open, setOpen] = useState(null)

  if (state.status === 'error') return jsx(ErrorNote, { message: state.error, onRetry: ids.length ? retry : null })
  if (state.status === 'loading' && !state.products.length) {
    return jsx('div', { className: NOT_PROSE, style: { ...S.row, margin: '8px 0' }, children: ids.map((id) => jsx(CardSkeleton, {}, id)) })
  }

  const toggle = (rowId) => (product) => setOpen((current) => (current && current.rowId === rowId ? null : { rowId, product }))

  return jsxs('div', {
    className: NOT_PROSE,
    style: S.stack,
    children: [
      jsx('div', {
        style: S.row,
        children: state.products.map((product) =>
          jsx(CompactCard, { initial: product, isOpen: open?.rowId === product.id, onOpen: toggle(product.id) }, product.id),
        ),
      }),
      open ? jsx(DetailView, { ctx, initial: open.product, onClose: () => setOpen(null) }, `${open.rowId}:${open.product.id}`) : null,
    ],
  })
}

function Gallery({ images, preview }) {
  const [active, setActive] = useState(0)
  const count = images.length
  const index = Math.min(active, Math.max(count - 1, 0))
  const step = (delta) => (event) => {
    event.stopPropagation()
    setActive((index + delta + count) % count)
  }

  return jsxs('div', {
    style: S.media,
    children: [
      jsx(Photo, {
        image: images[index] || null,
        preview,
        children:
          count > 1
            ? [
                jsx(Button, { key: 'prev', variant: 'floating', size: 'icon-xs', 'aria-label': 'Previous image', style: S.nav('left'), onClick: step(-1), children: jsx(icons.ChevronLeft, {}) }),
                jsx(Button, { key: 'next', variant: 'floating', size: 'icon-xs', 'aria-label': 'Next image', style: S.nav('right'), onClick: step(1), children: jsx(icons.ChevronRight, {}) }),
                jsx('span', { key: 'count', style: S.counter, children: `${index + 1} / ${count}` }),
              ]
            : null,
      }),
      count > 1
        ? jsx('div', {
            style: S.thumbs,
            children: images.slice(0, 8).map((image, i) => jsx(Thumb, { image, index: i, active: i === index, onSelect: setActive }, image.src)),
          })
        : null,
    ],
  })
}

function Thumb({ image, index, active, onSelect }) {
  const [state, handlers] = useInteractive()
  return jsx('button', {
    type: 'button',
    'aria-label': `Show image ${index + 1}`,
    'aria-current': active,
    ...handlers,
    onClick: () => onSelect(index),
    style: S.thumb({ active, ...state }),
    children: jsx('img', {
      src: image.src, alt: '', draggable: false, loading: 'lazy',
      style: { ...IMG, objectFit: image.cleaned ? 'cover' : 'contain', padding: image.cleaned ? 0 : '4px' },
    }),
  })
}

function BuyButton({ ctx, offer, primary }) {
  const link = buyUrl(offer.url)
  if (!link) return null
  return jsxs(Button, {
    variant: primary ? 'default' : 'outline',
    size: primary ? 'lg' : 'sm',
    title: `Open ${storeName(offer.domain)} in your browser`,
    onClick: (event) => {
      event.stopPropagation()
      openLink(ctx, link)
    },
    children: [primary ? `Buy at ${storeName(offer.domain)}` : 'Buy', jsx(icons.ExternalLink, { 'aria-hidden': true })],
  })
}

function OfferList({ ctx, offers }) {
  return jsx('div', {
    children: offers.map((offer, index) => {
      const inStock = offer.availability === 'InStock'
      return jsxs('div', {
        style: S.offerRow(index === 0),
        children: [
          jsxs('div', {
            style: { minWidth: 0 },
            children: [
              jsx('div', { style: S.offerStore, children: storeName(offer.domain) }),
              jsx('div', { style: S.stock(inStock), children: availabilityLabel(offer) }),
            ],
          }),
          jsxs('div', {
            style: { display: 'flex', alignItems: 'center', gap: '12px', flex: 'none' },
            children: [jsx(PriceLine, { offer }), jsx(BuyButton, { ctx, offer })],
          }),
        ],
      }, `${offer.domain}-${index}`)
    }),
  })
}

function Description({ value }) {
  const [expanded, setExpanded] = useState(false)
  const long = value.length > 240
  return jsxs('div', {
    children: [
      jsx('div', { style: S.description(expanded || !long), children: value }),
      long
        ? jsx(Button, { variant: 'textStrong', size: 'inline', style: { marginTop: '4px' }, onClick: () => setExpanded(!expanded), children: expanded ? 'Show less' : 'Show more' })
        : null,
    ],
  })
}

function DetailView({ ctx, initial, onClose }) {
  const { product, resolving, choose } = useVariantProduct(initial)
  const [preview, setPreview] = useState(null)
  const images = galleryImages(product)
  const offers = sortedOffers(product)
  const best = offers[0]
  const selection = selectionOf(product)
  const options = product.variants?.options || []
  const bullets = features(product)
  const description = text(product.description)
  const others = offers.length > 1 ? offers : []

  return jsxs('div', {
    className: NOT_PROSE,
    'aria-busy': resolving,
    style: { ...S.detail, opacity: resolving ? 0.7 : 1 },
    children: [
      onClose
        ? jsx('div', {
            style: S.close,
            children: jsx(Button, { variant: 'ghost', size: 'icon-xs', 'aria-label': 'Close details', title: 'Close', onClick: onClose, children: jsx(icons.X, {}) }),
          })
        : null,
      jsx(Gallery, { images, preview }, product.id),
      jsxs('div', {
        style: S.body,
        children: [
          jsxs('div', {
            style: S.heading,
            children: [
              brandOf(product) ? jsx('div', { style: S.brand, children: brandOf(product) }) : null,
              jsx('div', { style: S.detailTitle, children: product.title }),
              jsxs('div', {
                style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', paddingTop: '4px' },
                children: [
                  jsx(PriceLine, { offer: best, size: 'lg' }),
                  offers.length > 1 ? jsx('span', { style: S.meta, children: `Lowest of ${offers.length} stores` }) : null,
                ],
              }),
            ],
          }),
          ...options.map((option) =>
            jsxs('div', {
              children: [
                jsxs('div', {
                  style: S.optionLabel,
                  children: [jsx('span', { style: S.optionName, children: option.name }), selection[option.name] ? jsx('span', { style: { marginLeft: '6px' }, children: selection[option.name] }) : null],
                }),
                jsx(OptionValues, { option, selected: selection[option.name], disabled: resolving, onChoose: choose, onPreview: setPreview, size: 30 }),
              ],
            }, option.name),
          ),
          best
            ? jsxs('div', {
                style: S.cta,
                children: [
                  jsx(BuyButton, { ctx, offer: best, primary: true }),
                  jsx('span', { style: S.stock(best.availability === 'InStock'), children: availabilityLabel(best) }),
                ],
              })
            : jsx('div', { style: S.meta, children: 'No stores currently list this product.' }),
          bullets.length
            ? jsx('ul', { style: S.bullets, children: bullets.map((item) => jsx('li', { children: item }, item)) })
            : null,
          description ? jsx(Description, { value: description }, product.id) : null,
          others.length
            ? jsxs('div', { children: [jsx('div', { style: S.section, children: `Compare ${others.length} stores` }), jsx(OfferList, { ctx, offers: others })] })
            : null,
        ],
      }),
    ],
  })
}

function ProductDetail({ ctx, attrs }) {
  const ids = parseIds(attrs).slice(0, 1)
  const [state, retry] = useProducts(ids)

  if (state.status === 'error') return jsx(ErrorNote, { message: state.error, onRetry: ids.length ? retry : null })
  if (!state.products.length) return jsx('div', { style: { margin: '8px 0' }, children: jsx(DetailSkeleton, {}) })
  return jsx('div', { style: { margin: '8px 0' }, children: jsx(DetailView, { ctx, initial: state.products[0] }) })
}

// ---------------------------------------------------------------------------

export default {
  id: 'channel3',
  name: 'Channel3',
  register(ctx) {
    ctx.onDispose(() => {
      productCache.clear()
      unavailable.clear()
    })
    ctx.register({
      id: 'products-row',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: {
        name: 'channel3-products',
        render: ({ attrs }) => jsx(ProductRow, { ctx, attrs: attrs || {} }),
      },
    })
    ctx.register({
      id: 'product-detail',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: {
        name: 'channel3-product',
        render: ({ attrs }) => jsx(ProductDetail, { ctx, attrs: attrs || {} }),
      },
    })
  },
}
