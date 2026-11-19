// @makoai/app-sdk/components: the page filter bar (FilterProvider, FilterBar,
// FilterField, FilterSep, TabFilters, useResettable), ported from the
// workspace's apps/attrition-por-cohorte/src/ui/FilterBar.tsx. The render
// tests bundle the TSX with esbuild and skip without esbuild, react or jsdom
// (the publish job runs `node --test` with no install); the source checks
// always run.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

const SRC = readFileSync(new URL("./components/filter-bar.tsx", import.meta.url), "utf8");

test("filter bar: exported from /components", () => {
  const index = readFileSync(new URL("./components/index.ts", import.meta.url), "utf8");
  assert.match(index, /export \* from "\.\/filter-bar"/);
  assert.match(SRC, /export \{ FilterBar, FilterField, FilterProvider, FilterSep, TabFilters, useResettable \}/);
});

test("filter bar: the house spec (small-caps label, 34px row, hairline, phones at 768px and under)", () => {
  assert.match(SRC, /text-\[11px\] font-semibold tracking-\[\.06em\][^"]*uppercase/, "label: 11px, 600, letter-spaced, uppercase");
  assert.equal((SRC.match(/h-\[34px\]/g) ?? []).length, 3, "chip, Reset and hairline are 34px");
  assert.match(SRC, /data-slot="filter-sep"[\s\S]*?w-px/, "the hairline is 1px");
  assert.match(SRC, /disabled=\{active === 0\}/, "Reset is disabled at the defaults");
  assert.match(SRC, /flex flex-wrap items-end/, "the bar wraps");
  assert.doesNotMatch(SRC, /max-\[(?!769px\])\d+px\]/, "one breakpoint: width < 769px, i.e. 768px and under");
  assert.match(SRC, /max-\[769px\]:z-50/, "the sheet sits at z-50 so Radix popovers (z-50, portalled after it) open above it");
  assert.match(SRC, /data-slot="filter-slot" className="contents"/, "tab fields join the bar's flex row");
});

async function setup(t) {
  let esbuild, React, client, JSDOM;
  try {
    esbuild = await import("esbuild");
    React = await import("react");
    client = await import("react-dom/client");
    ({ JSDOM } = await import("jsdom"));
    await import("clsx");
    await import("tailwind-merge");
  } catch (e) {
    t.skip("esbuild, react, clsx, tailwind-merge or jsdom not installed here: " + e.message);
    return null;
  }
  const dom = new JSDOM("<!doctype html><body><div id=root></div></body>", { pretendToBeVisual: true });
  const win = dom.window;
  const keys = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "MouseEvent", "KeyboardEvent", "Event"];
  const saved = keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  for (const k of keys) Object.defineProperty(globalThis, k, { value: k === "window" ? win : win[k], configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  const outdir = new URL("./node_modules/.cache/filter-bar-test/", import.meta.url);
  mkdirSync(outdir, { recursive: true });
  const out = await esbuild.build({
    entryPoints: [new URL("./components/filter-bar.tsx", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    write: false,
    external: ["react", "react-dom", "react/jsx-runtime", "clsx", "tailwind-merge"],
  });
  const file = new URL(`filter-bar-${process.pid}-${Date.now()}.mjs`, outdir);
  writeFileSync(file, out.outputFiles[0].text);
  const fb = await import(file.href);
  return { React, client, win, fb, h: React.createElement };
}

/** A page: one global field (market) and a tab that adds its own (role) through TabFilters. */
async function renderPage(env) {
  const { React, client, win, fb, h } = env;
  const state = { market: "ALL", role: "bdr", showTab: true };
  let set = {};
  function Tab() {
    const [role, setRole] = React.useState("bdr");
    state.role = role;
    set.role = setRole;
    fb.useResettable("role", role !== "bdr", () => setRole("bdr"));
    return h(fb.TabFilters, null, h(fb.FilterSep), h(fb.FilterField, { label: "Role", hint: "The role at hire" }, h("button", { id: "role" }, role)));
  }
  function App() {
    const [market, setMarket] = React.useState("ALL");
    const [showTab, setShowTab] = React.useState(true);
    state.market = market;
    set.market = setMarket;
    set.showTab = setShowTab;
    return h(
      fb.FilterProvider,
      null,
      h(fb.FilterBar, { dirty: market !== "ALL", onReset: () => setMarket("ALL") }, h(fb.FilterField, { label: "Market" }, h("button", { id: "market" }, market))),
      showTab && h(Tab),
    );
  }
  const root = client.createRoot(win.document.getElementById("root"));
  await React.act(() => root.render(h(App)));
  await React.act(async () => {}); // TabFilters portals once the slot exists
  const q = s => win.document.querySelector(s);
  const btn = text => [...win.document.querySelectorAll("button")].find(b => b.textContent.trim().startsWith(text));
  const act = fn => React.act(async () => fn());
  return { state, set, q, btn, act, win, unmount: () => React.act(() => root.unmount()) };
}

test("filter bar: tab fields render into the bar's slot, after the global ones", async t => {
  const env = await setup(t);
  if (!env) return;
  const p = await renderPage(env);
  const bar = p.q('[data-slot="filter-bar"]');
  assert.equal(bar.getAttribute("role"), "group");
  assert.ok(p.q('[data-slot="filter-slot"] #role'), "the tab's field sits in the slot");
  const order = [...bar.querySelectorAll('[data-slot="filter-label"]')].map(l => l.textContent);
  assert.deepEqual(order, ["Market", "Roleⓘ"]);
  assert.equal(p.q('[data-slot="filter-label"][title="The role at hire"]')?.textContent, "Roleⓘ", "the hint is the label's title");
  assert.ok(p.q('[data-slot="filter-slot"] [data-slot="filter-sep"][aria-hidden]'));
  await p.unmount();
});

test("filter bar: Reset is disabled at the defaults and resets the page and every tab", async t => {
  const env = await setup(t);
  if (!env) return;
  const p = await renderPage(env);
  const reset = () => p.btn("Reset");
  assert.equal(reset().disabled, true);
  assert.equal(p.q('[data-slot="filter-count"]'), null, "no badge at the defaults");
  await p.act(() => p.set.market("FR"));
  await p.act(() => p.set.role("ae"));
  assert.equal(reset().disabled, false);
  assert.equal(p.q('[data-slot="filter-count"]').textContent, "2", "the chip counts the page's and the tab's filter");
  await p.act(() => reset().click());
  assert.equal(p.state.market, "ALL");
  assert.equal(p.state.role, "bdr");
  assert.equal(reset().disabled, true);
  await p.unmount();
});

test("filter bar: a tab that unmounts leaves the count and Reset", async t => {
  const env = await setup(t);
  if (!env) return;
  const p = await renderPage(env);
  await p.act(() => p.set.role("ae"));
  assert.equal(p.q('[data-slot="filter-count"]').textContent, "1");
  await p.act(() => p.set.showTab(false));
  assert.equal(p.q('[data-slot="filter-count"]'), null);
  assert.equal(p.btn("Reset").disabled, true);
  assert.equal(p.q("#role"), null);
  await p.unmount();
});

test("filter bar: the Filters chip opens the sheet; Done, the scrim and Escape close it", async t => {
  const env = await setup(t);
  if (!env) return;
  const p = await renderPage(env);
  const open = () => p.q('[data-slot="filter-bar"]').hasAttribute("data-open");
  const chip = p.q('[data-slot="filter-chip"]');
  assert.equal(chip.getAttribute("aria-expanded"), "false");
  await p.act(() => chip.click());
  assert.ok(open());
  assert.equal(chip.getAttribute("aria-expanded"), "true");
  await p.act(() => p.btn("Done").click());
  assert.ok(!open());
  await p.act(() => chip.click());
  await p.act(() => p.q('[data-slot="filter-scrim"]').click());
  assert.ok(!open());
  assert.equal(p.q('[data-slot="filter-scrim"]'), null);
  await p.act(() => chip.click());
  // A popover inside the sheet took this Escape (Radix marks it): the sheet stays.
  await p.act(() => {
    const e = new p.win.KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    e.preventDefault();
    p.win.dispatchEvent(e);
  });
  assert.ok(open());
  await p.act(() => p.win.dispatchEvent(new p.win.KeyboardEvent("keydown", { key: "Escape" })));
  assert.ok(!open());
  await p.unmount();
});
