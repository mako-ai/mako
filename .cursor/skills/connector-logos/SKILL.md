---
name: connector-logos
description: >-
  Give a connector its real vendor logo: find the official file, sanitise it, normalise it to the
  icon convention, render and compare it, and ship it after a human review. Load before adding,
  replacing or reviewing any connector icon.svg, MCP preset icon or database driver icon, in
  mako-ai/mako or in a workspace repo's connectors/ folder.
---

# Connector logos

On 18 Nov 2026 an audit found 23 invented logos across 68 icon slots in mako-ai/mako and one customer workspace.
Slack showed a checklist, Meta a hand-drawn infinity, Cloudflare a made-up cloud. PandaDoc had a plain "P".
The workspace owner approved 23 replacements and 3 new icons, every one from a fetched vendor file.
This skill is that method. Every future connector icon follows it.

## Hard rules

1. Never draw a logo from memory. Never hand-write a `<path>` for a brand mark. Every path comes from a file you fetched.
2. Record the source URL of every logo, in the PR body and in the review manifest.
3. Treat every download as untrusted. Save it into its own empty folder. Run Python on it with `python3 -I`.
4. A human reviews a before/after page before anything merges.
5. Keep an icon that already matches the vendor's current mark. Write down the evidence ("same rings and colours as close.com's apple-touch-icon").

## Where icons live

mako-ai/mako:
- `api/src/connectors/<type>/icon.svg` for the built-in types, served by `api/src/routes/connectors.ts`.
- `connectors/<slug>/icon.svg` for the registry folders. Keep it byte-identical to the `api/src` copy.
- `api/src/mcp/icons/<preset>.svg` for MCP presets, served by `api/src/routes/mcp/presets.ts`.
- `api/src/databases/drivers/<type>/icon.svg` for database drivers, served by `api/src/routes/database-schemas.ts`.
- The branch `chore/remove-builtin-connectors` moves the built-in icons to `api/src/connectors/twins/icons/<type>.svg`. Check `git ls-tree origin/master` for which layout is live.

A workspace repo:
- `connectors/<slug>/icon.svg`. Mako finds it by file name. `connector.yaml` has no icon field.
- No file means Mako draws a letter monogram (`monogramSvg` in `api/src/routes/connectors.ts`).
- The route `GET /api/connectors/ws:<slug>/icon.svg?workspaceId=…` serves it with CSP `default-src 'none'; style-src 'unsafe-inline'; sandbox`. Inline `<style>` works there. Scripts never run.

A Mako connection has no icon of its own.
Icons resolve per connector type.
Every `custom_api` connection shows the generic globe. A Customer.io, SendGrid or Probo connection set up as `custom_api` gets no brand logo.
A brand logo for one of them needs a per-connection icon field in mako first.
A connector that reads several vendors, or only internal systems, keeps the monogram.

## 1. Find the official file

Search in this order and stop at the first hit:

1. The vendor's brand or press kit page ("<vendor> brand assets", "<vendor> press kit").
2. The vendor's own site: the header logo SVG in the HTML, `favicon.svg`, `apple-touch-icon`, the web manifest icons.
3. Simple Icons at a pinned version: `https://cdn.jsdelivr.net/npm/simple-icons@16.36.0/icons/<slug>.svg`. These are one-colour marks. Take the colour from the vendor's site.
4. Wikimedia Commons files credited to the vendor. Check the credit with `commons.wikimedia.org/w/api.php?action=query&titles=File:<name>&prop=imageinfo&iiprop=extmetadata&format=json`.
5. Another reputable set at a pinned version, e.g. `@iconify-json/logos@1.2.19` (gilbarbara/logos).

A site that answers 429 or 403 to curl often loads in headless Chrome. Save the rendered HTML and pull the logo URLs from it.
A vendor that rebranded wins over the logo you remember. On 18 Nov 2026 Stripe (white parallelogram on `#533AFD`), Calendly (C on a blue squircle) and Claap (new pink tile) all differed from the old icons.

Sources that worked:

| Vendor | Source |
| --- | --- |
| Stripe | `images.stripeassets.com/…/favicon.svg` (logo kit uses `#533AFD`) |
| Calendly | `calendly.com/media/favicon/icon.svg` |
| Claap | `claap.io/brand/claap-icon.svg` |
| PandaDoc | header logo from `pandadoc.com/press`, box and "pd" symbol only |
| PostHog | posthog.com header logomark, light and white dark variants |
| Slack | `a.slack-edge.com/…/marketing/img/nav/logo.svg` |
| Cloudflare | `cloudflare.com/logo.svg` |
| GitHub | `github.githubassets.com/favicons/favicon.svg` |
| Google Admin | `gstatic.com/images/branding/productlogos/admin_2020q4/v6/192px.svg` |
| Intercom | intercom.com header mark |
| Meta | Commons `Meta_Platforms_Inc._logo_(cropped).svg` |
| Bing | Commons `Bing_Fluent_Logo.svg` (matches the Bing Webmaster app icon) |

## 2. Sanitise

```sh
python3 -I .cursor/skills/connector-logos/scripts/sanitize.py raw/<slug>/logo.svg stage/<slug>.svg
```

The script removes `<script>`, `<foreignObject>`, `<image>`, `<a>`, the animation elements (`<set>`, `<animate>` and kin) and every `on*` attribute.
It also removes any `href` or `url()` that points outside the file, in any letter case, plus foreign-namespace attributes. It keeps `class`, so `<style>` rules still apply.
It drops the root `width` and `height`, and derives a `viewBox` from them when one is missing.
Reject any file that still needs an embedded raster to look right.

## 3. Normalise to the convention

- Square `viewBox`. No `width` or `height`.
- An app-tile mark keeps its full-bleed tile. Stripe, Wise, Vercel, Claap, PandaDoc and Calendly are tiles.
- A bare mark is centred with 4% padding on each side. Slack, Meta, Bing, Cloudflare, Close and GraphQL are bare marks.
- Take the symbol and drop the wordmark.
- Use the vendor's colours.
- Put a black mark on a dark tile so it stays visible on dark pages. GitHub uses `#24292f`, Vercel and Intercom use black.
- A vendor that ships a separate dark-mode logo gets both, switched by `@media (prefers-color-scheme: dark)`. PostHog and OpenAI do this. ThemeContext sets `color-scheme` on `<html>`, so the switch follows the app theme in an `<img>`.
- Keep the file under 8 KB. The 26 icons shipped on 18 Nov are all under 4.2 KB.
- A sub-connector of one vendor reuses that vendor's icon file. close-meetings and close-tasks copy `connectors/close/icon.svg`.

Wrapping fetched paths in a tile `<rect>` or a `<g transform>` is fine. Editing the paths is not.

```sh
mkdir -p "$SCRATCH/logo-tools" && cd "$SCRATCH/logo-tools"
npm init -y >/dev/null && npm i puppeteer-core@23.11.1 svgo@3.3.2
export NODE_PATH="$SCRATCH/logo-tools/node_modules"
cd -
node .cursor/skills/connector-logos/scripts/normalize.js stage/ norm/ stripe:tile slack:mark meta:mark
```

`normalize.js` measures the real bounding box in Chrome with `getBBox()`.
It sets the square `viewBox`, then runs svgo with `multipass`, `floatPrecision: 3`, `removeViewBox: false` and `removeDimensions`.
`NODE_PATH` lets the scripts find the two pinned packages without installing them in the repo.

## 4. Render and look

```sh
node .cursor/skills/connector-logos/scripts/render.js png/after png/sheet_after.png norm/*.svg
node .cursor/skills/connector-logos/scripts/render.js png/before png/sheet_before.png before/*.svg
```

The script renders every icon at 64, 128 and 256 px on white and on `#111318`, with dark mode emulated on the dark render.
It also writes a contact sheet with each icon's box outlined.
It uses the installed Chrome at `/Applications/Google Chrome.app`.

Open the PNGs with the Read tool and check each one:
- It matches the vendor's own rendering: the source file, the favicon or a screenshot of the brand page.
- Nothing is clipped and no margin is oversized.
- It stays visible on dark. A black mark that disappears goes on a tile.
- It still reads at 64 px.

## 5. Review, then ship

1. Copy every old file to `before/` and every proposal to `after/`.
2. Write a manifest with one entry per icon slot. Each entry has repo, connector, file path, status (`kept`, `replaced`, `added` or `unresolved`), source URL and source kind. Add the `viewBox`, the bytes before and after, a note, and the 128 px light and dark PNGs.
3. Build a before/after page from the manifest and send it to the owner for review.
4. After approval, open the PR. Its body lists the counts and every replaced logo with its source URL.
