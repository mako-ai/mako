import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { lintApp, minMajor, SDK_COMPONENTS, SDK_SUBPATH_COMPONENTS } from "./lint.js";

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
  const dir = app({ "src/components/ui/button.tsx": "x", "src/components/ui/dropdown-menu.tsx": "x", "src/components/ui/chart.tsx": "x" });
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
    const onSubpath = SDK_SUBPATH_COMPONENTS.includes(name) && existsSync(new URL(`./components/${name}.tsx`, import.meta.url));
    assert.ok(inComponents || inMenu || onSubpath, `${name} is shipped`);
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

test("react-version flags React below 19 only when the app uses shadcn", () => {
  const pkg = (react, extra = {}) => JSON.stringify({ dependencies: { react, ...extra } });
  const shadcn18 = app({ "package.json": pkg("^18.2.0"), "src/components/ui/calendar.tsx": "x", "src/a.tsx": "" });
  assert.deepEqual(lintApp(shadcn18, ["react-version"]).map(f => f.rule), ["react-version"]);
  const sdk18 = app({ "package.json": pkg("^18.3.1"), "src/a.tsx": 'import { Button } from "@makoai/app-sdk/components";' });
  assert.match(lintApp(sdk18, ["react-version"])[0].message, /@makoai\/app-sdk\/components or \/menu/);
  const radix18 = app({ "package.json": pkg("^18.2.0", { "radix-ui": "^1.8.1" }), "src/a.tsx": "" });
  assert.equal(lintApp(radix18, ["react-version"]).length, 1);
  const plain18 = app({ "package.json": pkg("^18.2.0"), "src/a.tsx": 'import { MultiSelect } from "@makoai/app-sdk/ui";' });
  assert.equal(lintApp(plain18, ["react-version"]).length, 0, "the kit /ui handles refs on React 18");
  const shadcn19 = app({ "package.json": pkg("^19.3.1"), "src/components/ui/button.tsx": "x" });
  assert.equal(lintApp(shadcn19, ["react-version"]).length, 0);
  assert.equal(minMajor(">=19.0.0"), 19);
  assert.equal(minMajor(undefined), null);
});

test("react-version flags React 19 with recharts 2 until react-is 19 is pinned", () => {
  const pkg = extra => JSON.stringify({ dependencies: { react: "^19.3.1", recharts: "^2.15.4" }, ...extra });
  const bare = app({ "package.json": pkg({}), "src/a.tsx": "" });
  assert.match(lintApp(bare, ["react-version"])[0].message, /react-is/);
  const pinned = app({ "package.json": pkg({ pnpm: { overrides: { "react-is": "^19.1.10" } } }), "src/a.tsx": "" });
  assert.equal(lintApp(pinned, ["react-version"]).length, 0);
  const npmPinned = app({ "package.json": pkg({ overrides: { "react-is": "^19.0.0" } }), "src/a.tsx": "" });
  assert.equal(lintApp(npmPinned, ["react-version"]).length, 0);
  const pin18 = app({ "package.json": pkg({ pnpm: { overrides: { "react-is": "^18.3.1" } } }), "src/a.tsx": "" });
  assert.equal(lintApp(pin18, ["react-version"]).length, 1);
  const recharts3 = app({ "package.json": JSON.stringify({ dependencies: { react: "^19.3.1", recharts: "^3.2.0" } }), "src/a.tsx": "" });
  assert.equal(lintApp(recharts3, ["react-version"]).length, 0, "recharts 3 reads children without react-is 18");
  const react18 = app({ "package.json": JSON.stringify({ dependencies: { react: "^18.2.0", recharts: "^2.15.4" } }), "src/a.tsx": "" });
  assert.equal(lintApp(react18, ["react-version"]).length, 0, "react-is 18 matches React 18");
});

test("--rules runs only the named rules; Calendar and Command point at their subpaths", () => {
  const dir = app({ "package.json": JSON.stringify({ dependencies: { react: "^18.2.0" } }), "src/components/ui/calendar.tsx": "x", "src/a.ts": "d.getUTCDay()" });
  assert.deepEqual([...new Set(lintApp(dir).map(f => f.rule))].sort(), ["local-shadcn", "react-version", "utc-display"]);
  assert.deepEqual(lintApp(dir, ["local-shadcn"]).map(f => f.rule), ["local-shadcn"]);
  assert.match(lintApp(dir, ["local-shadcn"])[0].message, /@makoai\/app-sdk\/components\/calendar/);
  const bin = new URL("./lint.js", import.meta.url).pathname;
  const out = execFileSync(process.execPath, [bin, dir, "--rules=react-version", "--warn"], { encoding: "utf8" });
  assert.match(out, /react-version/);
  assert.doesNotMatch(out, /utc-display|local-shadcn/);
});

