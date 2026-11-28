// @makoai/app-sdk/components/time-picker (2.32): composable time-range & cohort picker.
// Source checks always run; render tests bundle the TSX with esbuild and skip if
// esbuild, react, radix-ui, react-day-picker or jsdom are not installed here.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("./components/time-picker.tsx", import.meta.url), "utf8");

test("TimePicker: built on stock Popover, Calendar and Button, ships on its own subpath", () => {
  for (const f of ["./popover", "./calendar", "./button", "./period"]) {
    assert.match(src, new RegExp(`from "${f.replace(".", "\\.")}"`), `imports ${f}`);
  }
  assert.doesNotMatch(src, /\btitle=/, "no native hover title tooltips");
  assert.match(src, /bg-background/, "matches MultiSelect / native input surface");
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(pkg.exports["./components/time-picker"].default, "./components/time-picker.tsx");
  const barrel = readFileSync(new URL("./components/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(barrel, /time-picker/, "the barrel never loads react-day-picker");
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
    Object.defineProperty(globalThis, k, {
      value: typeof value === "function" && /^[a-z]/.test(k) ? value.bind(win) : value,
      configurable: true,
      writable: true,
    });
  }
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  globalThis.ResizeObserver = win.ResizeObserver = ResizeObserver;
  win.HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
    delete globalThis.ResizeObserver;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  try {
    await import("radix-ui");
    await import("react-day-picker");
  } catch (e) {
    t.skip("radix-ui or react-day-picker not installed here: " + e.message);
    return null;
  }
  const outdir = new URL("./node_modules/.cache/time-picker-test/", import.meta.url);
  mkdirSync(outdir, { recursive: true });
  const out = await esbuild.build({
    entryPoints: [new URL("./components/time-picker.tsx", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    write: false,
    external: [
      "react", "react-dom", "react/jsx-runtime", "radix-ui", "react-day-picker",
      "lucide-react", "clsx", "tailwind-merge", "class-variance-authority",
    ],
  });
  const file = new URL(`time-picker-${process.pid}-${Date.now()}.mjs`, outdir);
  writeFileSync(file, out.outputFiles[0].text);
  const mod = await import(file.href);
  return { React, client, win, mod, h: React.createElement };
}

async function render(env, props) {
  const { React, client, win, mod, h } = env;
  const state = { value: props.value, extra: props.activeExtra ?? null, emits: [], extraEmits: [] };
  function App() {
    const [v, setV] = React.useState(state.value);
    const [ex, setEx] = React.useState(state.extra);
    state.value = v;
    state.extra = ex;
    return h(mod.TimePicker, {
      locale: "en",
      ...props,
      value: v,
      activeExtra: ex,
      onChange: n => { state.emits.push(n); setV(n); },
      onExtraChange: id => { state.extraEmits.push(id); setEx(id); },
    });
  }
  const container = win.document.body.appendChild(win.document.createElement("div"));
  const root = client.createRoot(container);
  await React.act(() => root.render(h(App)));
  const doc = win.document;
  const trigger = () => container.querySelector('[data-slot="time-picker-trigger"]');
  const prev = () => container.querySelector('[data-slot="time-picker-prev"]');
  const next = () => container.querySelector('[data-slot="time-picker-next"]');
  const open = async () => {
    await React.act(async () => {
      trigger().dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger().click();
    });
    await React.act(async () => {});
  };
  const unmount = async () => {
    await React.act(() => root.unmount());
    container.remove();
  };
  return { state, doc, trigger, prev, next, open, unmount };
}

test("TimePicker: range shortcuts, sub-day includeTime, cohort stepping, single-unit rail collapse, extras and month-range", async t => {
  const env = await setup(t);
  if (!env) return;
  const { periodOf, presetPeriod, todayIso } = env.mod;
  const today = todayIso();

  await t.test("time-range mode: no nav arrows, shortcuts commit in 1 click, sub-day 1h works", async () => {
    const ui = await render(env, {
      value: presetPeriod("7d", today),
      shortcuts: ["1h", "6h", "24h", "7d", "30d", "1y"],
      navigation: false,
      includeTime: true,
      min: "2025-01-01",
    });
    assert.equal(ui.prev(), null, "navigation=false omits step arrows");
    assert.equal(ui.trigger().textContent, "Last 7 days");
    await ui.open();
    const btns = [...ui.doc.querySelectorAll('[data-slot="time-picker-shortcut"]')];
    assert.deepEqual(btns.map(b => b.textContent), ["Last hour", "Last 6 hours", "Last 24 hours", "Last 7 days", "Last 30 days", "Last year"]);
    await env.React.act(async () => btns[0].click());
    assert.equal(ui.state.value.preset, "1h");
    assert.ok(ui.state.value.fromTime && ui.state.value.toTime, "sub-day preset sets fromTime/toTime");
    assert.equal(ui.trigger().textContent, "Last hour");
    await ui.unmount();
  });

  await t.test("multi-unit cohort mode: shows Day/Week/Month/Quarter/Year rail and steps with arrows", async () => {
    const wk = periodOf("week", today);
    const ui = await render(env, {
      value: wk,
      periods: ["day", "week", "month", "quarter", "year"],
      navigation: true,
      custom: false,
      min: "2024-01-01",
    });
    assert.ok(ui.prev() && ui.next(), "renders step arrows");
    assert.equal(ui.next().disabled, true, "cannot step past today when max is unset");
    await env.React.act(async () => ui.prev().click());
    assert.equal(ui.state.emits.length, 1);
    assert.equal(ui.state.value.unit, "week");
    assert.ok(ui.state.value.from < wk.from, "prev arrow stepped backward one week");
    await ui.open();
    const units = [...ui.doc.querySelectorAll('[data-slot="time-picker-unit"]')].map(b => b.textContent);
    assert.deepEqual(units, ["Day", "Week", "Month", "Quarter", "Year"]);
    await ui.unmount();
  });

  await t.test("single-unit month cohort: auto-hides left rail, enables future months up to max, handles extras", async () => {
    const mon = periodOf("month", today);
    const futureYear = Number(today.slice(0, 4)) + 1;
    const ui = await render(env, {
      value: mon,
      periods: ["month"],
      navigation: true,
      custom: false,
      min: "2024-01-01",
      max: `${futureYear}-06-30`,
      extraOptions: [
        { id: "all", label: "All months" },
        { id: "undated", label: "Missing date", badge: 14 },
      ],
    });
    assert.equal(ui.next().disabled, false, "future max enables next-month stepping");
    await ui.open();
    assert.equal(ui.doc.querySelector('[data-slot="time-picker-rail"]'), null, "single-unit mode hides left rail");
    const extras = [...ui.doc.querySelectorAll('[data-slot="time-picker-extra"]')];
    assert.equal(extras.length, 2);
    await env.React.act(async () => extras[1].click());
    assert.equal(ui.state.extra, "undated");
    assert.equal(ui.trigger().textContent, "Missing date");
    assert.equal(ui.prev().disabled, true, "arrows disable while an extra option is active");
    await ui.unmount();
  });

  await t.test("whole-month range: ytd anchors to today even with future max, 2-click picks span", async () => {
    const futureYear = Number(today.slice(0, 4)) + 1;
    const ui = await render(env, {
      value: { unit: "custom", from: "2026-01-01", to: "2026-03-31" },
      shortcuts: ["ytd", "all"],
      custom: "month",
      navigation: false,
      min: "2024-01-01",
      max: `${futureYear}-12-31`,
    });
    await ui.open();
    const shortcuts = [...ui.doc.querySelectorAll('[data-slot="time-picker-shortcut"]')];
    await env.React.act(async () => shortcuts[0].click());
    assert.equal(ui.state.value.preset, "ytd");
    assert.equal(ui.state.value.to, today, "ytd anchors to today, never future max");
    await ui.open();
    const months = [...ui.doc.querySelectorAll('[data-slot="time-picker-month"]')];
    await env.React.act(async () => months[0].click()); // Jan
    await env.React.act(async () => months[5].click()); // Jun
    assert.equal(ui.state.value.from.slice(5), "01-01");
    assert.equal(ui.state.value.to.slice(5), "06-30");
    await ui.unmount();
  });

  await t.test("review regressions: timePresetRange, ISO week-year boundary W01, reversed same-day times, explicit times unsteppable", async () => {
    const { timePresetRange } = env.mod;
    assert.equal(timePresetRange("24h")?.preset, "24h");
    assert.ok(timePresetRange("24h")?.fromTime && timePresetRange("24h")?.toTime);
    assert.equal(timePresetRange("1y", { min: "2020-01-01" })?.preset, "1y");
    assert.equal(timePresetRange("last_week")?.unit, "week");
    assert.equal(timePresetRange("not-a-preset"), null);

    // Dec 31, 2024 falls in ISO week 2025-W01 (Dec 30, 2024 – Jan 5, 2025): week list must reach 2025-W01.
    const w01 = periodOf("week", "2024-12-31");
    const uiWeek = await render(env, {
      value: w01,
      periods: ["week", "month"],
      navigation: true,
      custom: false,
      min: "2024-01-01",
      max: "2024-12-31",
    });
    await uiWeek.open();
    const weekTexts = [...uiWeek.doc.querySelectorAll('[data-slot="time-picker-week"]')].map(b => b.textContent);
    assert.ok(weekTexts.some(t => t.includes("W01")), "2025-W01 is visible when max is 2024-12-31");
    await uiWeek.unmount();

    // Explicit sub-day times disable step arrows instead of silently dropping times.
    const uiTimed = await render(env, {
      value: { unit: "custom", from: "2026-11-27", to: "2026-11-27", fromTime: "18:00", toTime: "09:00" },
      includeTime: true,
      navigation: true,
      min: "2026-01-01",
      max: "2026-11-27",
    });
    assert.equal(uiTimed.prev().disabled, true, "explicit timed range disables prev step");
    assert.equal(uiTimed.next().disabled, true, "explicit timed range disables next step");
    // Pressing Apply on same-day reversed times (18:00 -> 09:00) normalises to 09:00 -> 18:00.
    await uiTimed.open();
    const applyBtn = [...uiTimed.doc.querySelectorAll('[role="dialog"] button')].find(b => b.textContent === "Apply");
    await env.React.act(async () => applyBtn.click());
    assert.equal(uiTimed.state.value.fromTime, "09:00");
    assert.equal(uiTimed.state.value.toTime, "18:00");
    await uiTimed.unmount();
  });
});
