---
name: channel3-shopping
description: "Shop with the channel3 MCP tools (search_products, get_products). Load this skill before shopping. Show products as cards, never as tables: a paragraph containing only ::channel3-products{ids=\"id1,id2\"} or ::channel3-product{id=\"id1\"}."
license: MIT
metadata:
  tags: "shopping, products, ecommerce, price-comparison, mcp"
  homepage: "https://trychannel3.com"
---

# Channel3 shopping

Channel3 indexes 100M+ products across thousands of US retailers, with live
prices and offers from every store that sells each product.

## Prerequisite

The tools come from the `channel3` MCP server bundled in this plugin. No
account or API key is needed; the free tier is rate-limited. Install and
enable the plugin, then start a new session so the tools load.

## Tools

Use these two:

- `search_products(query, image_url?)`: one product type per call, with the
  user's constraints in `query` ("red leather jacket under $200", not
  "gift ideas"). Send independent searches for different product types
  together. Returns up to 8 products with their ids.
- `get_products(product_ids)`: full details for up to 40 ids: description,
  attributes, every store's offer, and variant options (color, size, ...).

The server also lists `browse_products`, `get_details`, `get_similar` and
`get_price_history`. Those exist for the product cards; do not call them.

Every result carries a `thread_id`. Pass it back unchanged on every later
Channel3 call in the conversation, including searches for something else.

## Show results as cards

In Hermes Desktop this plugin renders product cards that load images, prices
and offers themselves and let the user switch variants (color, size) in
place. Show products by writing a directive with their ids, never by pasting
image links, prices or store URLs yourself:

```
::channel3-products{ids="LZeQAgT,RsMjV5x,AybWRtH"}
```

```
::channel3-product{id="LZeQAgT"}
```

- `channel3-products` is a row of compact cards: use it to present search
  results. Pick the 3 to 6 best matches, best first.
- `channel3-product` is one detailed card with every store's offer: use it
  when the user focuses on a single product or asks where to buy it.
- The directive must be its own paragraph, on one line, with nothing else in
  that paragraph. Ids are copied exactly from the tool results.
- Put your reasoning in prose around the cards (why these picks, trade-offs,
  which is the best value), not a list that repeats what the cards show.
- Outside Hermes Desktop the directive shows as plain text, so after a row of
  cards add one short line naming the picks and their prices.

## Do not invent

Only recommend products a tool returned, with the prices the tool returned.
If a search comes back thin, say so and search again with a broader or
rephrased query rather than filling the gap from memory.

## Rate limit

If a tool reports the free-tier rate limit, tell the user, and mention that a
Channel3 API key from https://trychannel3.com removes the limit.
