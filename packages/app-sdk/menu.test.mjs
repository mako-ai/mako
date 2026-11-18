// @makoai/app-sdk/menu: stock shadcn DropdownMenu + Checkbox and FilterMenu.
// The folder ships TypeScript source (the app's Vite compiles it), so the
// tests bundle it with esbuild first. Without esbuild, radix-ui, react or
// jsdom installed (the publish job runs `node --test` with no install), the
// render tests skip; the source checks always run.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

const src = name => readFileSync(new URL(`./menu/${name}`, import.meta.url), "utf8");

test("menu: the dropdown-menu is stock shadcn, with the cn import as its only change", () => {
  const dm = src("dropdown-menu.tsx");
  assert.match(dm, /from "\.\/utils"/);
  assert.doesNotMatch(dm, /@\/(cn|lib\/utils)/);
  // The hover submenus Joan relies on (18 Nov 2026): Sub, SubTrigger, SubContent stay radix's own.
  for (const part of ["Sub", "SubTrigger", "SubContent", "CheckboxItem"]) {
    assert.match(dm, new RegExp(`DropdownMenuPrimitive\\.${part}\\b`), `uses radix ${part}`);
  }
});

test("menu: ui.css styles every mk- class the menu renders", () => {
  const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");
  const used = new Set(["filter-menu.tsx", "checkbox.tsx", "dropdown-menu.tsx"].flatMap(f => src(f).match(/\bmk-[a-z-]+/g) ?? []));
  for (const cls of used) assert.ok(css.includes(`.${cls}`), `ui.css has .${cls}`);
});

test("package.json exports ./menu and ships the folder", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.equal(pkg.exports["./menu"].default, "./menu/index.ts");
  assert.ok(pkg.files.includes("menu/"));
  for (const dep of ["radix-ui", "lucide-react", "clsx", "tailwind-merge"]) {
    assert.equal(pkg.peerDependenciesMeta[dep]?.optional, true, `${dep} is an optional peer: /ui apps need none of it`);
  }
});

async function setup(t) {
  let esbuild, React, client, JSDOM;
  try {
    esbuild = await import("esbuild");
    React = await import("react");
    client = await import("react-dom/client");
    ({ JSDOM } = await import("jsdom"));
  } catch (e) {
    t.skip("esbuild, radix-ui, react or jsdom not installed here: " + e.message);
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
  win.HTMLElement.prototype.hasPointerCapture = () => false;
  win.HTMLElement.prototype.releasePointerCapture = () => {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
    delete globalThis.ResizeObserver;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  // radix-ui picks its layout-effect hook when it first loads: a no-op
  // without a document. Load it only after the DOM globals exist.
  try {
    await import("radix-ui");
  } catch (e) {
    t.skip("radix-ui not installed here: " + e.message);
    return null;
  }
  // Bundle the TSX next to node_modules so react / radix-ui resolve as the app's would.
  const outdir = new URL("./node_modules/.cache/menu-test/", import.meta.url);
  mkdirSync(outdir, { recursive: true });
  const out = await esbuild.build({
    entryPoints: [new URL("./menu/index.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    write: false,
    external: ["react", "react-dom", "react/jsx-runtime", "radix-ui", "lucide-react", "clsx", "tailwind-merge"],
  });
  const file = new URL(`menu-${process.pid}-${Date.now()}.mjs`, outdir);
  writeFileSync(file, out.outputFiles[0].text);
  const menu = await import(file.href);
  return { React, client, win, menu, h: React.createElement };
}

const TRAFFIC = [
  { value: "humans", label: "Humans" },
  {
    value: "bots",
    label: "Bots",
    children: [
      { value: "gptbot", label: "GPTBot" },
      { value: "bing", label: "Bingbot" },
    ],
  },
];

/** FilterMenuItems inside an open stock DropdownMenu, as an app's toolbar menu holds them. */
async function renderItems(env, props) {
  const { React, client, win, menu, h } = env;
  const state = { value: props.initial ?? [], emits: 0 };
  function App() {
    const [v, setV] = React.useState(state.value);
    state.value = v;
    return h(
      menu.DropdownMenu,
      { open: true, modal: false },
      h(menu.DropdownMenuTrigger, null, "Filters"),
      h(
        menu.DropdownMenuContent,
        null,
        h(menu.FilterMenuItems, {
          options: props.options,
          selected: v,
          onChange: next => {
            state.emits++;
            setV(next);
          },
          allLabel: props.allLabel ?? "All",
          emptyMeansAll: props.emptyMeansAll,
        }),
      ),
    );
  }
  const root = client.createRoot(win.document.getElementById("root"));
  await React.act(() => root.render(h(App)));
  await React.act(async () => {}); // the Portal mounts on the second pass
  const rows = () => [...win.document.querySelectorAll('[role="menuitemcheckbox"], [role="menuitem"]')];
  const row = text => rows().find(r => r.textContent.replace(/Only$/, "").trim() === text);
  const click = async el => React.act(() => el.click());
  return { state, rows, row, click, root, React };
}

test("FilterMenuItems: the 2.20 All rule on a flat list (Barometer case)", async t => {
  const env = await setup(t);
  if (!env) return;
  const options = ["Barometer", "Brand", "Display", "Search", "Social", "Video"].map(v => ({ value: v, label: v }));
  for (const emptyMeansAll of [true, false]) {
    const ui = await renderItems(env, { options, allLabel: "All campaigns", emptyMeansAll });
    const all = () => ui.row("All campaigns");
    assert.equal(all().getAttribute("aria-checked"), "true", "under All every row is ticked, All included");
    assert.equal(ui.row("Barometer").getAttribute("aria-checked"), "true");

    await ui.click(ui.row("Barometer"));
    assert.deepEqual(ui.state.value, ["Brand", "Display", "Search", "Social", "Video"], "unticking one row keeps the other 5");
    assert.equal(all().getAttribute("aria-checked"), "mixed", "All goes partial");

    await ui.click(all());
    assert.deepEqual(ui.state.value, emptyMeansAll ? [] : options.map(o => o.value), "a partial All ticks every row");

    const before = ui.state.emits;
    await ui.click(all());
    assert.equal(ui.state.emits, before, "a full All unticks every row and emits nothing (the draft)");
    assert.equal(all().getAttribute("aria-checked"), "false");
    assert.equal(ui.row("Video").getAttribute("aria-checked"), "false");

    await ui.click(ui.row("Search"));
    assert.deepEqual(ui.state.value, ["Search"], "from the draft, the first tick picks that row alone");
    await env.React.act(() => ui.root.unmount());
  }
});

test("FilterMenuItems: a group is a hover submenu that starts with All <group>", async t => {
  const env = await setup(t);
  if (!env) return;
  const ui = await renderItems(env, { options: TRAFFIC, allLabel: "All traffic" });
  const sub = ui.rows().find(r => r.getAttribute("aria-haspopup") === "menu");
  assert.ok(sub, "the Bots row is a radix SubTrigger (hover / ArrowRight opens it)");
  assert.match(sub.textContent, /Bots/);
  assert.equal(ui.row("GPTBot"), undefined, "the submenu stays closed until hovered");

  // The group's own box toggles the whole group without opening it.
  const box = sub.querySelector('[role="checkbox"][aria-label="All Bots"]');
  await ui.click(box);
  assert.deepEqual(ui.state.value, ["humans"], "unticking Bots drops both bots");
  assert.equal(box.getAttribute("aria-checked"), "false");

  // ArrowRight opens the submenu, as a hover does.
  await env.React.act(() => {
    sub.focus();
    sub.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
  assert.ok(ui.row("All Bots"), "the submenu starts with All Bots");
  await ui.click(ui.row("GPTBot"));
  assert.deepEqual(ui.state.value, ["humans", "gptbot"]);
  assert.equal(sub.querySelector('[role="checkbox"]').getAttribute("aria-checked"), "mixed", "a partly picked group shows a dash");

  // Only: that node alone.
  await ui.click(ui.row("GPTBot").querySelector(".mk-fm-only"));
  assert.deepEqual(ui.state.value, ["gptbot"]);
  await env.React.act(() => ui.root.unmount());
});

test("FilterMenu: the trigger reads All, the one pick, the picked parts, and keeps an unknown pick", async t => {
  const env = await setup(t);
  if (!env) return;
  const { React, client, win, menu, h } = env;
  const root = client.createRoot(win.document.getElementById("root"));
  const text = () => win.document.querySelector(".mk-ms-trigger .mk-ms-text").textContent;
  const render = value =>
    React.act(() => root.render(h(menu.FilterMenu, { label: "Traffic", options: TRAFFIC, selected: value, onChange: () => {}, allLabel: "All traffic" })));
  await render([]);
  assert.equal(text(), "All traffic");
  assert.equal(win.document.querySelector(".mk-ms-trigger").getAttribute("aria-label"), "Traffic");
  const probes = [...win.document.querySelectorAll(".mk-ms-probe")].map(p => p.textContent);
  assert.deepEqual(probes, ["All traffic", "Humans", "Bots"], "the trigger is sized to All and the top-level labels");
  await render(["gptbot", "bing"]);
  assert.equal(text(), "Bots", "a whole group reads as its label");
  await render(["humans", "gptbot"]);
  assert.equal(text(), "Humans + Bots: GPTBot");
  await render(["PT"]);
  assert.equal(text(), "PT", "a value the options don't list reads as itself, never as All");
  await React.act(() => root.unmount());
});
