# App thumbnails: posters, not screenshots

Read this when creating an app, when asked for a thumbnail, poster, cover or
link-preview image, or when an app still shows the starter placeholder.

Every app ships its own poster. Mako never screenshots apps: the card on the
Apps home **and** the link preview of a public share (Slack, WhatsApp,
LinkedIn, iMessage, Teams, X) both show what the builder put in the app
folder. A good poster is why people click — treat it like a YouTube
thumbnail, not a screenshot. A workspace can add its own flavour (brand or
market colours, reference apps to study) in a workspace skill; this is the
generic part.

## Files

- `thumbnail.source.svg` — the editable source, at the app's root. This name
  is never picked up, so it may use any fonts and emoji.
- `thumbnail.png` — the rendered poster, **1200×750**, ideally under ~300 KB.
  Mako uses the first of `thumbnail.png`, `.webp`, `.jpg`, `.jpeg`, `.svg`;
  ship the PNG, because link previews ignore SVG. Delete the starter
  `thumbnail.svg` once the PNG exists.
- Keep everything that matters inside the **centred 1200×630 safe area**
  (y 60…690): link previews crop to 1.91:1.

## The recipe

1. **Understand the app first**: `mako.json` (title, description), `src/`
   (tabs and sections — real names make great chips), `bindings/*.sql`.
2. **Headline = the question the app answers**, as a hook, 1–2 lines, huge:
   "WHO'S WINNING?", "WILL THEY RENEW?", "WHERE DO DEALS LEAK?". Use the
   team's language when the app is single-market.
3. **One motif of what the app shows**, stylised: a leaderboard, cohort
   triangle, funnel, gauge, radar, calendar, map, a mixing desk of sliders.
4. **One or two highlight devices**: a tilted highlighter bar behind a word,
   a hand-drawn circle on the key element, an arrow, a starburst sticker, a
   handwritten callout.
5. **Chips** with the app's real section names, and a small pill with the
   app's title.
6. **High contrast, bold type** (heavy sans, Impact-style, outlined or on a
   block) on a **strong background**: saturated colour, dark gradient, or
   cream with halftone or grid.

Check the 300px preview: the headline must read at card size. Iterate twice,
not ten times.

## Rules

- **No numbers presented as real data**: no figures, currency, axis values,
  customer or employee names — stylised shapes only. Bars and rankings imply
  an order; keep them neutral unless the order is true.
- **Every poster distinct**: vary layout (visual left / right / bottom),
  palette, headline device and motif — never a template with new words.
- It must work on light and dark cards: a self-contained background does.
- Commit only `thumbnail.png` and `thumbnail.source.svg`; the card and the
  link preview update with the next commit on `main`.

## Rendering the PNG

Use headless Chrome. In the app sandbox, run `app_browse` once first: it
installs the box's `chrome-headless-shell`, its system libraries and
`puppeteer-core` under `/tmp/mako-eyes` (cached until the box is recycled).
On a laptop, Google Chrome is used. Save this as `/tmp/render-thumbnail.mjs`
(outside the repo) and run `node /tmp/render-thumbnail.mjs <app folder>`:

```js
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const dir = path.resolve(process.argv[2] ?? ".");
const svg = readFileSync(path.join(dir, "thumbnail.source.svg"), "utf8");
const eyes = "/tmp/mako-eyes";
function chrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  const root = `${eyes}/browsers/chrome-headless-shell`;
  for (const v of existsSync(root) ? readdirSync(root) : []) {
    const p = `${root}/${v}/chrome-headless-shell-linux64/chrome-headless-shell`;
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome: run app_browse once (sandbox) or set CHROME_PATH");
}
const req = createRequire(existsSync(`${eyes}/node_modules`) ? `${eyes}/x.js` : `${process.cwd()}/x.js`);
const { default: puppeteer } = await import(req.resolve("puppeteer-core"));
const browser = await puppeteer.launch({ executablePath: chrome(), args: ["--no-sandbox", "--hide-scrollbars"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 750 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}svg{display:block;width:1200px;height:750px}</style>${svg}`);
  await page.evaluate(() => document.fonts.ready);
  const full = { x: 0, y: 0, width: 1200, height: 750 };
  await page.screenshot({ path: path.join(dir, "thumbnail.png"), clip: full });
  await page.screenshot({ path: "/tmp/og-preview.png", clip: { x: 0, y: 60, width: 1200, height: 630 } });
  await page.setViewport({ width: 1200, height: 750, deviceScaleFactor: 0.25 });
  await page.screenshot({ path: "/tmp/small-preview.png", clip: full });
} finally {
  await browser.close();
}
```

It writes `thumbnail.png` into the app folder, plus two review files in
`/tmp` that are never committed: `og-preview.png` (the link-preview crop)
and `small-preview.png` (300px wide, card size). Look at both before you
commit.
