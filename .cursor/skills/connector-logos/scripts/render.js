// node render.js <outDir> <sheet.png> <svg>...  (needs puppeteer-core@23.11.1 and Google Chrome)
// Renders each SVG at 64/128/256 on light and dark, plus one contact sheet.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

(async () => {
  const [outDir, sheet, ...files] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--allow-file-access-from-files"],
  });
  const page = await browser.newPage();
  const bgs = { light: "#ffffff", dark: "#111318" };
  for (const f of files) {
    const name = path.basename(f, ".svg");
    const data = "data:image/svg+xml;base64," + fs.readFileSync(f).toString("base64");
    for (const size of [64, 128, 256]) {
      for (const [k, bg] of Object.entries(bgs)) {
        await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: k }]);
        await page.setContent(
          `<html><body style="margin:0;background:${bg}"><img src="${data}" style="width:${size}px;height:${size}px;display:block;object-fit:contain"></body></html>`,
        );
        await page.waitForFunction(() => document.images[0].complete);
        await page.screenshot({ path: path.join(outDir, `${name}__${size}__${k}.png`) });
      }
    }
  }
  // Contact sheet: each icon at 96 px on light and dark, with a 1px bbox outline of the img box.
  const cells = files
    .map(f => {
      const data = "data:image/svg+xml;base64," + fs.readFileSync(f).toString("base64");
      const n = path.basename(f, ".svg");
      return `<div class=c><div class=row><div class=l><img src="${data}"></div><div class=d><img src="${data}"></div><div class=s><img src="${data}"></div></div><div class=t>${n}</div></div>`;
    })
    .join("");
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.setViewport({ width: 1400, height: 800 });
  await page.setContent(`<html><head><style>
    body{margin:8px;font:11px sans-serif;display:flex;flex-wrap:wrap;gap:8px;background:#ddd}
    .c{width:330px}.row{display:flex;gap:4px;align-items:center}
    .l,.d{width:96px;height:96px;outline:1px dashed #f0a}.l{background:#fff}.d{background:#111318}
    .s{width:24px;height:24px;background:#fff;outline:1px dashed #f0a}
    img{width:100%;height:100%;object-fit:contain;display:block}.t{word-break:break-all}
  </style></head><body>${cells}</body></html>`);
  await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
  await page.screenshot({ path: sheet, fullPage: true });
  await browser.close();
})();
