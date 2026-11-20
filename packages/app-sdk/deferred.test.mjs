// @makoai/app-sdk/components (2.31): Deferred, Staged and useStagedMount, moved here from five app-local copies.
// The render tests bundle the TSX with esbuild and skip without esbuild, react, jsdom, clsx or
// tailwind-merge (the publish job runs `node --test` with no install); the source checks always run.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

const SRC = readFileSync(new URL("./components/deferred.tsx", import.meta.url), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("deferred: exported from /components, one copy", () => {
  const index = readFileSync(new URL("./components/index.ts", import.meta.url), "utf8");
  assert.match(index, /export \* from "\.\/deferred"/);
  assert.match(SRC, /export \{ Deferred, Staged, useStagedMount \}/);
});

test("deferred: the copies' numbers (800px 0px margin, one frame then one task per Staged panel)", () => {
  assert.match(SRC, /rootMargin = "800px 0px"/);
  assert.match(SRC, /frame = requestAnimationFrame\(\(\) => \{[\s\S]*?window\.setTimeout\(cb, 0\)/);
  assert.match(SRC, /FRAME_FALLBACK_MS = 100/);
  assert.match(SRC, /aria-busy="true"/);
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
  const keys = ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "IntersectionObserver"];
  const saved = [...keys, "requestAnimationFrame", "cancelAnimationFrame"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  for (const k of keys) Object.defineProperty(globalThis, k, { value: k === "window" ? win : win[k], configurable: true, writable: true });
  globalThis.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });
  const outdir = new URL("./node_modules/.cache/deferred-test/", import.meta.url);
  mkdirSync(outdir, { recursive: true });
  const out = await esbuild.build({
    entryPoints: [new URL("./components/deferred.tsx", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    jsx: "automatic",
    write: false,
    external: ["react", "react-dom", "react/jsx-runtime", "clsx", "tailwind-merge"],
  });
  const file = new URL(`deferred-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`, outdir);
  writeFileSync(file, out.outputFiles[0].text);
  const mod = await import(file.href);
  const root = client.createRoot(win.document.getElementById("root"));
  const mount = (el) => React.act(() => root.render(el));
  // Real time passes outside act, so each frame commits on its own (act would batch them into one flush).
  const wait = async (ms) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    await sleep(ms);
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  };
  return { React, win, mod, h: React.createElement, mount, wait, root };
}

/** An IntersectionObserver that records its options and fires on demand. */
function fakeIO() {
  const all = [];
  class IO {
    constructor(cb, opts) {
      this.cb = cb;
      this.opts = opts;
      this.disconnected = false;
      all.push(this);
    }
    observe(el) {
      this.el = el;
    }
    disconnect() {
      this.disconnected = true;
    }
    fire(isIntersecting) {
      this.cb([{ isIntersecting, target: this.el }]);
    }
  }
  return { IO, all };
}

test("deferred: mounts on intersection and keeps the height of the placeholder until then", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { React, win, mod, h, mount } = env;
  const io = fakeIO();
  globalThis.IntersectionObserver = io.IO;
  await mount(h(mod.Deferred, { minHeight: 300 }, h("p", { id: "panel" }, "loaded")));
  const slot = () => win.document.querySelector('[data-slot="deferred"]');
  assert.ok(slot(), "placeholder renders");
  assert.equal(slot().style.minHeight, "300px", "placeholder keeps the panel height");
  assert.ok(slot().querySelector('[aria-busy="true"]'), "placeholder is an aria-busy Skeleton");
  assert.equal(win.document.getElementById("panel"), null, "children wait");
  assert.equal(io.all.length, 1);
  assert.equal(io.all[0].opts.rootMargin, "800px 0px");
  await React.act(() => io.all[0].fire(false));
  assert.equal(win.document.getElementById("panel"), null, "not near the viewport: still waiting");
  await React.act(() => io.all[0].fire(true));
  assert.ok(win.document.getElementById("panel"), "near the viewport: mounted");
  assert.equal(slot(), null, "placeholder gone");
  assert.ok(io.all[0].disconnected, "observer released");
  await mount(h(mod.Deferred, { minHeight: 300 }, h("p", { id: "panel" }, "loaded")));
  assert.ok(win.document.getElementById("panel"), "stays mounted after a re-render");
});

test("deferred: rootMargin, a string minHeight, a custom placeholder and placeholder={false}", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { win, mod, h, mount } = env;
  const io = fakeIO();
  globalThis.IntersectionObserver = io.IO;
  await mount(
    h(
      "div",
      null,
      h(mod.Deferred, { minHeight: "40vh", rootMargin: "200px" }, "a"),
      h(mod.Deferred, { minHeight: 10, placeholder: h("i", { id: "mine" }) }, "b"),
      h(mod.Deferred, { minHeight: 10, placeholder: false }, "c"),
    ),
  );
  const slots = [...win.document.querySelectorAll('[data-slot="deferred"]')];
  assert.equal(slots.length, 3);
  assert.equal(slots[0].style.minHeight, "40vh");
  assert.equal(io.all[0].opts.rootMargin, "200px");
  assert.ok(slots[1].querySelector("#mine") && !slots[1].querySelector("[aria-busy]"), "custom placeholder replaces the Skeleton");
  assert.equal(slots[2].children.length, 0, "false leaves a blank spacer");
  assert.equal(slots[2].style.minHeight, "10px", "the spacer still holds the height");
});

test("deferred: without IntersectionObserver it mounts one task later, not in the first commit", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { win, mod, h, mount, wait } = env;
  delete globalThis.IntersectionObserver;
  await mount(h(mod.Deferred, { minHeight: 120 }, h("p", { id: "panel" }, "loaded")));
  assert.equal(win.document.getElementById("panel"), null, "first commit shows the placeholder");
  assert.equal(win.document.querySelector('[data-slot="deferred"]').style.minHeight, "120px");
  await wait(20);
  assert.ok(win.document.getElementById("panel"), "one task later the panel is there");
});

test('deferred: mode="task" mounts one task later even where IntersectionObserver exists', async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { win, mod, h, mount, wait } = env;
  const io = fakeIO();
  globalThis.IntersectionObserver = io.IO;
  await mount(h(mod.Deferred, { minHeight: 50, mode: "task" }, h("p", { id: "panel" }, "x")));
  assert.equal(win.document.getElementById("panel"), null);
  await wait(20);
  assert.ok(win.document.getElementById("panel"));
  assert.equal(io.all.length, 0, "no observer created");
});

test("staged: panels mount one per frame, in mount order, behind a placeholder of their height", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { React, win, mod, h, mount, wait } = env;
  const log = [];
  const Mark = ({ id }) => {
    React.useEffect(() => {
      log.push({ id, at: performance.now() });
    }, [id]);
    return h("p", { id }, id);
  };
  await mount(
    h(
      "div",
      null,
      ...["a", "b", "c"].map((id, i) => h(mod.Staged, { key: id, minHeight: 100 + i }, h(Mark, { id }))),
    ),
  );
  const slots = [...win.document.querySelectorAll('[data-slot="staged"]')];
  assert.equal(slots.length, 3, "3 placeholders on the first commit");
  assert.deepEqual(slots.map((s) => s.style.minHeight), ["100px", "101px", "102px"]);
  assert.ok(slots.every((s) => s.querySelector('[aria-busy="true"]')));
  assert.equal(log.length, 0, "nothing mounted in the first commit");
  await wait(250);
  assert.deepEqual(log.map((l) => l.id), ["a", "b", "c"], "mount order");
  assert.ok(log[1].at - log[0].at >= 5 && log[2].at - log[1].at >= 5, "each panel on its own frame, not one commit");
  assert.equal(win.document.querySelectorAll('[data-slot="staged"]').length, 0, "placeholders gone");
});

test("staged: in a hidden tab (requestAnimationFrame never fires) a 100 ms timer still mounts the panels, in order", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { win, mod, h, mount, wait } = env;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  Object.defineProperty(win.document, "visibilityState", { value: "hidden", configurable: true });
  await mount(h("div", null, ...["a", "b"].map((id) => h(mod.Staged, { key: id, minHeight: 50 }, h("p", { id }, id)))));
  await wait(60);
  assert.equal(win.document.getElementById("a"), null, "not before the fallback delay");
  await wait(120);
  assert.ok(win.document.getElementById("a"), "first panel after about 100 ms");
  assert.equal(win.document.getElementById("b"), null, "second panel waits for its own turn");
  await wait(150);
  assert.ok(win.document.getElementById("b"), "second panel after about 200 ms");
});

test("staged: frames slower than 100 ms still mount 1 panel per frame, none before the first frame (2.31.1)", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { React, mod, h, mount, wait } = env;
  // A visible tab under load: each frame takes 150 ms, longer than the hidden-tab timer.
  let frames = 0;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => (frames++, cb(performance.now())), 150);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const at = [];
  const Mark = ({ id }) => {
    React.useEffect(() => {
      at.push(frames);
    }, [id]);
    return h("p", { id }, id);
  };
  await mount(h("div", null, ...["a", "b", "c"].map((id) => h(mod.Staged, { key: id, minHeight: 10 }, h(Mark, { id })))));
  await wait(700);
  assert.equal(at.length, 3, "all 3 panels mount");
  assert.ok(at[0] >= 1, `first panel waits for a painted frame (mounted after frame ${at[0]})`);
  assert.equal(new Set(at).size, 3, `1 mount per frame: frames ${at.join(", ")}`);
});

test("staged: a tab hidden while waiting for a frame switches to the 100 ms timer", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { win, mod, h, mount, wait } = env;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  await mount(h(mod.Staged, { minHeight: 10 }, h("p", { id: "a" }, "a")));
  await wait(150);
  assert.equal(win.document.getElementById("a"), null, "visible tab: no timer, waits for the frame");
  Object.defineProperty(win.document, "visibilityState", { value: "hidden", configurable: true });
  win.document.dispatchEvent(new win.Event("visibilitychange"));
  await wait(150);
  assert.ok(win.document.getElementById("a"), "hidden tab: the timer mounts it");
});

test("staged: a panel unmounted before its turn spends no frame", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { win, mod, h, mount, wait } = env;
  const real = globalThis.requestAnimationFrame;
  let frames = 0;
  globalThis.requestAnimationFrame = (cb) => (frames++, real(cb));
  const panel = (id) => h(mod.Staged, { key: id, minHeight: 10 }, h("p", { id }, id));
  await mount(h("div", null, panel("a"), panel("b"), panel("c")));
  await mount(h("div", null, panel("a"), panel("c")));
  await wait(300);
  assert.ok(win.document.getElementById("a") && win.document.getElementById("c"));
  assert.equal(win.document.getElementById("b"), null);
  assert.equal(frames, 2, "2 frames for 2 live panels; the unmounted one took none");
});

test("useStagedMount: steps 0 to count, one per frame, then stops", async (t) => {
  const env = await setup(t);
  if (!env) return;
  const { React, mod, h, mount, wait } = env;
  const seen = [];
  const App = () => {
    const step = mod.useStagedMount(3);
    seen.push(step);
    return h("p", null, step);
  };
  await mount(h(App));
  await wait(250);
  assert.deepEqual([...new Set(seen)], [0, 1, 2, 3], "every step once, in order");
  const n = seen.length;
  await wait(60);
  assert.equal(seen.length, n, "no renders after the last step");
});
