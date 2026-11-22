// 2.31: `clickAdds` on MultiSelect, FilterItems and the filter model. An empty
// value means All, every option row shows unticked, and a click adds that
// option. The default (off) keeps the 2.20 behaviour. The render tests skip
// without react or jsdom (the publish job runs `node --test` with no
// install); the model tests always run.
import assert from "node:assert/strict";
import test from "node:test";
import * as c from "./ui-core.js";

const flat = ["a", "b", "c"].map(v => ({ value: v, label: v.toUpperCase() }));
const tree = [
  { value: "h", label: "Humans" },
  { value: "bots", label: "Bots", children: [{ value: "g", label: "GPT" }, { value: "b", label: "Bing" }] },
];

test("clickAdds model: empty ticks nothing, the first click adds, the last untick returns to []", () => {
  assert.equal(c.filterTick(flat[0], [], false, true), "off");
  assert.equal(c.filterTick(flat[0], [], false), "on", "the default is unchanged");
  assert.equal(c.filterAllTick([]), "on");
  assert.deepEqual(c.filterToggle(flat, [], flat[1], false, true), { none: false, selected: ["b"] });
  assert.deepEqual(c.filterToggle(flat, ["b"], flat[0], false, true), { none: false, selected: ["a", "b"] });
  assert.deepEqual(c.filterToggle(flat, ["a", "b"], flat[0], false, true), { none: false, selected: ["b"] });
  assert.deepEqual(c.filterToggle(flat, ["b"], flat[1], false, true), { none: false, selected: [] }, "never the draft");
  assert.deepEqual(c.filterToggle(flat, ["a", "b"], flat[2], false, true), { none: false, selected: [] }, "every option reads as All");
  assert.deepEqual(c.filterToggle(flat, [], flat[1]), { none: false, selected: ["a", "c"] }, "the default still unticks from All");
  assert.deepEqual(c.filterToggleAll(["a"], false, true), { none: false, selected: [] });
  assert.deepEqual(c.filterToggleAll([], false, true), { none: false, selected: [] }, "All stays All");
});

test("clickAdds model: a group click adds its leaves, a second removes them", () => {
  assert.deepEqual(c.filterToggle(tree, [], tree[1], false, true).selected, ["g", "b"]);
  assert.equal(c.filterTick(tree[1], ["g", "b"], false, true), "on");
  assert.equal(c.filterTick(tree[1], ["g"], false, true), "mixed");
  assert.deepEqual(c.filterToggle(tree, ["g"], tree[1], false, true).selected, ["g", "b"], "a mixed group fills up");
  assert.deepEqual(c.filterToggle(tree, ["h", "g", "b"], tree[1], false, true).selected, ["h"]);
  assert.deepEqual(c.filterToggle(tree, ["g", "b"], tree[1], false, true).selected, [], "last group removed: All");
});

test("clickAdds model: URL values are the same as without the prop", () => {
  for (const sel of [[], ["b"], ["g", "b"], ["h", "g"]]) {
    const raw = c.filterToParam(tree, sel);
    assert.deepEqual(c.filterFromParam(tree, raw), sel.length === 0 ? [] : c.filterNormalize(tree, sel));
  }
  assert.equal(c.filterToParam(tree, []), "", "empty is the default: no URL change");
  assert.equal(c.filterToParam(tree, [], ["h"]), "all", "empty against a narrower default writes all");
  assert.deepEqual(c.filterFromParam(tree, "all", ["h"]), []);
  // A click sequence ends where it started, and the URL ends empty.
  let sel = [];
  sel = c.filterToggle(tree, sel, tree[0], false, true).selected;
  assert.equal(c.filterToParam(tree, sel), "h");
  sel = c.filterFromParam(tree, "h");
  sel = c.filterToggle(tree, sel, tree[0], false, true).selected;
  assert.equal(c.filterToParam(tree, sel), "");
});

async function setup(t) {
  let React, client, JSDOM;
  try {
    React = await import("react");
    client = await import("react-dom/client");
    ({ JSDOM } = await import("jsdom"));
  } catch (e) {
    t.skip("react or jsdom not installed here: " + e.message);
    return null;
  }
  const dom = new JSDOM("<!doctype html><body><div id=root></div></body>");
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const keys = ["window", "document", "Node", "Element", "HTMLElement", "MouseEvent", "Event", "KeyboardEvent"];
  const saved = keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  for (const k of keys) Object.defineProperty(globalThis, k, { value: k === "window" ? win : win[k], configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  const ui = await import("./ui.js");
  return { React, client, win, ui, h: React.createElement };
}

const CAMPAIGNS = ["Barometer", "Spring", "Summer", "Autumn"];

async function mount(env, props) {
  const { React, client, win, ui, h } = env;
  const state = { value: props.initial ?? [], emits: [] };
  function App() {
    const [v, setV] = React.useState(state.value);
    state.value = v;
    return h(props.component ?? ui.MultiSelect, {
      options: props.options ?? CAMPAIGNS,
      value: v,
      onChange: n => (state.emits.push(n), setV(n)),
      allLabel: "All campaigns",
      ...props.extra,
    });
  }
  const root = client.createRoot(win.document.getElementById("root"));
  await React.act(() => root.render(h(App)));
  if (!props.component) await React.act(() => win.document.querySelector(".mk-ms-trigger").click());
  const rows = () => [...win.document.querySelectorAll('[role="option"]')];
  const row = text => rows().find(r => r.textContent.replace(/Only$/, "") === text);
  const ticks = () => rows().map(r => `${r.getAttribute("aria-checked")}:${r.textContent.replace(/Only$/, "")}`);
  const click = async text => React.act(() => row(text).click());
  const trigger = () => win.document.querySelector(".mk-ms-text")?.textContent;
  return { state, rows, row, ticks, click, trigger, root };
}

test("MultiSelect clickAdds: the first click adds, unticking the last returns to All", async t => {
  const env = await setup(t);
  if (!env) return;
  const m = await mount(env, { extra: { clickAdds: true } });
  assert.deepEqual(m.ticks(), ["true:All campaigns", ...CAMPAIGNS.map(c => `false:${c}`)], "All ticked, options unticked");
  assert.equal(m.trigger(), "All campaigns");
  await m.click("Summer");
  assert.deepEqual(m.state.value, ["Summer"], "the first click adds");
  assert.equal(m.trigger(), "Summer");
  await m.click("Spring");
  assert.deepEqual(m.state.value, ["Spring", "Summer"], "the second click adds too");
  assert.equal(m.trigger(), "2 selected");
  await m.click("Summer");
  await m.click("Spring");
  assert.deepEqual(m.state.value, [], "unticking the last returns to All");
  assert.equal(m.trigger(), "All campaigns");
  assert.deepEqual(m.ticks(), ["true:All campaigns", ...CAMPAIGNS.map(c => `false:${c}`)]);
  await m.click("Autumn");
  await m.click("All campaigns");
  assert.deepEqual(m.state.value, [], "a click on All returns to All");
  await env.React.act(() => m.root.unmount());
});

test("MultiSelect default (no clickAdds): the 2.20 rule is unchanged, the first click unticks", async t => {
  const env = await setup(t);
  if (!env) return;
  const m = await mount(env, {});
  assert.deepEqual(m.ticks(), ["true:All campaigns", ...CAMPAIGNS.map(c => `true:${c}`)]);
  await m.click("Barometer");
  assert.deepEqual(m.state.value, CAMPAIGNS.slice(1));
  await env.React.act(() => m.root.unmount());
});

test("MultiSelect clickAdds: Only still picks one row", async t => {
  const env = await setup(t);
  if (!env) return;
  const m = await mount(env, { extra: { clickAdds: true, showOnly: true }, initial: ["Spring", "Summer"] });
  const only = m.row("Autumn").querySelector(".mk-ms-only");
  await env.React.act(() => only.click());
  assert.deepEqual(m.state.value, ["Autumn"], "Only replaces the pick");
  await env.React.act(() => m.row("Autumn").querySelector(".mk-ms-only").click());
  assert.deepEqual(m.state.value, ["Autumn"]);
  await env.React.act(() => m.root.unmount());
});

test("FilterItems clickAdds: a group click adds all its children; the URL value round-trips", async t => {
  const env = await setup(t);
  if (!env) return;
  const options = [
    { value: "humans", label: "Humans" },
    { value: "bots", label: "Bots", children: [{ value: "gpt", label: "GPTBot" }, { value: "bing", label: "Bingbot" }] },
  ];
  const m = await mount(env, { component: env.ui.FilterItems, options, extra: { clickAdds: true } });
  assert.deepEqual(m.ticks(), ["true:All campaigns", "false:Humans", "false:Bots", "false:GPTBot", "false:Bingbot"]);
  await m.click("Bots");
  assert.deepEqual(m.state.value, ["gpt", "bing"], "a group click adds all its children");
  assert.deepEqual(m.ticks(), ["mixed:All campaigns", "false:Humans", "true:Bots", "true:GPTBot", "true:Bingbot"]);
  const param = env.ui.filterToParam(options, m.state.value);
  assert.equal(param, "bots", "the URL names the group, as without the prop");
  assert.deepEqual(env.ui.filterFromParam(options, param), ["gpt", "bing"]);
  await m.click("GPTBot");
  assert.deepEqual(m.state.value, ["bing"]);
  await m.click("Bingbot");
  assert.deepEqual(m.state.value, [], "the last untick returns to All");
  assert.equal(env.ui.filterToParam(options, m.state.value), "", "an empty value writes no URL value");
  await env.React.act(() => m.root.unmount());
});
