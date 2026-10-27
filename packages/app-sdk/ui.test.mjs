import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatSeconds, normalizeTone, refreshOrder } from "./ui-core.js";

test("refreshOrder: first, then the rest by name, then last; skip drops", () => {
  const order = refreshOrder(
    ["b", "data_freshness_v3", "heavy_2", "a", "static_geo", "heavy_1"],
    { first: ["heavy_1", "heavy_2"], last: ["data_freshness*"], skip: ["static_geo"] },
  );
  assert.deepEqual(order, ["heavy_1", "heavy_2", "a", "b", "data_freshness_v3"]);
});

test("refreshOrder: no options sorts by name and keeps every binding", () => {
  assert.deepEqual(refreshOrder(["c", "a", "b"]), ["a", "b", "c"]);
});

test("normalizeTone accepts both vocabularies", () => {
  assert.equal(normalizeTone("green"), "ok");
  assert.equal(normalizeTone("amber"), "warn");
  assert.equal(normalizeTone("red"), "bad");
  assert.equal(normalizeTone("ok"), "ok");
  assert.equal(normalizeTone(undefined), "neutral");
});

test("formatSeconds", () => {
  assert.equal(formatSeconds(42), "42s");
  assert.equal(formatSeconds(75), "1m 15s");
});

test("ui.css styles every class ui.js renders", () => {
  const js = readFileSync(new URL("./ui.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");
  const used = new Set(js.match(/\bmk-[a-z-]+/g));
  // Built dynamically (mk-btn--${variant}, mk-tone-${t}); covered by the
  // concrete variants below.
  for (const prefix of ["mk-btn--", "mk-tone-"]) used.delete(prefix);
  for (const cls of ["mk-btn--outline", "mk-btn--primary", "mk-btn--ghost", "mk-tone-ok", "mk-tone-warn", "mk-tone-bad"]) {
    used.add(cls);
  }
  const unstyled = [...used].filter(cls => !css.includes(`.${cls}`));
  assert.deepEqual(unstyled, []);
});

test("the injected theme keeps every v1 token name", () => {
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("MAKO_THEME_TOKENS_CSS = `"));
  for (const name of [
    "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
    "primary", "primary-foreground", "secondary", "secondary-foreground", "muted",
    "muted-foreground", "accent", "accent-foreground", "destructive", "destructive-foreground",
    "border", "input", "ring", "chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "radius",
    "brand", "canvas", "positive", "warning", "negative",
  ]) {
    assert.match(block, new RegExp(`--${name}:`), `--${name} missing from the injected theme`);
  }
});

test("tooltipSeriesRows: a stack reads top segment first, lines highest first, empties dropped", async () => {
  const { tooltipSeriesRows } = await import("./ui-core.js");
  const series = [
    { key: "new", label: "New", color: "g" },
    { key: "exp", label: "Expansion", color: "lg" },
    { key: "react", label: "Reactivation", color: "b" },
  ];
  const datum = { new: 74438, exp: 0, react: 15359 };
  assert.deepEqual(tooltipSeriesRows(datum, series, { stacked: true }).map(r => r.key), ["react", "new"]);
  assert.deepEqual(tooltipSeriesRows({ new: 1, exp: 3, react: null }, series).map(r => r.label), ["Expansion", "New"]);
});

test("TableTooltip renders a table: swatch + label, cells, a total row under a rule", async t => {
  let React, server, ui;
  try {
    React = await import("react");
    server = await import("react-dom/server");
    ui = await import("./ui.js");
  } catch (e) {
    t.skip("react not installed here: " + e.message);
    return;
  }
  const html = server.renderToStaticMarkup(
    React.createElement(ui.TableTooltip, {
      title: "2026-06",
      columns: ["MRR", "% of start"],
      rows: [{ label: "New", color: "#0a0", cells: ["+€74,438", "4.9%"] }],
      total: { label: "Net", cells: ["+€25,720", "1.7%"] },
    }),
  );
  assert.match(html, /class="mk-tip"/);
  assert.match(html, /<th scope="row"><span class="mk-tip-swatch" style="background:#0a0"><\/span>New<\/th>/);
  assert.match(html, /<tr class="mk-tip-total mk-tip-rule">/);
  const content = ui.tableTooltip(d => ({ title: d.ym, rows: [] }));
  assert.equal(content({ active: false, payload: [] }), null);
  assert.ok(content({ active: true, payload: [{ payload: { ym: "2026-06" } }] }));
});
