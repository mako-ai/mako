---
name: web
description: Load when the user shares a URL, asks to read a webpage or document, search the web for current information, or process online files (HTML, PDF, CSV, JSON).
entities:
  - url
  - link
  - webpage
  - website
  - article
  - pdf
  - fetch
  - search
  - scrape
  - docs
---

Use web tools to gather information from public URLs on the internet.

## Tools

- **`web_search`** — discover current information. Returns `{ title, url, snippet }[]`. Use when you need to find pages, not when the user already pasted a URL.
- **`fetch_url`** — read a specific URL in full. Handles HTML, PDF, CSV, JSON, and plain text. Does **not** execute JavaScript.

## Workflow

1. User pastes a URL → call `fetch_url` directly.
2. User asks an open-ended question needing fresh web context → `web_search`, then `fetch_url` on the best 1–2 results.
3. Summarize from tool output; cite the source URL.

## Limits

- Public `http`/`https` URLs only — no authenticated pages, no internal networks.
- Static fetch only — client-rendered SPAs may return incomplete content.
- Default content cap is 20k characters; increase `max_chars` only when necessary.
