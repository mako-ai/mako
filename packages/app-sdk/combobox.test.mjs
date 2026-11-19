// @makoai/app-sdk/components/combobox (2.28): shadcn's combobox recipe
// (Popover + Command). The source checks always run; the render tests bundle
// the TSX with esbuild and skip without esbuild, react, radix-ui, cmdk or jsdom.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("./components/combobox.tsx", import.meta.url), "utf8");

test("Combobox: the shadcn recipe on the stock Popover, Command and Button", () => {
  for (const f of ["./popover", "./command", "./button"]) assert.match(src, new RegExp(`from "${f.replace(".", "\\.")}"`), `imports ${f}`);
  for (const part of ["<Popover open={open} onOpenChange={setOpen}>", "<PopoverTrigger asChild>", 'role="combobox"', "aria-expanded={open}", "<CommandInput", "<CommandEmpty>", "<CommandGroup>", "<CommandItem", "setOpen(false)", "ChevronsUpDownIcon", "CheckIcon"]) {
    assert.ok(src.includes(part), `recipe part ${part}`);
  }
  assert.match(src, /o\.value === value \? null : o\.value/, "picking the picked row clears it, as the recipe does");
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(pkg.exports["./components/combobox"].default, "./components/combobox.tsx");
  const barrel = readFileSync(new URL("./components/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(barrel, /combobox/, "the barrel never loads cmdk");
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
    Object.defineProperty(globalThis, k, { value: typeof value === "function" && /^[a-z]/.test(k) ? value.bind(win) : value, configurable: true, writable: true });
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
  // radix-ui (and cmdk's radix parts) pick their layout-effect hook when they
  // first load: a no-op without a document. Load them after the DOM globals.
  try {
    await import("radix-ui");
    await import("cmdk");
  } catch (e) {
    t.skip("radix-ui or cmdk not installed here: " + e.message);
    return null;
  }
  const outdir = new URL("./node_modules/.cache/combobox-test/", import.meta.url);
  mkdirSync(outdir, { recursive: true });
  const out = await esbuild.build({
    entryPoints: [new URL("./components/combobox.tsx", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    write: false,
    external: ["react", "react-dom", "react/jsx-runtime", "radix-ui", "cmdk", "lucide-react", "clsx", "tailwind-merge", "class-variance-authority"],
  });
  const file = new URL(`combobox-${process.pid}-${Date.now()}.mjs`, outdir);
  writeFileSync(file, out.outputFiles[0].text);
  const mod = await import(file.href);
  return { React, client, win, Combobox: mod.Combobox, h: React.createElement };
}

const CSMS = [
  { value: "csm_1", label: "Alice Martin", count: 1234, keywords: ["FR"] },
  { value: "csm_2", label: "Bruno Costa", count: 12, keywords: ["IT"] },
  { value: "csm_3", label: "Carla Rossi", count: 7, keywords: ["ES"] },
];

async function render(env, props) {
  const { React, client, win, Combobox, h } = env;
  const state = { value: props.value ?? null, emits: [] };
  function App() {
    const [v, setV] = React.useState(state.value);
    state.value = v;
    return h(Combobox, { "aria-label": "CSM", placeholder: "All CSMs", options: CSMS, ...props, value: v, onChange: n => { state.emits.push(n); setV(n); } });
  }
  const root = client.createRoot(win.document.body.appendChild(win.document.createElement("div")));
  await React.act(() => root.render(h(App)));
  const doc = win.document;
  const trigger = () => doc.querySelector('[data-slot="combobox-trigger"]');
  const input = () => doc.querySelector('[data-slot="command-input"]');
  const rows = () => [...doc.querySelectorAll('[data-slot="command-item"]')].filter(r => !r.hidden);
  const labels = () => rows().map(r => r.querySelector("span").textContent);
  const highlighted = () => doc.querySelector('[data-slot="command-item"][data-selected="true"] span')?.textContent;
  const open = async () => {
    await React.act(async () => {
      trigger().dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger().click();
    });
    await React.act(async () => {});
  };
  const key = async k => React.act(async () => input().dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
  const type = async q => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
    await React.act(async () => {
      setter.call(input(), q);
      input().dispatchEvent(new win.Event("input", { bubbles: true }));
      input().dispatchEvent(new win.KeyboardEvent("keyup", { key: "x", bubbles: true }));
    });
  };
  return { state, doc, trigger, input, rows, labels, highlighted, open, key, type, root };
}

async function search(env) {
  const ui = await render(env, {});
  await ui.open();
  await ui.type("12");
  assert.deepEqual(ui.labels(), [], "12 is a count (Bruno) and part of a count (1,234): no match");
  assert.ok(ui.doc.querySelector('[data-slot="command-empty"]'), "the empty text shows");
  await ui.type("csm");
  assert.deepEqual(ui.labels(), [], "the value is never searched");
  await ui.type("fr");
  assert.deepEqual(ui.labels(), ["Alice Martin"], "a keyword matches (Alice works FR)");
  await ui.type("carla");
  assert.deepEqual(ui.labels(), ["Carla Rossi"]);
  await ui.type("");
  assert.equal(ui.highlighted(), "Alice Martin", "cmdk highlights the first row");
  await ui.key("ArrowDown");
  assert.equal(ui.highlighted(), "Bruno Costa");
  await ui.key("Enter");
  assert.deepEqual(ui.state.emits, ["csm_2"], "Enter picks the highlighted row");
  assert.equal(ui.input(), null, "and closes it");
  await env.React.act(() => ui.root.unmount());
}

async function pick(env) {
  const ui = await render(env, {});
  assert.equal(ui.trigger().textContent, "All CSMs");
  assert.equal(ui.trigger().getAttribute("role"), "combobox");
  await ui.open();
  assert.equal(ui.trigger().getAttribute("aria-expanded"), "true");
  assert.equal(ui.doc.activeElement, ui.input(), "the search takes focus");
  assert.deepEqual(ui.labels(), ["Alice Martin", "Bruno Costa", "Carla Rossi"]);
  assert.deepEqual(ui.rows().map(r => r.querySelector('[data-slot="combobox-count"]').textContent), ["1,234", "12", "7"]);
  await env.React.act(async () => ui.rows()[1].click());
  assert.deepEqual(ui.state.emits, ["csm_2"]);
  assert.equal(ui.input(), null, "a pick closes it");
  assert.equal(ui.trigger().textContent, "Bruno Costa", "no count in the trigger");
  await ui.open();
  assert.ok(ui.rows()[1].querySelector("svg.opacity-100"), "the picked row shows its check");
  await env.React.act(async () => ui.rows()[1].click());
  assert.deepEqual(ui.state.emits, ["csm_2", null], "picking the picked row clears it");
  assert.equal(ui.trigger().textContent, "All CSMs");
  await env.React.act(() => ui.root.unmount());
}

// One jsdom per file. In jsdom a second Command mounted after the first does
// not re-filter as you type, so the search scenario runs first.
test("Combobox: search, keys and picks", async t => {
  const env = await setup(t);
  if (!env) return;
  await t.test("search matches label and keywords, never the value or the count; arrows and Enter pick", () => search(env));
  await t.test("placeholder, counts at the right, a pick closes it, the trigger shows the label only, a re-pick clears", () => pick(env));
});
