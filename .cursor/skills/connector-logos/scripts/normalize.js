// node normalize.js <inDir> <outDir> name:mode ...  (needs puppeteer-core@23.11.1, svgo@3.3.2, Google Chrome)
// mode "tile": keep the drawing's own square viewBox (full-bleed app tile).
// mode "mark": square viewBox around the measured bbox, 4% padding each side.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const { optimize } = require("svgo");

(async () => {
  const [inDir, outDir, ...specs] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage();
  for (const spec of specs) {
    const [name, mode] = spec.split(":");
    let svg = fs.readFileSync(path.join(inDir, name + ".svg"), "utf8");
    await page.setContent(`<html><body>${svg}</body></html>`);
    const box = await page.evaluate(() => {
      const s = document.querySelector("svg");
      const b = s.getBBox();
      return { x: b.x, y: b.y, w: b.width, h: b.height, vb: s.getAttribute("viewBox") };
    });
    let vb;
    if (mode === "tile") {
      vb = box.vb;
    } else {
      const side = Math.max(box.w, box.h) * 1.08;
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const r = n => Math.round(n * 1000) / 1000;
      vb = `${r(cx - side / 2)} ${r(cy - side / 2)} ${r(side)} ${r(side)}`;
    }
    svg = svg.replace(/<svg\b([^>]*?)\sviewBox="[^"]*"/, `<svg$1 viewBox="${vb}"`);
    if (!/<svg\b[^>]*viewBox=/.test(svg)) svg = svg.replace("<svg", `<svg viewBox="${vb}"`);
    const out = optimize(svg, {
      multipass: true,
      floatPrecision: 3,
      plugins: [
        { name: "preset-default", params: { overrides: { removeViewBox: false, inlineStyles: false, minifyStyles: false } } },
        "removeDimensions",
      ],
    }).data;
    fs.writeFileSync(path.join(outDir, name + ".svg"), out);
    console.log(name, mode, "bbox", JSON.stringify(box), "->", vb, out.length, "bytes");
  }
  await browser.close();
})();
