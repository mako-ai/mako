// @makoai/app-sdk/components (2.27): PeriodPicker and its period helpers.
// The helpers are plain TypeScript that Node 24 runs as is. The picker
// render tests bundle the TSX with esbuild like menu.test.mjs, and skip when
// esbuild, radix-ui, react or jsdom are not installed.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

const P = await import("./components/period.ts");

test("periodOf: weeks start on Monday, months, quarters and years on their first day", () => {
  assert.deepEqual(P.periodOf("week", "2026-11-19"), { unit: "week", from: "2026-11-16", to: "2026-11-22" });
  assert.deepEqual(P.periodOf("week", "2026-11-22"), { unit: "week", from: "2026-11-16", to: "2026-11-22" }, "a Sunday ends its week");
  assert.deepEqual(P.periodOf("month", "2026-02-14"), { unit: "month", from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(P.periodOf("month", "2028-02-14").to, "2028-02-29", "leap year");
  assert.deepEqual(P.periodOf("quarter", "2026-11-19"), { unit: "quarter", from: "2026-10-01", to: "2026-12-31" });
  assert.deepEqual(P.periodOf("year", "2026-11-19"), { unit: "year", from: "2026-01-01", to: "2026-12-31" });
});

test("shift: one step per unit, across year ends; a custom range moves by its own length", () => {
  assert.deepEqual(P.shift(P.periodOf("month", "2026-01-10"), -1), P.periodOf("month", "2025-12-01"));
  assert.deepEqual(P.shift(P.periodOf("month", "2026-01-31"), 1), P.periodOf("month", "2026-02-01"), "Jan 31 + 1 month is February, never March");
  assert.deepEqual(P.shift(P.periodOf("week", "2026-12-30"), 1), { unit: "week", from: "2027-01-04", to: "2027-01-10" });
  assert.deepEqual(P.shift(P.periodOf("quarter", "2026-11-19"), 1), P.periodOf("quarter", "2027-01-01"));
  assert.deepEqual(P.shift(P.periodOf("year", "2026-11-19"), -2), P.periodOf("year", "2024-01-01"));
  // Whole months: Sep–Nov steps three months.
  assert.deepEqual(P.shift({ unit: "custom", from: "2026-09-01", to: "2026-11-30" }, -1), { unit: "custom", from: "2026-06-01", to: "2026-08-31" });
  // Any days: 10 days steps 10 days.
  assert.deepEqual(P.shift({ unit: "custom", from: "2026-11-05", to: "2026-11-14" }, 1), { unit: "custom", from: "2026-11-15", to: "2026-11-24" });
});

test("isCurrent and clipToday: the period in progress counts up to today", () => {
  const nov = P.periodOf("month", "2026-11-01");
  assert.equal(P.isCurrent(nov, "2026-11-19"), true);
  assert.equal(P.isCurrent(nov, "2026-12-01"), false);
  assert.deepEqual(P.clipToday(nov, "2026-11-19"), { from: "2026-11-01", to: "2026-11-19" });
  assert.deepEqual(P.clipToday(nov, "2027-01-05"), { from: "2026-11-01", to: "2026-11-30" });
  assert.equal(P.todayIso(), new Date().toISOString().slice(0, 10));
});

test("periodLabel: Nov 2026, Q4 2026, 2026, weeks and custom ranges", () => {
  assert.equal(P.periodLabel(P.periodOf("month", "2026-11-19")), "Nov 2026");
  assert.equal(P.periodLabel(P.periodOf("quarter", "2026-11-19")), "Q4 2026");
  assert.equal(P.periodLabel(P.periodOf("year", "2026-11-19")), "2026");
  assert.equal(P.periodLabel(P.periodOf("week", "2026-11-19")), "16–22 Nov 2026");
  assert.equal(P.periodLabel(P.periodOf("week", "2026-12-01")), "30 Nov – 6 Dec 2026");
  assert.equal(P.periodLabel(P.periodOf("week", "2026-12-31")), "28 Dec 2026 – 3 Jan 2027");
  assert.equal(P.periodLabel({ unit: "custom", from: "2026-09-01", to: "2026-11-30" }), "Sep – Nov 2026");
  assert.equal(P.periodLabel({ unit: "custom", from: "2025-11-01", to: "2026-02-28" }), "Nov 2025 – Feb 2026");
  assert.equal(P.periodLabel({ unit: "custom", from: "2026-11-01", to: "2026-11-30" }), "Nov 2026", "one whole month reads as the month");
});

test("components barrel exports PeriodPicker and the five helpers", () => {
  const index = readFileSync(new URL("./components/index.ts", import.meta.url), "utf8");
  assert.match(index, /export \* from "\.\/period-picker"/);
  for (const name of ["periodOf", "shift", "isCurrent", "clipToday", "periodLabel", "type Period", "type Unit"]) {
    assert.match(index, new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./period"`), `exports ${name}`);
  }
  const src = readFileSync(new URL("./components/period-picker.tsx", import.meta.url), "utf8");
  assert.match(src, /from "\.\/popover"/, "built on the stock shadcn Popover");
});

async function setup(t) {
  let esbuild, React, client, JSDOM;
  try {
    esbuild = await import("esbuild");
    React = await import("react");
    client = await import("react-dom/client");
    ({ JSDOM } = await import("jsdom"));
  } catch (e) {
    t.skip("esbuild, react or jsdom not installed here: " + e.message);
    return null;
  }
  const dom = new JSDOM("<!doctype html><body><div id=root></div><button id=outside>x</button></body>", { pretendToBeVisual: true });
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
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
    delete globalThis.ResizeObserver;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  try {
    await import("radix-ui");
  } catch (e) {
    t.skip("radix-ui not installed here: " + e.message);
    return null;
  }
  const outdir = new URL("./node_modules/.cache/period-test/", import.meta.url);
  mkdirSync(outdir, { recursive: true });
  const out = await esbuild.build({
    entryPoints: [new URL("./components/period-picker.tsx", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    write: false,
    external: ["react", "react-dom", "react/jsx-runtime", "radix-ui", "clsx", "tailwind-merge"],
  });
  const file = new URL(`period-picker-${process.pid}-${Date.now()}.mjs`, outdir);
  writeFileSync(file, out.outputFiles[0].text);
  const mod = await import(file.href);
  return { React, client, win, PeriodPicker: mod.PeriodPicker, h: React.createElement };
}

async function render(env, props) {
  const { React, client, win, PeriodPicker, h } = env;
  const state = { value: props.value, emits: [] };
  function App() {
    const [v, setV] = React.useState(state.value);
    state.value = v;
    return h(PeriodPicker, { ...props, value: v, onChange: p => { state.emits.push(p); setV(p); } });
  }
  const root = client.createRoot(win.document.getElementById("root"));
  await React.act(() => root.render(h(App)));
  const $ = sel => win.document.querySelector(sel);
  const trigger = () => $('[data-slot="period-picker-trigger"]');
  const menu = () => $('[role="dialog"]');
  const click = async el => {
    await React.act(async () => {
      el.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      el.click();
    });
    await React.act(async () => {}); // the Portal mounts on the second pass
  };
  const options = () => [...(menu()?.querySelectorAll("button:not([role=tab])") ?? [])];
  return { state, $, trigger, menu, click, options, root };
}

test("PeriodPicker: ‹ Nov 2026 › steps one period, tints the period in progress, stops at today and at min", async t => {
  const env = await setup(t);
  if (!env) return;
  const today = new Date().toISOString().slice(0, 10);
  const now = P.periodOf("month", today);
  const prev = P.shift(now, -1);
  const ui = await render(env, { value: now, min: prev.from, label: "Hires" });
  assert.equal(ui.trigger().textContent, P.periodLabel(now));
  assert.equal(ui.trigger().getAttribute("aria-label"), `Hires: ${P.periodLabel(now)}`);
  assert.ok(ui.trigger().hasAttribute("data-current"), "the month in progress is tinted");
  assert.equal(ui.trigger().title, "In progress: the numbers are not final yet");
  assert.equal(ui.$('[data-slot="period-picker-next"]').disabled, true, "› stops at today");

  await ui.click(ui.$('[data-slot="period-picker-prev"]'));
  assert.deepEqual(ui.state.emits, [prev], "‹ steps back one month");
  assert.equal(ui.trigger().hasAttribute("data-current"), false, "a finished month is not tinted");
  assert.equal(ui.$('[data-slot="period-picker-prev"]').disabled, true, "‹ stops at the first period with data (min)");
  assert.equal(ui.$('[data-slot="period-picker-next"]').disabled, false);
  await env.React.act(() => ui.root.unmount());
});

test("PeriodPicker: the middle opens recent periods by unit, and a pick closes it", async t => {
  const env = await setup(t);
  if (!env) return;
  const today = new Date().toISOString().slice(0, 10);
  const now = P.periodOf("month", today);
  const ui = await render(env, { value: now, units: ["week", "month", "quarter", "year"] });
  assert.equal(ui.menu(), null);
  await ui.click(ui.trigger());
  assert.ok(ui.menu(), "the picker opens");
  assert.equal(ui.trigger().getAttribute("aria-expanded"), "true");
  const tabs = [...ui.menu().querySelectorAll("[role=tab]")].map(b => b.textContent);
  assert.deepEqual(tabs, ["Week", "Month", "Quarter", "Year", "Custom"]);
  assert.equal(ui.options().length, 12, "12 recent months");
  assert.equal(ui.options()[0].textContent, `${P.periodLabel(now)}in progress`, "the month in progress comes first, marked");

  // The arrows sit in the stepper, outside the portalled menu: they step and leave it open.
  await ui.click(ui.$('[data-slot="period-picker-prev"]'));
  assert.ok(ui.menu(), "‹ keeps the picker open");

  await ui.click([...ui.menu().querySelectorAll("[role=tab]")].find(b => b.textContent === "Quarter"));
  assert.equal(ui.options().length, 8, "8 recent quarters");
  await ui.click(ui.options()[1]);
  assert.deepEqual(ui.state.emits.at(-1), P.shift(P.periodOf("quarter", today), -1), "a pick emits that quarter");
  assert.equal(ui.menu(), null, "and closes the picker");
  await env.React.act(() => ui.root.unmount());
});

// Typing a new range is covered in the browser (the Playwright proof): jsdom
// does not deliver a month input's typed value to React inside the portal.
test("PeriodPicker: Custom opens on the value's months and applies a whole-month range", async t => {
  const env = await setup(t);
  if (!env) return;
  const ui = await render(env, { value: P.periodOf("quarter", "2026-05-10"), max: "2026-12-31" });
  await ui.click(ui.trigger());
  await ui.click([...ui.menu().querySelectorAll("[role=tab]")].find(b => b.textContent === "Custom"));
  const [from, to] = ui.menu().querySelectorAll("input");
  assert.deepEqual([from.type, from.value, to.value, to.min, to.max], ["month", "2026-04", "2026-06", "2026-04", "2026-12"]);
  const apply = ui.menu().querySelector("button[type=submit]");
  assert.equal(apply.disabled, false);
  await env.React.act(() => apply.form.requestSubmit(apply));
  assert.deepEqual(ui.state.emits.at(-1), { unit: "custom", from: "2026-04-01", to: "2026-06-30" });
  assert.equal(ui.trigger().textContent, "Apr – Jun 2026");
  assert.equal(ui.menu(), null, "Apply closes the picker");
  await env.React.act(() => ui.root.unmount());
});
