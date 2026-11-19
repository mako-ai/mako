// The fixtures behind locale-baseline-2.28.json: PeriodPicker, FilterBar,
// MultiSelect, FilterMenu and Combobox, closed and open, rendered in jsdom by
// SDK 2.28.0 before `locale`, `labels` and `presets` existed. The 2.29 test
// renders them again with the new props unset and expects the same bytes.
// Every value is a fixed past date, so the output never depends on today.
// Regenerate only on purpose, from a 2.28.0 copy of the package:
//   node test-support/locale-baseline-2.28.mjs <path to 2.28.0 app-sdk> > test-support/locale-baseline-2.28.json
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HERE = new URL("../", import.meta.url);

/** Sets up jsdom globals, then bundles `root`'s components, menu and ui.js. Returns the modules. */
export async function loadKit(root, { JSDOM, esbuild }) {
  const dom = new JSDOM("<!doctype html><body><div id=root></div></body>", { pretendToBeVisual: true });
  const win = dom.window;
  const keys = [
    "window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement",
    "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent", "Event", "CustomEvent", "DocumentFragment",
    "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver", "NodeFilter",
  ];
  const saved = keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  for (const k of keys) {
    const value = k === "window" ? win : k === "PointerEvent" ? (win.PointerEvent ?? win.MouseEvent) : win[k];
    Object.defineProperty(globalThis, k, { value: typeof value === "function" && /^[a-z]/.test(k) ? value.bind(win) : value, configurable: true, writable: true });
  }
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  globalThis.ResizeObserver = win.ResizeObserver = ResizeObserver;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.HTMLElement.prototype.hasPointerCapture = () => false;
  win.HTMLElement.prototype.releasePointerCapture = () => {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const restore = () => {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
    delete globalThis.ResizeObserver;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  };
  await import("radix-ui"); // after the DOM globals: radix picks its layout effect on load
  const entry = `export * from ${JSON.stringify(new URL("components/index.ts", root).pathname)};
export { FilterMenu, FilterMenuItems } from ${JSON.stringify(new URL("menu/index.ts", root).pathname)};
export { Combobox } from ${JSON.stringify(new URL("components/combobox.tsx", root).pathname)};
export { MultiSelect } from ${JSON.stringify(new URL("ui.js", root).pathname)};`;
  const out = await esbuild.build({
    stdin: { contents: entry, resolveDir: new URL(".", root).pathname, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    write: false,
    external: ["react", "react-dom", "react-dom/*", "react/jsx-runtime", "radix-ui", "lucide-react", "clsx", "tailwind-merge", "cmdk", "class-variance-authority"],
  });
  const outdir = new URL("node_modules/.cache/locale-baseline/", HERE);
  mkdirSync(outdir, { recursive: true });
  const file = new URL(`kit-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`, outdir);
  writeFileSync(file, out.outputFiles[0].text);
  return { kit: await import(file.href), win, restore };
}

const OPTS = [
  { value: "ch", label: "Switzerland", color: "#dc2626", count: 1234 },
  { value: "fr", label: "France", count: 56 },
  "ES",
];
const TREE = [
  { value: "humans", label: "Humans" },
  { value: "bots", label: "Bots", children: [{ value: "gptbot", label: "GPTBot" }, { value: "bing", label: "Bingbot" }] },
];

/** name → { el: (kit, h, extra) => element, open?: (q) => clicks }. `extra` holds the 2.29 props under test. */
export function cases() {
  const month = { unit: "month", from: "2025-03-01", to: "2025-03-31" };
  const week = { unit: "week", from: "2025-03-10", to: "2025-03-16" };
  const pp = props => (k, h, x) => h(k.PeriodPicker, { onChange() {}, min: "2024-01-01", max: "2026-06-30", ...props, ...x.period });
  const trigger = '[data-slot="period-picker-trigger"]';
  const tab = i => q => q.all("[role=tab]")[i];
  const bar = dirty => (k, h, x) =>
    h(k.FilterProvider, null,
      h(k.FilterBar, { dirty, onReset() {}, ...x.filterBar }, h(k.FilterField, { label: "Market", hint: "Where" }, h("button", null, "All"))),
      h(function Tab() { k.useResettable("role", true, () => {}); return h(k.TabFilters, null, h(k.FilterSep), h(k.FilterField, { label: "Role" }, h("i"))); }));
  const ms = props => (k, h, x) => h(k.MultiSelect, { options: OPTS, value: ["ch"], onChange() {}, "aria-label": "Market", ...props, ...x.filter });
  const fm = props => (k, h, x) => h(k.FilterMenu, { options: TREE, onChange() {}, label: "Traffic", allLabel: "All traffic", ...props, ...x.filter });
  const fmItems = props => (k, h, x) =>
    h(k.DropdownMenu, { open: true, modal: false }, h(k.DropdownMenuTrigger, null, "Filters"),
      h(k.DropdownMenuContent, null, h(k.FilterMenuItems, { options: TREE, selected: ["gptbot"], onChange() {}, allLabel: "All traffic", ...props, ...x.filter })));
  const cb = props => (k, h, x) => h(k.Combobox, { options: OPTS.slice(0, 2), value: null, onChange() {}, "aria-label": "Market", ...props, ...x.combobox });
  return {
    "pp-closed": { el: pp({ value: month, label: "Hires" }) },
    "pp-closed-quarter": { el: pp({ value: { unit: "quarter", from: "2025-01-01", to: "2025-03-31" } }) },
    "pp-closed-custom": { el: pp({ value: { unit: "custom", from: "2024-11-01", to: "2025-02-28" } }) },
    "pp-open-month": { el: pp({ value: month }), open: [q => q.one(trigger)] },
    "pp-open-week": { el: pp({ value: week, units: ["week", "month", "quarter", "year"] }), open: [q => q.one(trigger)] },
    "pp-open-quarter": { el: pp({ value: month, units: ["week", "month", "quarter", "year"] }), open: [q => q.one(trigger), tab(2)] },
    "pp-open-custom": { el: pp({ value: { unit: "custom", from: "2025-03-05", to: "2025-03-14" }, custom: "day" }), open: [q => q.one(trigger)] },
    "pp-open-custom-month": { el: pp({ value: month }), open: [q => q.one(trigger), tab(3)] },
    "fb-clean": { el: bar(false) },
    "fb-sheet": { el: bar(true), open: [q => q.one('[data-slot="filter-chip"]')] },
    "ms-closed": { el: ms({}) },
    "ms-many": { el: ms({ value: ["ch", "fr"] }) },
    "ms-open": { el: ms({ showOnly: true }), open: [q => q.one(".mk-ms-trigger")] },
    "ms-open-search": { el: ms({ searchable: true }), open: [q => q.one(".mk-ms-trigger")] },
    "ms-open-tree": { el: ms({ options: TREE, value: ["gptbot"], showOnly: true }), open: [q => q.one(".mk-ms-trigger")] },
    "fm-closed": { el: fm({ selected: ["humans", "gptbot"] }) },
    "fm-closed-flat": { el: fm({ options: OPTS.slice(0, 2), selected: ["ch", "fr", "x"] }) },
    "fm-items": { el: fmItems({}) },
    "fm-items-root": { el: fmItems({ root: TREE[1] }) },
    "cb-closed": { el: cb({}) },
    "cb-open": { el: cb({}), open: [q => q.one('[data-slot="combobox-trigger"]')] },
    "cb-open-empty": { el: cb({ options: [] }), open: [q => q.one('[data-slot="combobox-trigger"]')] },
  };
}

/** React's and Radix's generated ids depend on the mount order: one placeholder. */
const normalize = html => html.replace(/«[^»]*»|:r[0-9a-z]+:|_r_[0-9a-z]+_/g, "«id»");

/** Every case's document.body HTML after its clicks. `extra` is merged into each component's props. */
export async function renderCases({ React, client, win, kit }, extra = {}) {
  const h = React.createElement;
  const out = {};
  for (const [name, c] of Object.entries(cases())) {
    win.document.body.innerHTML = "<div id=root></div>";
    const root = client.createRoot(win.document.getElementById("root"));
    await React.act(() => root.render(c.el(kit, h, { period: {}, filterBar: {}, filter: {}, combobox: {}, ...extra })));
    const q = {
      one: s => win.document.querySelector(s),
      all: s => win.document.querySelectorAll(s),
    };
    for (const pick of c.open ?? []) {
      const el = pick(q);
      if (!el) throw new Error(`${name}: nothing to click`);
      await React.act(async () => {
        el.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        el.click();
      });
      await React.act(async () => {});
    }
    out[name] = normalize(win.document.body.innerHTML);
    await React.act(() => root.unmount());
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = pathToFileURL((process.argv[2] ?? new URL(".", HERE).pathname).replace(/\/?$/, "/"));
  const [{ JSDOM }, esbuild] = await Promise.all([import("jsdom"), import("esbuild")]);
  const { kit, win, restore } = await loadKit(root, { JSDOM, esbuild });
  // react-dom after the DOM globals, so it wires its events for a browser.
  const [React, client] = await Promise.all([import("react"), import("react-dom/client")]);
  const out = await renderCases({ React, client, win, kit });
  restore();
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}
