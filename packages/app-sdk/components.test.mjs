// @makoai/app-sdk/components (2.21): stock shadcn, one copy per component.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const dir = new URL("./components/", import.meta.url);
const files = readdirSync(dir).filter(f => f.endsWith(".tsx"));

test("components: the registry's new-york-v4 files (plus the house filter bar and period picker); changes are the cn import and marked thin props", () => {
  assert.deepEqual(files.sort(), ["alert.tsx", "avatar.tsx", "badge.tsx", "button.tsx", "calendar.tsx", "card.tsx", "collapsible.tsx", "combobox.tsx", "command.tsx", "dialog.tsx", "filter-bar.tsx", "input.tsx", "label.tsx", "period-picker.tsx", "popover.tsx", "progress.tsx", "select.tsx", "separator.tsx", "sheet.tsx", "skeleton.tsx", "slider.tsx", "switch.tsx", "table.tsx", "tabs.tsx", "toggle-group.tsx", "toggle.tsx", "tooltip.tsx"]);
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), "utf8");
    if (/\bcn\(/.test(src)) assert.match(src, /import \{ cn \} from "\.\.\/menu\/utils"/, `${f} imports the one cn`);
    assert.doesNotMatch(src, /@\/|from "cn"/, `${f} has no app or registry alias left`);
    assert.match(src, /data-slot=/, `${f} is a v4 component (data-slot)`);
  }
});

test("components: DropdownMenu and Checkbox have one copy, in menu/", () => {
  assert.ok(!existsSync(new URL("dropdown-menu.tsx", dir)));
  assert.ok(!existsSync(new URL("checkbox.tsx", dir)));
  const index = readFileSync(new URL("index.ts", dir), "utf8");
  assert.match(index, /export \* from "\.\.\/menu\/dropdown-menu"/);
  assert.match(index, /export \{ Checkbox \} from "\.\.\/menu\/checkbox"/);
  for (const f of files.filter(f => !["calendar.tsx", "combobox.tsx", "command.tsx"].includes(f))) {
    assert.match(index, new RegExp(`export \\* from "\\./${f.replace(".tsx", "")}"`), `index exports ${f}`);
  }
});

test("tailwind.css sources both folders and maps the house tokens", () => {
  const css = readFileSync(new URL("./tailwind.css", import.meta.url), "utf8");
  assert.match(css, /@source "\.\/components";/);
  assert.match(css, /@source "\.\/menu";/);
  for (const token of ["background", "popover", "muted-foreground", "accent", "brand", "chart-1"]) {
    assert.ok(css.includes(`--color-${token}: var(--${token});`), `maps --${token}`);
  }
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(pkg.exports["./tailwind.css"], "./tailwind.css");
  assert.equal(pkg.exports["./components"].default, "./components/index.ts");
  for (const f of ["components/", "menu/", "tailwind.css"]) assert.ok(pkg.files.includes(f), `ships ${f}`);
  assert.equal(pkg.peerDependenciesMeta["class-variance-authority"]?.optional, true);
});

test("components: thin props are marked, and stock behaviour stays the default", () => {
  const sheet = readFileSync(new URL("sheet.tsx", dir), "utf8");
  assert.match(sheet, /closeLabel = "Close"/);
  assert.match(sheet, /<span className="sr-only">\{closeLabel\}<\/span>/);
  const select = readFileSync(new URL("select.tsx", dir), "utf8");
  assert.match(select, /<SelectPrimitive\.Portal container=\{container\}>/);
  assert.match(select, /position = "item-aligned"/);
  const badge = readFileSync(new URL("badge.tsx", dir), "utf8");
  assert.match(badge, /variant = "default"/, "Badge stays stock by default");
  for (const tone of ["success", "warning", "danger", "info", "violet", "muted"]) assert.match(badge, new RegExp(`\\n {8}${tone}: "`), `Badge tone ${tone}`);
  assert.doesNotMatch(badge, /(green|amber|red|blue|violet)-\d00/, "tones use the house tokens, never the Tailwind palette");
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const line of src.split("\n").filter(l => /Mako thin prop/.test(l))) {
      assert.match(line, /\(2\.\d+\)/, `${f}: a thin prop names the SDK version that added it`);
    }
  }
});

test("components: Calendar and Command ship on their own subpaths, outside the barrel", () => {
  const index = readFileSync(new URL("index.ts", dir), "utf8");
  assert.doesNotMatch(index, /"\.\/calendar"|"\.\/command"/, "the barrel never loads react-day-picker or cmdk");
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(pkg.exports["./components/calendar"].default, "./components/calendar.tsx");
  assert.equal(pkg.exports["./components/command"].default, "./components/command.tsx");
  for (const dep of ["react-day-picker", "cmdk"]) assert.equal(pkg.peerDependenciesMeta[dep]?.optional, true);
});

