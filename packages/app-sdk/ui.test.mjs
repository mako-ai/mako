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

test("tooltipSeriesRows: a stack reads top segment first, lines keep legend order, every series kept", async () => {
  const { tooltipSeriesRows } = await import("./ui-core.js");
  const series = [
    { key: "new", label: "New", color: "g" },
    { key: "exp", label: "Expansion", color: "lg" },
    { key: "react", label: "Reactivation", color: "b" },
  ];
  const datum = { new: 74438, exp: 0, react: 15359 };
  assert.deepEqual(tooltipSeriesRows(datum, series, { stacked: true }).map(r => r.key), ["react", "exp", "new"]);
  assert.deepEqual(tooltipSeriesRows({ new: 1, exp: 3, react: null }, series).map(r => r.label), ["New", "Expansion", "Reactivation"]);
});

test("tooltipSeriesRows: a zero and a missing value keep their rows; the row count never changes", async () => {
  const { tooltipSeriesRows, tooltipCellText } = await import("./ui-core.js");
  const series = [
    { key: "fr", label: "France" },
    { key: "es", label: "Spain" },
    { key: "it", label: "Italy" },
  ];
  const buckets = [
    { fr: 120, es: 0, it: undefined }, // one zero, one missing
    { fr: 0, es: null, it: Number.NaN },
    { fr: 3, es: 4, it: 5 },
    {},
  ];
  const counts = buckets.map(d => tooltipSeriesRows(d, series).length);
  assert.deepEqual(counts, [3, 3, 3, 3]);
  for (const d of buckets) {
    assert.deepEqual(tooltipSeriesRows(d, series).map(r => r.key), ["fr", "es", "it"]);
  }
  const rows = tooltipSeriesRows(buckets[0], series);
  assert.deepEqual(
    rows.map(r => [r.key, r.value, r.state]),
    [["fr", 120, "value"], ["es", 0, "zero"], ["it", null, "missing"]],
  );
  const fmt = v => `€${v}`;
  assert.deepEqual(rows.map(r => tooltipCellText(r.value, fmt)), [
    { text: "€120", muted: false },
    { text: "0", muted: true },
    { text: "–", muted: true },
  ]);
  assert.deepEqual(tooltipCellText(0, v => `${v * 100}%`, { percent: true }), { text: "0%", muted: true });
  assert.deepEqual(tooltipCellText(Infinity, String), { text: "–", muted: true });
  assert.deepEqual(tooltipCellText("", String), { text: "–", muted: true });
});

test("tooltipSeriesRows: hideEmpty and byValue restore the pre-2.15 behaviour", async () => {
  const { tooltipSeriesRows } = await import("./ui-core.js");
  const series = [
    { key: "new", label: "New" },
    { key: "exp", label: "Expansion" },
    { key: "react", label: "Reactivation" },
  ];
  const datum = { new: 74438, exp: 0, react: 15359 };
  assert.deepEqual(tooltipSeriesRows(datum, series, { stacked: true, hideEmpty: true }).map(r => r.key), ["react", "new"]);
  const old = { hideEmpty: true, byValue: true };
  assert.deepEqual(tooltipSeriesRows({ new: 1, exp: 3, react: null }, series, old).map(r => r.label), ["Expansion", "New"]);
  // byValue alone keeps every row: missing last, ties in legend order.
  assert.deepEqual(
    tooltipSeriesRows({ new: 2, exp: null, react: 2 }, series, { byValue: true }).map(r => r.key),
    ["new", "react", "exp"],
  );
});

test("TableTooltip: tooltipCell mutes a zero and a missing value, and every row renders", async t => {
  let React, server, ui;
  try {
    React = await import("react");
    server = await import("react-dom/server");
    ui = await import("./ui.js");
  } catch (e) {
    t.skip("react not installed here: " + e.message);
    return;
  }
  const series = [
    { key: "fr", label: "France", color: "#00f" },
    { key: "es", label: "Spain", color: "#f00" },
    { key: "it", label: "Italy", color: "#0f0" },
  ];
  const render = d =>
    server.renderToStaticMarkup(
      React.createElement(ui.TableTooltip, {
        title: "W45",
        columns: ["Leads", "% of total"],
        rows: ui.tooltipSeriesRows(d, series).map(r => ({
          ...r,
          cells: [ui.tooltipCell(r.value, String), ui.tooltipCell(r.value == null ? null : r.value / 120, v => `${Math.round(v * 100)}%`, { percent: true })],
        })),
        total: { label: "Total", cells: ["120", undefined] },
      }),
    );
  const html = render({ fr: 120, es: 0 });
  assert.equal((html.match(/<tr/g) ?? []).length, 1 + 3 + 1); // header, 3 series, total
  assert.match(html, /Spain<\/th><td><span class="mk-tip-muted">0<\/span><\/td><td><span class="mk-tip-muted">0%<\/span><\/td>/);
  assert.match(html, /Italy<\/th><td><span class="mk-tip-muted">–<\/span><\/td><td><span class="mk-tip-muted">–<\/span><\/td>/);
  assert.match(html, /France<\/th><td>120<\/td><td>100%<\/td>/);
  // An undefined cell shows a muted dash too.
  assert.match(html, /Total<\/th><td>120<\/td><td><span class="mk-tip-muted">–<\/span><\/td>/);
  assert.equal((render({}).match(/<tr/g) ?? []).length, 5);
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

const COLS = [
  { id: "name", label: "Customer", value: r => r.name },
  { id: "mrr", label: "MRR", num: true, value: r => r.mrr, csv: r => r.mrr ?? "" },
  { id: "note", label: "Note", value: r => r.note },
  { id: "links", label: "Links", value: () => null, csv: false },
];
const ROWS = [
  { id: 1, name: "beta", mrr: 200, note: 'says "hi", twice' },
  { id: 2, name: "Alpha", mrr: null, note: "=SUM(A1)" },
  { id: 3, name: "", mrr: 900, note: "line\nbreak" },
  { id: 4, name: "gamma", mrr: 50, note: null },
];

test("sortRows: text A→Z case-insensitive, numbers either way, empties last both ways", async () => {
  const { sortRows } = await import("./ui-core.js");
  const ids = sort => sortRows(ROWS, COLS, sort).map(r => r.id);
  assert.deepEqual(ids({ id: "name", dir: "asc" }), [2, 1, 4, 3]);
  assert.deepEqual(ids({ id: "name", dir: "desc" }), [4, 1, 2, 3]);
  assert.deepEqual(ids({ id: "mrr", dir: "desc" }), [3, 1, 4, 2]);
  assert.deepEqual(ids({ id: "mrr", dir: "asc" }), [4, 1, 3, 2]);
  assert.deepEqual(ids(null), [1, 2, 3, 4]);
  assert.deepEqual(sortRows([{ n: 10 }, { n: 9 }, { n: "" }], [{ id: "n", value: r => r.n }], { id: "n", dir: "asc" }).map(r => r.n), [9, 10, ""]);
});

test("nextSort: numbers start largest first, text A→Z, the same column flips", async () => {
  const { nextSort } = await import("./ui-core.js");
  assert.deepEqual(nextSort(null, COLS[1]), { id: "mrr", dir: "desc" });
  assert.deepEqual(nextSort({ id: "mrr", dir: "desc" }, COLS[0]), { id: "name", dir: "asc" });
  assert.deepEqual(nextSort({ id: "name", dir: "asc" }, COLS[0]), { id: "name", dir: "desc" });
});

test("pageSlice: 1-based, clamped, last page short", async () => {
  const { pageSlice } = await import("./ui-core.js");
  assert.deepEqual(pageSlice(312, 1, 50), { page: 1, pageCount: 7, start: 0, end: 50 });
  assert.deepEqual(pageSlice(312, 7, 50), { page: 7, pageCount: 7, start: 300, end: 312 });
  assert.deepEqual(pageSlice(312, 99, 50).page, 7);
  assert.deepEqual(pageSlice(312, 0, 50).page, 1);
  assert.deepEqual(pageSlice(0, 3, 50), { page: 1, pageCount: 1, start: 0, end: 0 });
});

test("toCsv: header labels, csv overrides, csv:false dropped, quotes, formulas guarded; TSV round-trip", async () => {
  const { toCsv, csvToTsv, parseCsv } = await import("./ui-core.js");
  const csv = toCsv(ROWS, COLS);
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], '"Customer","MRR","Note"');
  assert.equal(lines[1], '"beta","200","says ""hi"", twice"');
  assert.equal(lines[2], `"Alpha","","'=SUM(A1)"`);
  assert.deepEqual(parseCsv(csv)[3], ["", "900", "line\nbreak"]);
  const tsv = csvToTsv(csv).split("\n");
  assert.equal(tsv.length, 5);
  assert.equal(tsv[3], "\t900\tline break");
});

test("DataTable renders sortable headers, a pinned corner, the page and the pager", async t => {
  let React, server, ui;
  try {
    React = await import("react");
    server = await import("react-dom/server");
    ui = await import("./ui.js");
  } catch (e) {
    t.skip("react not installed here: " + e.message);
    return;
  }
  const rows = Array.from({ length: 312 }, (_, i) => ({ id: i, name: `Org ${i}`, mrr: i }));
  const columns = [
    { id: "name", label: "Customer", value: r => r.name, sticky: true },
    { id: "mrr", label: "MRR", num: true, value: r => r.mrr, render: r => `€${r.mrr}` },
  ];
  const html = server.renderToStaticMarkup(
    React.createElement(ui.DataTable, { rows, columns, noun: "customers", defaultSort: { id: "mrr", dir: "desc" }, page: 2, exportFilename: "orgs" }),
  );
  assert.match(html, /<th scope="col" class="mk-dt-pin" aria-sort="none"><button type="button" class="mk-dt-sort"/);
  assert.match(html, /<th scope="col" class="mk-dt-num mk-dt-sorted" aria-sort="descending"/);
  assert.match(html, /<td class="mk-dt-num"><div class="mk-dt-cell" title="261">€261<\/div><\/td>/); // page 2 of a desc sort starts at 311 - 50
  // Fixed widths: the colgroup sets them, the first column grows, the sum is the floor.
  assert.match(html, /<table class="mk-dt-table" style="min-width:336px"><colgroup><col\/><col style="width:96px"\/><\/colgroup>/);
  assert.match(html, /<span class="mk-dt-th-text">Customer<\/span><svg/);
  assert.match(html, /<b>51–100<\/b> of <b>312<\/b> customers/);
  assert.match(html, /Page 2 of 7/);
  assert.match(html, /<option value="50" selected="">50 per page<\/option>/);
  assert.match(html, /Export CSV/);
  const empty = server.renderToStaticMarkup(React.createElement(ui.DataTable, { columns, empty: "No customers yet.", fill: true }));
  assert.match(empty, /class="mk-card mk-dt mk-dt--fill"/);
  assert.match(empty, /<td colSpan="2" class="mk-dt-empty">No customers yet.<\/td>/i);
  assert.match(empty, /<colgroup><col\/><col style="width:96px"\/><\/colgroup>/); // same widths with no rows
  assert.match(empty, /No rows/);
  const clickable = server.renderToStaticMarkup(
    React.createElement(ui.DataTable, { rows: rows.slice(0, 2), columns, onRowClick: () => {}, rowLabel: r => `Open ${r.name}` }),
  );
  assert.match(clickable, /<tr tabindex="0" class="mk-dt-click" aria-label="Open Org 0">/i);
  const past = server.renderToStaticMarkup(React.createElement(ui.DataTable, { rows, columns, page: 99 }));
  assert.match(past, /Page 7 of 7/);
});

test("DataTable widths: overrides, defaults by kind, grow and calc floors", async t => {
  let React, server, ui;
  try {
    React = await import("react");
    server = await import("react-dom/server");
    ui = await import("./ui.js");
  } catch (e) {
    t.skip("react not installed here: " + e.message);
    return;
  }
  const columns = [
    { id: "name", label: "Customer", value: r => r.name, sticky: true, width: 200 },
    { id: "owner", label: "Owner", value: r => r.owner, grow: true, minWidth: "10rem" },
    { id: "since", label: "Since", value: r => r.since, date: true, sortable: false },
    { id: "mrr", label: "MRR", num: true, value: r => r.mrr },
    { id: "note", label: "Note", value: r => r.note, width: "12rem", truncate: false },
  ];
  const html = server.renderToStaticMarkup(
    React.createElement(ui.DataTable, { rows: [{ id: 1, name: "A very long customer name", owner: "Ann", since: "2026-01-01", mrr: 5, note: "n" }], columns }),
  );
  assert.match(
    html,
    /style="min-width:calc\(406px \+ 10rem \+ 12rem\)"><colgroup><col style="width:200px"\/><col\/><col style="width:110px"\/><col style="width:96px"\/><col style="width:12rem"\/><\/colgroup>/,
  );
  assert.match(html, /<div class="mk-dt-cell" title="A very long customer name">/);
  assert.match(html, /<div class="mk-dt-wrap">n<\/div>/);
  assert.match(html, /<span class="mk-dt-label" title="Since"><span class="mk-dt-th-text">Since<\/span><\/span>/);
  assert.doesNotMatch(html, /<th[^>]*style=/); // widths live on the colgroup only
});

test("columnLayout and defaultColumnWidth: defaults by kind, the first column grows", async () => {
  const { columnLayout, defaultColumnWidth } = await import("./ui-core.js");
  assert.equal(defaultColumnWidth({ num: true }, 0), 96);
  assert.equal(defaultColumnWidth({ align: "right" }), 96);
  assert.equal(defaultColumnWidth({ date: true }), 110);
  assert.equal(defaultColumnWidth({ sticky: true }, 3), 240);
  assert.equal(defaultColumnWidth({}, 0), 240);
  assert.equal(defaultColumnWidth({}, 2), 140);
  assert.deepEqual(columnLayout([{ id: "a" }, { id: "b" }, { id: "c", num: true }]), {
    cols: [{ id: "a", width: null }, { id: "b", width: "140px" }, { id: "c", width: "96px" }],
    minWidth: "476px",
  });
  assert.deepEqual(columnLayout([{ id: "a" }, { id: "b", grow: true, width: 300, minWidth: 180 }]), {
    cols: [{ id: "a", width: "240px" }, { id: "b", width: null }],
    minWidth: "420px",
  });
});

test("ui.css: the DataTable has a fixed layout and keeps the corner's two borders", () => {
  const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");
  assert.match(css, /\.mk-dt-table \{[^}]*table-layout: fixed/);
  assert.match(css, /thead th\.mk-dt-pin \{[^}]*inset -1px 0 0 var\(--border\), inset 0 -1px 0 var\(--border\)/);
  assert.match(css, /\.mk-dt-sort svg \{ flex: none; \}/);
});

test("ui.css: native selects get an inset chevron in a base layer the app can override", () => {
  const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");
  const layer = css.slice(css.indexOf("@layer base {"));
  assert.ok(css.includes("@layer base {"), "the select base sits in @layer base");
  const rule = /select:not\(\[multiple\], \[size\], \[class\*="appearance-none"\]\) \{([^}]*)\}/.exec(layer)?.[1];
  assert.ok(rule, "the single-line select rule exists");
  assert.match(rule, /appearance: none/);
  assert.match(rule, /height: 32px/);
  assert.match(rule, /padding: 0 28px 0 12px/);
  assert.match(rule, /font-size: 14px/);
  assert.match(rule, /var\(--muted-foreground\)/);
  assert.match(rule, /background-position: right 15px center, right 10px center/);
  assert.match(rule, /border-radius: var\(--mk-radius-md\)/);
  assert.match(layer, /\):focus-visible \{[^}]*box-shadow: var\(--mk-ring-focus\)/);
  assert.match(layer, /\):hover:not\(:disabled\) \{ background-color: var\(--accent\); \}/);
  // The pager select relies on the base: no second box of its own.
  assert.match(css, /\.mk-dt-size \{ margin-right: 8px; \}/);
});

test("DataTable: defaultPageSize 100 and a size outside the list", async t => {
  let React, server, ui;
  try {
    React = await import("react");
    server = await import("react-dom/server");
    ui = await import("./ui.js");
  } catch (e) {
    t.skip("react not installed here: " + e.message);
    return;
  }
  const rows = Array.from({ length: 312 }, (_, i) => ({ id: i, name: `Org ${i}` }));
  const columns = [{ id: "name", label: "Customer", value: r => r.name }];
  const hundred = server.renderToStaticMarkup(React.createElement(ui.DataTable, { rows, columns, defaultPageSize: 100 }));
  assert.match(hundred, /<option value="100" selected="">100 per page<\/option>/);
  assert.match(hundred, /<b>1–100<\/b> of <b>312<\/b>/);
  assert.match(hundred, /Page 1 of 4/);
  const odd = server.renderToStaticMarkup(React.createElement(ui.DataTable, { rows, columns, defaultPageSize: 200 }));
  assert.match(odd, /<option value="100">100 per page<\/option><option value="200" selected="">200 per page<\/option>/);
});

test("compareValues: numeric strings as numbers, bigints by value, text with digit runs", async () => {
  const { compareValues } = await import("./ui-core.js");
  assert.deepEqual(["1.5", "1.25", "-3", "-10"].sort(compareValues), ["-10", "-3", "1.25", "1.5"]);
  assert.deepEqual([3n, 2, 10n, -1, 9007199254740993n].sort(compareValues), [-1, 2, 3n, 10n, 9007199254740993n]);
  assert.ok(compareValues(9007199254740993n, 9007199254740992n) > 0);
  assert.deepEqual(["item 10", "item 9", "Item 1"].sort(compareValues), ["Item 1", "item 9", "item 10"]);
  assert.ok(compareValues("abc", " ") !== 0);
  assert.ok(compareValues(new Date(2026, 0, 2), new Date(2026, 0, 1)) > 0);
});

test("csvCell: numbers pass through, text formulas guarded", async () => {
  const { csvCell, toCsv } = await import("./ui-core.js");
  assert.equal(csvCell(-5), "-5");
  assert.equal(csvCell(-0.25), "-0.25");
  assert.equal(csvCell(-12n), "-12");
  assert.equal(csvCell("-5"), "-5");
  assert.equal(csvCell("-1.25e3"), "-1.25e3");
  assert.equal(csvCell(NaN), "");
  for (const s of ["=1+1", "+1+1", "-2+3+cmd|' /C calc'!A0", "@SUM(A1)", "\t=1", "\r=1", "-"]) {
    assert.equal(csvCell(s), "'" + s, JSON.stringify(s));
  }
  assert.equal(csvCell("plain"), "plain");
  const csv = toCsv([{ n: -5, s: "=HYPERLINK(1)" }], [{ id: "n", label: "N", value: r => r.n }, { id: "s", label: "S", value: r => r.s }]);
  assert.equal(csv.slice(1).split("\r\n")[1], `"-5","'=HYPERLINK(1)"`);
});

test("csvDate: local or UTC midnight is the day, anything else a UTC timestamp", async () => {
  const { csvDate, csvCell } = await import("./ui-core.js");
  assert.equal(csvDate(new Date(2026, 9, 27)), "2026-10-27");
  assert.equal(csvDate(new Date(Date.UTC(2026, 9, 27))), "2026-10-27");
  assert.equal(csvDate(new Date(Date.UTC(2026, 9, 27, 13, 5))), "2026-10-27T13:05:00.000Z");
  assert.equal(csvCell(new Date(NaN)), "");
});

test("pageToSync: reports a clamped page, never while there are no rows", async () => {
  const { pageToSync } = await import("./ui-core.js");
  assert.equal(pageToSync(3, 312, 50), null);
  assert.equal(pageToSync(9, 312, 50), 7);
  assert.equal(pageToSync(0, 312, 50), 1);
  assert.equal(pageToSync(3, 0, 50), null); // still loading: keep ?page=3
  assert.equal(pageToSync(1, 0, 50), null);
  assert.equal(pageToSync(3, 20, 50), 1); // filtered down to one page
});

test("serializeResetKey: same filters compare equal, new row objects never matter", async () => {
  const { serializeResetKey: k } = await import("./ui-core.js");
  assert.equal(k({ q: "a", owners: ["x"] }), k({ q: "a", owners: ["x"] }));
  assert.notEqual(k({ q: "a" }), k({ q: "ab" }));
  assert.equal(k(new Set(["a", "b"])), k(["a", "b"]));
  assert.equal(k({ n: 5n }), k({ n: 5n }));
  assert.equal(k(undefined), k(undefined));
});

test("multiSelectState: an empty value and a value with every option are both All, every option unticked", async () => {
  const { multiSelectState } = await import("./ui-core.js");
  const opts = ["CH", "ES", "IT"];
  assert.deepEqual(multiSelectState([], opts), { all: true, selected: [] });
  assert.deepEqual(multiSelectState(["IT", "CH", "ES"], opts), { all: true, selected: [] });
  assert.deepEqual(multiSelectState(["IT", "CH"], opts), { all: false, selected: ["CH", "IT"] });
  // A value the options don't list yet (still loading) is kept, not All.
  assert.deepEqual(multiSelectState(["PT"], []), { all: false, selected: ["PT"] });
});

test("multiSelectToggle: under All a click selects only that option; the last untick or tick returns to All", async () => {
  const { multiSelectToggle } = await import("./ui-core.js");
  const opts = ["CH", "ES", "IT"];
  // Under All, whichever way the app spells it.
  assert.deepEqual(multiSelectToggle([], opts, "ES"), ["ES"]);
  assert.deepEqual(multiSelectToggle(["CH", "ES", "IT"], opts, "ES"), ["ES"]);
  assert.deepEqual(multiSelectToggle(["CH", "ES", "IT"], opts, "ES", false), ["ES"]);
  // Plain toggles.
  assert.deepEqual(multiSelectToggle(["ES"], opts, "CH"), ["ES", "CH"]);
  assert.deepEqual(multiSelectToggle(["ES", "CH"], opts, "ES"), ["CH"]);
  // Back to All: [] by default, every value with emptyMeansAll false.
  assert.deepEqual(multiSelectToggle(["ES"], opts, "ES"), []);
  assert.deepEqual(multiSelectToggle(["ES"], opts, "ES", false), ["CH", "ES", "IT"]);
  assert.deepEqual(multiSelectToggle(["ES", "CH"], opts, "IT"), []);
  assert.deepEqual(multiSelectToggle(["ES", "CH"], opts, "IT", false), ["CH", "ES", "IT"]);
});

test("multiSelectText: the All label, the one label, or N selected", async () => {
  const { multiSelectText } = await import("./ui-core.js");
  const opts = [
    { value: "ch", label: "Switzerland" },
    { value: "es", label: "Spain" },
    { value: "it", label: "Italy" },
  ];
  assert.equal(multiSelectText([], opts, "All markets"), "All markets");
  assert.equal(multiSelectText(["ch", "es", "it"], opts, "All markets"), "All markets");
  assert.equal(multiSelectText(["es"], opts, "All markets"), "Spain");
  assert.equal(multiSelectText(["es", "it"], opts, "All markets"), "2 selected");
  assert.equal(multiSelectText(["es", "it"], opts, "All", n => `${n} markets`), "2 markets");
});

test("popover registry: opening one closes the other; closePopovers closes the open one", async () => {
  const { claimPopover, releasePopover, closePopovers } = await import("./ui-core.js");
  const closed = [];
  const country = () => closed.push("country");
  const route = () => closed.push("route");
  claimPopover(country);
  claimPopover(route); // Route opens while Country is open.
  assert.deepEqual(closed, ["country"]);
  claimPopover(route); // Re-claiming itself closes nothing.
  assert.deepEqual(closed, ["country"]);
  closePopovers(); // A Radix menu opens.
  assert.deepEqual(closed, ["country", "route"]);
  closePopovers(); // Nothing open: no-op.
  assert.deepEqual(closed, ["country", "route"]);
  claimPopover(country);
  releasePopover(route); // A stale release leaves Country registered.
  closePopovers();
  assert.deepEqual(closed, ["country", "route", "country"]);
  claimPopover(country);
  releasePopover(country);
  closePopovers();
  assert.equal(closed.length, 3);
});

test("usePopover closes on a capture-phase pointerdown and on focus outside, not on mousedown or click", () => {
  const js = readFileSync(new URL("./ui.js", import.meta.url), "utf8");
  const body = js.slice(js.indexOf("function usePopover"), js.indexOf("React.useLayoutEffect", js.indexOf("function usePopover")));
  assert.match(body, /addEventListener\("pointerdown", outside, true\)/);
  assert.match(body, /addEventListener\("focusin", outside, true\)/);
  assert.match(body, /claimPopover\(close\)/);
  assert.match(body, /releasePopover\(close\)/);
  assert.doesNotMatch(body, /"mousedown"|"click"/);
});

test("MultiSelect trigger: All for an empty or full value, the one label, N selected; Checkbox states", async t => {
  let React, server, ui;
  try {
    React = await import("react");
    server = await import("react-dom/server");
    ui = await import("./ui.js");
  } catch (e) {
    t.skip("react not installed here: " + e.message);
    return;
  }
  const h = React.createElement;
  const options = [
    { value: "ch", label: "Switzerland", color: "#f00" },
    { value: "es", label: "Spain" },
    { value: "it", label: "Italy" },
  ];
  const text = value => {
    const html = server.renderToStaticMarkup(
      h(ui.MultiSelect, { options, value, onChange() {}, allLabel: "All markets" }),
    );
    return html.match(/<span class="mk-ms-text">([^<]*)<\/span>/)[1];
  };
  assert.equal(text([]), "All markets");
  assert.equal(text(["ch", "es", "it"]), "All markets");
  assert.equal(text(["es"]), "Spain");
  assert.equal(text(["es", "it"]), "2 selected");
  assert.equal(typeof ui.closePopovers, "function");

  const box = checked => server.renderToStaticMarkup(h(ui.Checkbox, { checked }));
  assert.match(box(true), /class="mk-ms-box on"[^>]*><svg[^>]*><polyline/);
  assert.match(box("mixed"), /class="mk-ms-box on"[^>]*><svg[^>]*><line/);
  assert.match(box(false), /class="mk-ms-box"[^>]*><\/span>/);
});
