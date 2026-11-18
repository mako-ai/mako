import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { lintApp, SDK_COMPONENTS } from "./lint.js";

function app(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "mako-lint-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test("utc-display flags getUTC*, timeZone UTC and toISOString().slice; the ignore comment and tests pass", () => {
  const dir = app({
    "src/a.tsx": [
      "const h = d.getUTCHours();",
      'const f = new Intl.DateTimeFormat("en", { timeZone: "UTC" });',
      "const k = d.toISOString().slice(0, 10);",
      "const ok = formatTime(d);",
      "const key = d.toISOString().slice(0, 7); // mako-lint-ignore utc-display",
    ].join("\n"),
    "src/a.test.ts": "d.getUTCDate()",
  });
  const f = lintApp(dir);
  assert.deepEqual(f.map(x => `${x.file}:${x.line}:${x.rule}`), ["src/a.tsx:1:utc-display", "src/a.tsx:2:utc-display", "src/a.tsx:3:utc-display"]);
});

test("local-shadcn flags a copy of a component the SDK ships, not one it lacks", () => {
  const dir = app({ "src/components/ui/button.tsx": "x", "src/components/ui/dropdown-menu.tsx": "x", "src/components/ui/calendar.tsx": "x" });
  const f = lintApp(dir).map(x => `${x.file} ${x.message}`);
  assert.equal(f.length, 2);
  assert.match(f.find(x => x.includes("button")), /@makoai\/app-sdk\/components/);
  assert.match(f.find(x => x.includes("dropdown-menu")), /@makoai\/app-sdk\/menu/);
});

test("the rule's component list matches what /components and /menu ship", () => {
  const index = readFileSync(new URL("./components/index.ts", import.meta.url), "utf8");
  for (const name of SDK_COMPONENTS) {
    const inComponents = index.includes(`"./${name}"`);
    const inMenu = index.includes(`"../menu/${name}"`);
    assert.ok(inComponents || inMenu, `${name} is shipped`);
  }
});

test("the CLI exits 1 on findings and 0 with --warn", () => {
  const dir = app({ "src/a.ts": "d.getUTCDay()" });
  const bin = new URL("./lint.js", import.meta.url).pathname;
  assert.throws(() => execFileSync(process.execPath, [bin, dir], { stdio: "pipe" }));
  const out = execFileSync(process.execPath, [bin, dir, "--warn"], { encoding: "utf8" });
  assert.match(out, /utc-display/);
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(pkg.bin["mako-app-lint"], "./lint.js");
  assert.ok(pkg.files.includes("lint.js"));
});

test("the CLI runs through a symlinked bin, as npm and pnpm install it", () => {
  const dir = app({ "src/a.ts": "d.getUTCDay()" });
  const link = path.join(mkdtempSync(path.join(tmpdir(), "lint-bin-")), "mako-app-lint");
  symlinkSync(new URL("./lint.js", import.meta.url).pathname, link);
  const out = execFileSync(process.execPath, [link, dir, "--warn"], { encoding: "utf8" });
  assert.match(out, /utc-display/);
  assert.throws(() => execFileSync(process.execPath, [link, dir], { stdio: "pipe" }));
});
