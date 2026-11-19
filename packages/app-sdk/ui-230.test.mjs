// SDK 2.30: DataTable server mode, column resizing, section rows and cell
// class/style; TableTooltip note and row rules; MultiSelect and FilterMenu
// `disabled`; `locale` on RefreshAllButton and FreshnessBadge. Every new
// prop is off by default, and the 2.29 fixtures render byte for byte.
// Skips where react or jsdom is not installed (the publish job runs
// `node --test` with no install).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { columnLayout, fromSorting, resizeWidth, splitSections, toSorting } from "./ui-core.js";
import { STRINGS } from "./locale.js";

async function env(t) {
  try {
    const React = await import("react");
    const server = await import("react-dom/server");
    const client = await import("react-dom/client");
    const { JSDOM } = await import("jsdom");
    const B = await import("./test-support/ui-baseline-2.29.mjs");
    const { win, restore } = B.setupDom(JSDOM);
    t.after(restore);
    const ui = await import("./ui.js");
    return { React, server, client, win, ui, B, h: React.createElement };
  } catch (e) {
    t.skip("react or jsdom not installed here: " + e.message);
    return null;
  }
}

async function mount(e, el) {
  e.win.document.body.innerHTML = "<div id=root></div>";
  const root = e.client.createRoot(e.win.document.getElementById("root"));
  await e.React.act(() => root.render(el));
  return {
    root,
    q: s => e.win.document.querySelector(s),
    qa: s => [...e.win.document.querySelectorAll(s)],
    rerender: el2 => e.React.act(() => root.render(el2)),
    unmount: () => e.React.act(() => root.unmount()),
  };
}

// ---------------------------------------------------------------------------
// Defaults: the 2.29.0 bytes
// ---------------------------------------------------------------------------

test("2.30 props left out or off: 16 fixtures render exactly as SDK 2.29.0", async t => {
  const e = await env(t);
  if (!e) return;
  const baseline = JSON.parse(readFileSync(new URL("./test-support/ui-baseline-2.29.json", import.meta.url), "utf8"));
  assert.equal(Object.keys(baseline).length, 16);
  const now = { ...e.B.renderServer(e.React, e.server, e.ui), ...(await e.B.renderOpen(e)) };
  for (const k of Object.keys(baseline)) assert.equal(now[k], baseline[k], k);
  const off = {
    table: {
      manualSorting: false, manualPagination: false, rowCount: undefined, sorting: undefined, onSortingChange: undefined,
      pagination: undefined, onPaginationChange: undefined, loading: false, enableColumnResizing: false,
      columnResizeMode: "onChange", columnSizing: undefined, onColumnSizingChange: undefined, isSectionRow: undefined, renderSection: undefined,
    },
    column: { size: undefined, minSize: 30, maxSize: 900, enableResizing: true, cellClassName: undefined, cellStyle: undefined },
    tooltip: { note: undefined },
    tipRow: { rule: false },
    control: { MultiSelect: { disabled: false }, FreshnessBadge: { locale: undefined }, RefreshAllButton: { locale: undefined } },
  };
  const offNow = { ...e.B.renderServer(e.React, e.server, e.ui, off), ...(await e.B.renderOpen(e, { FreshnessBadge: { locale: "en" }, RefreshAllButton: { locale: "en-GB" } })) };
  for (const k of Object.keys(baseline)) assert.equal(offNow[k], baseline[k], `${k}, props off`);
  // "en" spelled out is English too, and `note={null}` adds nothing.
  assert.equal(e.B.renderServer(e.React, e.server, e.ui, { tooltip: { note: null }, control: { FreshnessBadge: { locale: "en-US" } } })["tip-full"], baseline["tip-full"]);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("columnLayout: size is the width when width is unset; sizing wins and stops a dragged growing column", () => {
  const cols = [{ id: "a" }, { id: "b", size: 120 }, { id: "c", width: 80, size: 300 }];
  assert.deepEqual(columnLayout(cols), { cols: [{ id: "a", width: null }, { id: "b", width: "120px" }, { id: "c", width: "80px" }], minWidth: "440px" });
  assert.deepEqual(columnLayout(cols, {}), columnLayout(cols), "an empty sizing changes nothing");
  assert.deepEqual(columnLayout(cols, { b: 200 }).cols[1], { id: "b", width: "200px" });
  assert.equal(columnLayout(cols, { b: 200 }).fixed, undefined, "the first column still grows");
  const dragged = columnLayout(cols, { a: 300 });
  assert.deepEqual(dragged, { cols: [{ id: "a", width: "300px" }, { id: "b", width: "120px" }, { id: "c", width: "80px" }], minWidth: "500px", fixed: true });
});

test("resizeWidth clamps to minSize (default 20, TanStack's) and maxSize", () => {
  assert.equal(resizeWidth({}, 100, 37.6), 138);
  assert.equal(resizeWidth({}, 100, -500), 20);
  assert.equal(resizeWidth({ minSize: 60 }, 100, -500), 60);
  assert.equal(resizeWidth({ maxSize: 180 }, 100, 500), 180);
});

test("splitSections and the TanStack sorting shape", () => {
  const rows = ["x", "#A", "a1", "a2", "#B", "#C", "c1"];
  assert.deepEqual(splitSections(rows, r => r.startsWith("#")), [
    { section: null, rows: ["x"] },
    { section: "#A", rows: ["a1", "a2"] },
    { section: "#B", rows: [] },
    { section: "#C", rows: ["c1"] },
  ]);
  assert.deepEqual(fromSorting([{ id: "mrr", desc: true }, { id: "x", desc: false }]), { id: "mrr", dir: "desc" });
  assert.equal(fromSorting([]), null);
  assert.deepEqual(toSorting({ id: "mrr", dir: "asc" }), [{ id: "mrr", desc: false }]);
  assert.deepEqual(toSorting(null), []);
});

// ---------------------------------------------------------------------------
// 1. Server-side mode
// ---------------------------------------------------------------------------

const page = (from, n) => Array.from({ length: n }, (_, i) => ({ id: from + i, name: `Acc ${from + i}`, mrr: (from + i) % 7 }));
const COLS = [
  { id: "name", label: "Account", value: r => r.name },
  { id: "mrr", label: "MRR", num: true, value: r => r.mrr },
];

test("manual mode: rows render as given, the footer counts rowCount, clicks report TanStack state", async t => {
  const e = await env(t);
  if (!e) return;
  const sortings = [];
  const pagings = [];
  const props = {
    rows: page(50, 50), columns: COLS, manualSorting: true, manualPagination: true, rowCount: 312,
    sorting: [{ id: "mrr", desc: true }], onSortingChange: s => sortings.push(s),
    pagination: { pageIndex: 1, pageSize: 50 }, onPaginationChange: p => pagings.push(p), exportFilename: "x",
  };
  const m = await mount(e, e.h(e.ui.DataTable, props));
  const names = () => m.qa("tbody tr").map(tr => tr.cells[0].textContent);
  assert.equal(names().length, 50, "no slicing");
  assert.deepEqual(names().slice(0, 3), ["Acc 50", "Acc 51", "Acc 52"], "no sorting: the server's order");
  assert.match(m.q(".mk-dt-foot span").textContent, /^51–100 of 312 rows$/);
  assert.equal(m.q(".mk-dt-page").textContent, "Page 2 of 7");
  assert.equal(m.q("th[aria-sort=descending]")?.textContent, "MRR", "the controlled sorting shows on the header");
  assert.equal(m.q(".mk-card-actions button"), null, "no CSV export: the table holds one page");
  await e.React.act(() => m.qa("th .mk-dt-sort")[0].click());
  assert.deepEqual(sortings.at(-1), [{ id: "name", desc: false }]);
  assert.deepEqual(names().slice(0, 2), ["Acc 50", "Acc 51"], "a sort click never reorders");
  assert.deepEqual(pagings.at(-1), { pageIndex: 0, pageSize: 50 }, "a sort goes back to the first page");
  await e.React.act(() => m.q('[aria-label="Next page"]').click());
  assert.deepEqual(pagings.at(-1), { pageIndex: 2, pageSize: 50 });
  const select = m.q(".mk-dt-size");
  await e.React.act(() => {
    select.value = "100";
    select.dispatchEvent(new e.win.Event("change", { bubbles: true }));
  });
  assert.deepEqual(pagings.at(-1), { pageIndex: 0, pageSize: 100 }, "one call with the new size and page 0");
  const before = pagings.length;
  await m.rerender(e.h(e.ui.DataTable, { ...props, pagination: { pageIndex: 6, pageSize: 50 }, rows: page(300, 12) }));
  assert.match(m.q(".mk-dt-foot span").textContent, /^301–312 of 312 rows$/);
  assert.equal(m.q('[aria-label="Next page"]').disabled, true);
  assert.equal(pagings.length, before, "an in-range page reports nothing");
  await m.unmount();
});

test("manual mode with useState setters: TanStack's onSortingChange / onPaginationChange wiring works", async t => {
  const e = await env(t);
  if (!e) return;
  const { React, h } = e;
  let last;
  function Host() {
    const [sorting, setSorting] = React.useState([]);
    const [pagination, setPagination] = React.useState({ pageIndex: 0, pageSize: 25 });
    last = { sorting, pagination };
    return h(e.ui.DataTable, { rows: page(pagination.pageIndex * 25, 25), columns: COLS, manualSorting: true, manualPagination: true, rowCount: 100, sorting, onSortingChange: setSorting, pagination, onPaginationChange: setPagination, pageSizes: [25] });
  }
  const m = await mount(e, h(Host));
  await React.act(() => m.qa("th .mk-dt-sort")[1].click());
  assert.deepEqual(last.sorting, [{ id: "mrr", desc: true }], "a number column starts largest first");
  await React.act(() => m.q('[aria-label="Last page"]').click());
  assert.deepEqual(last.pagination, { pageIndex: 3, pageSize: 25 });
  assert.equal(m.qa("tbody tr")[0].cells[0].textContent, "Acc 75");
  await m.unmount();
});

test("loading: skeleton rows while there are none, dimmed rows while there are", async t => {
  const e = await env(t);
  if (!e) return;
  const html = p => e.server.renderToStaticMarkup(e.h(e.ui.DataTable, { columns: COLS, ...p }));
  const empty = html({ rows: [], loading: true, manualPagination: true, rowCount: 312 });
  assert.equal((empty.match(/class="mk-dt-skeleton-row"/g) ?? []).length, 10, "10 placeholder rows (at most the page size)");
  assert.equal((html({ rows: [], loading: true, defaultPageSize: 3, pageSizes: [3] }).match(/mk-dt-skeleton-row/g) ?? []).length, 3);
  assert.match(empty, /<tbody class="mk-dt-busy" aria-busy="true"><tr class="mk-dt-skeleton-row" aria-hidden="true"><td><span class="mk-dt-skeleton" style="width:45%"><\/span><\/td><td class="mk-dt-num">/);
  assert.ok(!empty.includes("No rows match"), "no empty message while loading");
  assert.match(empty, /<b>1–50<\/b> of <b>312<\/b> rows/, "the footer counts rowCount meanwhile");
  assert.match(html({ rows: [], loading: true }), /<span aria-live="polite"><\/span>/, "no 'No rows' while the first load runs");
  const busy = html({ rows: page(0, 3), loading: true });
  assert.match(busy, /<tbody class="mk-dt-busy" aria-busy="true"><tr><td>/);
  assert.ok(!busy.includes("mk-dt-skeleton"));
  const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");
  assert.match(css, /\.mk-dt-skeleton \{[^}]*background: var\(--accent\);[^}]*animation: mk-skeleton-pulse 2s cubic-bezier\(\.4, 0, \.6, 1\) infinite;/, "shadcn's Skeleton: bg-accent animate-pulse");
});

// ---------------------------------------------------------------------------
// 2. Column resizing
// ---------------------------------------------------------------------------

function pointer(e, el, type, clientX) {
  const ev = new e.win.MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
  Object.defineProperty(ev, "pointerId", { value: 1 });
  return e.React.act(() => el.dispatchEvent(ev));
}

test("resize onEnd (TanStack's default): the handle moves with the pointer, the width lands on release", async t => {
  const e = await env(t);
  if (!e) return;
  const sizings = [];
  const sorts = [];
  const cols = [{ id: "name", label: "Account", value: r => r.name }, { id: "mrr", label: "MRR", num: true, value: r => r.mrr, minSize: 60, maxSize: 200 }];
  const m = await mount(e, e.h(e.ui.DataTable, { rows: page(0, 3), columns: cols, enableColumnResizing: true, onColumnSizingChange: s => sizings.push(s), onSortChange: s => sorts.push(s) }));
  const handles = m.qa("th > .mk-dt-resizer");
  assert.equal(handles.length, 2);
  assert.equal(handles[1].getAttribute("role"), "separator");
  assert.equal(handles[1].getAttribute("tabindex"), null, "pointer only, as TanStack: not in the tab order");
  assert.equal(handles[1].title, "Drag to resize · double-click to reset");
  m.qa("th")[1].getBoundingClientRect = () => ({ width: 96 });
  await pointer(e, handles[1], "pointerdown", 500);
  assert.ok(e.win.document.body.classList.contains("mk-dt-col-resizing"));
  await pointer(e, handles[1], "pointermove", 540);
  // mid-drag: the handle is 40px right, the column is still 96px
  assert.equal(m.q(".mk-dt-resizer--active").style.transform, "translateX(40px)");
  assert.equal(sizings.length, 0);
  assert.equal(m.qa("col")[1].style.width, "96px");
  await pointer(e, handles[1], "pointermove", 900);
  await pointer(e, handles[1], "pointerup", 900);
  assert.deepEqual(sizings, [{ mrr: 200 }], "clamped to maxSize, reported once");
  assert.equal(m.qa("col")[1].style.width, "200px");
  assert.equal(m.q(".mk-dt-resizer--active"), null);
  assert.ok(!e.win.document.body.classList.contains("mk-dt-col-resizing"));
  await e.React.act(() => handles[1].click());
  assert.equal(sorts.length, 0, "a click on the handle never sorts");
  await e.React.act(() => handles[1].dispatchEvent(new e.win.MouseEvent("dblclick", { bubbles: true })));
  assert.deepEqual(sizings.at(-1), {}, "a double click resets the column (TanStack's resetSize)");
  assert.equal(m.qa("col")[1].style.width, "96px");
  await m.unmount();
});

test("resize onChange: the width follows the pointer; a dragged growing column makes the table exactly its columns", async t => {
  const e = await env(t);
  if (!e) return;
  const cols = [{ id: "name", label: "Account", value: r => r.name, minSize: 100 }, { id: "mrr", label: "MRR", num: true, value: r => r.mrr, enableResizing: false }];
  const m = await mount(e, e.h(e.ui.DataTable, { rows: page(0, 3), columns: cols, enableColumnResizing: true, columnResizeMode: "onChange" }));
  assert.equal(m.qa("th > .mk-dt-resizer").length, 1, "enableResizing: false has no handle");
  assert.equal(m.qa("th")[0].className, "mk-dt-resizable");
  m.qa("th")[0].getBoundingClientRect = () => ({ width: 240 });
  const handle = m.q(".mk-dt-resizer");
  await pointer(e, handle, "pointerdown", 100);
  await pointer(e, handle, "pointermove", 130);
  assert.equal(m.qa("col")[0].style.width, "270px", "live while dragging");
  assert.equal(m.q("table").style.width, "366px", "no growing column left: the table is the sum");
  await pointer(e, handle, "pointermove", -400);
  assert.equal(m.qa("col")[0].style.width, "100px", "minSize");
  await pointer(e, handle, "pointerup", -400);
  await m.unmount();
});

test("resize: a controlled columnSizing sets the widths; the sort button keeps its focus and keys", async t => {
  const e = await env(t);
  if (!e) return;
  const html = e.server.renderToStaticMarkup(e.h(e.ui.DataTable, { rows: page(0, 2), columns: COLS, enableColumnResizing: true, columnSizing: { mrr: 150 } }));
  assert.match(html, /<col style="width:150px"\/>/);
  assert.match(html, /<th scope="col" class="mk-dt-resizable" aria-sort="none"><button type="button" class="mk-dt-sort"/, "the sort button comes first, unchanged");
  const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");
  assert.match(css, /\.mk-dt-resizer \{ position: absolute;[^}]*cursor: col-resize; touch-action: none;/);
});

// ---------------------------------------------------------------------------
// 3. Section rows
// ---------------------------------------------------------------------------

const SECT = [
  { id: "h-in", name: "Inbound", section: true },
  { id: 1, name: "Paid search", mrr: 3 },
  { id: 2, name: "Organic", mrr: 9 },
  { id: 3, name: "Paid social", mrr: 5 },
  { id: "h-out", name: "Outbound", section: true },
  { id: 4, name: "SDR", mrr: 1 },
  { id: 5, name: "BDR", mrr: 7 },
];

test("section rows: one cell across the columns; rows sort inside their section; out of the pager, footer and total", async t => {
  const e = await env(t);
  if (!e) return;
  const totals = [];
  const props = {
    rows: SECT, columns: COLS, isSectionRow: r => !!r.section, defaultSort: { id: "mrr", dir: "desc" }, rowKey: r => r.id,
    totalRow: rs => (totals.push(rs.length), { id: "t", name: "Total", mrr: rs.reduce((s, r) => s + r.mrr, 0) }),
  };
  const html = e.server.renderToStaticMarkup(e.h(e.ui.DataTable, props));
  const order = [...html.matchAll(/<tr[^>]*>(?:<td[^>]*>)(?:<div class="mk-dt-(?:section-label|cell)"[^>]*>)([^<]*)/g)].map(m => m[1]);
  assert.deepEqual(order, ["Inbound", "Organic", "Paid social", "Paid search", "Outbound", "BDR", "SDR", "Total"]);
  assert.match(html, /<tr class="mk-dt-section-row"><td colSpan="2"><div class="mk-dt-section-label">Inbound<\/div><\/td><\/tr>/);
  assert.match(html, /<b>1–5<\/b> of <b>5<\/b> rows/, "5 rows, not 7");
  assert.deepEqual(totals, [5], "totalRow gets the data rows only");
  assert.match(html, /<td class="mk-dt-num">25<\/td>|<div class="mk-dt-cell" title="25">25<\/div>/);
  // Page 2 of 2-row pages: the Outbound heading repeats above its rows.
  const p2 = e.server.renderToStaticMarkup(e.h(e.ui.DataTable, { ...props, defaultSort: null, pageSize: 2, page: 2, renderSection: r => `§ ${r.name}` }));
  const p2order = [...p2.matchAll(/<div class="mk-dt-(?:section-label|cell)"[^>]*>([^<]*)/g)].map(m => m[1]);
  assert.deepEqual(p2order, ["§ Inbound", "Paid social", "5", "§ Outbound", "SDR", "1", "Total", "25"]);
});

test("section rows stay out of the CSV", async t => {
  const e = await env(t);
  if (!e) return;
  let blob;
  const orig = URL.createObjectURL;
  URL.createObjectURL = b => ((blob = b), "blob:x");
  t.after(() => (URL.createObjectURL = orig));
  e.win.HTMLAnchorElement.prototype.click = () => {};
  const m = await mount(e, e.h(e.ui.DataTable, { rows: SECT, columns: COLS, isSectionRow: r => !!r.section, exportFilename: "channels" }));
  await e.React.act(() => m.q(".mk-card-actions button").click());
  const text = await blob.text();
  assert.equal(text.trim().split(/\r?\n/).length, 6, "a header and 5 rows");
  assert.ok(!text.includes("Inbound") && !text.includes("Outbound"));
  await m.unmount();
});

// ---------------------------------------------------------------------------
// 4. Cell class and style
// ---------------------------------------------------------------------------

test("cellClassName and cellStyle get the value and the row; the total row keeps the column's class only", async t => {
  let React, server, ui;
  try {
    React = await import("react");
    server = await import("react-dom/server");
    ui = await import("./ui.js");
  } catch (e) {
    t.skip("react not installed here: " + e.message);
    return;
  }
  {
    const seen = [];
    const cols = [
      { id: "name", label: "Agency", value: r => r.name, cellClassName: "who" },
      { id: "share", label: "Share", num: true, value: r => r.share, cellClassName: (v, r) => (seen.push([v, r.name]), v > 0.5 ? "heat hot" : "heat"), cellStyle: v => ({ background: `rgba(82,125,242,${v})` }) },
    ];
    const html = server.renderToStaticMarkup(React.createElement(ui.DataTable, { rows: [{ id: 1, name: "A", share: 0.8 }, { id: 2, name: "B", share: 0.2 }], columns: cols, totalRow: { id: "t", name: "All", share: 1 } }));
    assert.match(html, /<td class="who"><div class="mk-dt-cell" title="A">A<\/div><\/td><td class="mk-dt-num heat hot" style="background:rgba\(82,125,242,0.8\)">/);
    assert.match(html, /<td class="mk-dt-num heat" style="background:rgba\(82,125,242,0.2\)">/);
    assert.match(html, /<tfoot><tr class="mk-dt-total"><td><div class="mk-dt-cell" title="All">All<\/div><\/td><td class="mk-dt-num">/);
    assert.deepEqual(seen, [[0.8, "A"], [0.2, "B"]]);
  }
});

// ---------------------------------------------------------------------------
// 6. TableTooltip
// ---------------------------------------------------------------------------

test("TableTooltip: note under the table, rule on any row", async t => {
  const e = await env(t);
  if (!e) return;
  const html = e.server.renderToStaticMarkup(
    e.h(e.ui.TableTooltip, {
      title: "Mar 2026",
      rows: [{ label: "Starting MRR", cells: [100] }, { label: "Ending MRR", cells: [120], rule: true }],
      total: { label: "Net", cells: [20] },
      note: "Click to list the opportunities",
    }),
  );
  assert.match(html, /<tr class="mk-tip-rule"><th scope="row"><span class="mk-tip-swatch" style="background:transparent"><\/span>Ending MRR/);
  assert.match(html, /<\/table><div class="mk-tip-note">Click to list the opportunities<\/div><\/div>$/);
  const totalAlone = e.server.renderToStaticMarkup(e.h(e.ui.TableTooltip, { total: { label: "Net", cells: [1], rule: true } }));
  assert.match(totalAlone, /<tr class="mk-tip-total mk-tip-rule">/, "a total with rule: true gets its rule without rows above");
});

// ---------------------------------------------------------------------------
// 5. MultiSelect / FilterMenu disabled
// ---------------------------------------------------------------------------

test("MultiSelect disabled: a disabled trigger that never opens, shadcn's disabled look; an open menu closes", async t => {
  const e = await env(t);
  if (!e) return;
  const props = { options: ["CH", "FR"], value: [], onChange() {}, "aria-label": "Market" };
  const m = await mount(e, e.h(e.ui.MultiSelect, { ...props, disabled: true }));
  const trigger = m.q(".mk-ms-trigger");
  assert.equal(trigger.disabled, true, "a disabled <button>: out of the tab order");
  await e.React.act(() => trigger.click());
  assert.equal(m.q(".mk-ms-menu"), null);
  await m.rerender(e.h(e.ui.MultiSelect, { ...props, disabled: false }));
  await e.React.act(() => m.q(".mk-ms-trigger").click());
  assert.ok(m.q(".mk-ms-menu"), "enabled again: it opens");
  await m.rerender(e.h(e.ui.MultiSelect, { ...props, disabled: true }));
  assert.equal(m.q(".mk-ms-menu"), null, "disabling closes it");
  await m.unmount();
  const css = readFileSync(new URL("./ui.css", import.meta.url), "utf8");
  assert.match(css, /\.mk-ms-trigger:disabled \{ pointer-events: none; opacity: \.5; \}/);
});

// ---------------------------------------------------------------------------
// 7. locale on RefreshAllButton and FreshnessBadge
// ---------------------------------------------------------------------------

test("RefreshAllButton and FreshnessBadge in French: every text from the strings table", async t => {
  const e = await env(t);
  if (!e) return;
  const fr = STRINGS.fr.refresh;
  const m = await mount(e, e.h(e.ui.RefreshAllButton, { bindings: ["b", "a"], locale: "fr-CH", refresh: () => new Promise(() => {}) }));
  assert.equal(m.q(".mk-refresh").textContent, "Actualiser");
  assert.equal(m.q(".mk-refresh").title, fr.hint);
  await e.React.act(() => m.q(".mk-refresh").click());
  assert.equal(m.q(".mk-rf-title").textContent, "Actualiser les données");
  assert.equal(m.q(".mk-rf-desc").textContent, "Relance 2 requêtes dans l'entrepôt (3 à la fois) et met l'app à jour à chaque résultat.");
  assert.deepEqual(m.qa(".mk-rf-foot button").map(b => b.textContent), ["Annuler", "Lancer l'actualisation"]);
  assert.equal(m.q(".mk-rf-x").getAttribute("aria-label"), "Fermer");
  await e.React.act(() => m.qa(".mk-rf-foot button")[1].click());
  assert.equal(m.q(".mk-refresh").textContent, "Actualisation 0/2…");
  assert.equal(m.q(".mk-rf-meta span").textContent, "0 sur 2 reconstruites");
  assert.deepEqual(m.qa(".mk-rf-state").map(s => s.textContent), ["En cours", "En cours"]);
  await m.unmount();
  const b = await mount(e, e.h(e.ui.FreshnessBadge, { headline: "À jour", title: "Données de 09:05", sources: [{ label: "Close" }], locale: "fr-CH" }));
  await e.React.act(() => b.q(".mk-fresh-trigger").click());
  assert.equal(b.q(".mk-fresh-pop").getAttribute("aria-label"), "Fraîcheur des données");
  assert.equal(b.q(".mk-fresh-sources").getAttribute("aria-label"), "Sources");
  await b.unmount();
});

test("FilterMenu disabled: Radix's disabled trigger, never opens; MultiSelect and FilterMenu off render as 2.28", async t => {
  let JSDOM, esbuild;
  try {
    ({ JSDOM } = await import("jsdom"));
    esbuild = await import("esbuild");
    await import("react");
  } catch (e) {
    t.skip("esbuild, react or jsdom not installed here: " + e.message);
    return;
  }
  const { loadKit, renderCases } = await import("./test-support/locale-baseline-2.28.mjs");
  let loaded;
  try {
    loaded = await loadKit(new URL("./", import.meta.url), { JSDOM, esbuild });
  } catch (e) {
    t.skip("radix-ui or a peer is not installed here: " + e.message);
    return;
  }
  t.after(loaded.restore);
  const [React, client] = await Promise.all([import("react"), import("react-dom/client")]);
  const { kit, win } = loaded;
  const baseline = JSON.parse(readFileSync(new URL("./test-support/locale-baseline-2.28.json", import.meta.url), "utf8"));
  const off = await renderCases({ React, client, win, kit }, { filter: { disabled: false } });
  for (const name of Object.keys(baseline).filter(n => /^(ms|fm)-/.test(n))) assert.equal(off[name], baseline[name], `${name}, disabled: false`);
  win.document.body.innerHTML = "<div id=root></div>";
  const root = client.createRoot(win.document.getElementById("root"));
  await React.act(() => root.render(React.createElement(kit.FilterMenu, { options: [{ value: "a", label: "A" }], onChange() {}, label: "Traffic", disabled: true })));
  const trigger = win.document.querySelector(".mk-ms-trigger");
  assert.equal(trigger.disabled, true);
  assert.equal(trigger.getAttribute("data-disabled"), "");
  await React.act(async () => {
    trigger.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger.click();
  });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(win.document.querySelector("[role=menu]"), null);
  await React.act(() => root.unmount());
});

test("RefreshAllButton without locale: the 2.29 English through a run, a failure and the summary", async t => {
  const e = await env(t);
  if (!e) return;
  let fail;
  const m = await mount(e, e.h(e.ui.RefreshAllButton, { bindings: ["b", "a"], concurrency: 1, refresh: name => new Promise((res, rej) => (name === "a" ? res() : (fail = rej))) }));
  assert.equal(m.q(".mk-refresh").title, "Re-runs every binding's warehouse query.");
  await e.React.act(() => m.q(".mk-refresh").click());
  await e.React.act(() => m.qa(".mk-rf-foot button")[1].click());
  assert.equal(m.q(".mk-rf-title").textContent, "Refreshing data…");
  assert.equal(m.q(".mk-rf-desc").textContent, "You can close this — the refresh keeps running in the background.");
  assert.equal(m.q(".mk-refresh").title, "Refresh in progress — click to see details.");
  assert.deepEqual(m.qa(".mk-rf-state").map(s => s.textContent), ["0s", "Running"]);
  assert.equal(m.q(".mk-rf-meta span").textContent, "1 of 2 rebuilt");
  assert.equal(m.q(".mk-rf-foot button").textContent, "Hide");
  await e.React.act(async () => fail(new Error("boom")));
  assert.equal(m.q(".mk-refresh").textContent, "1/2 refreshed");
  assert.equal(m.q(".mk-rf-title").textContent, "Refresh finished with errors");
  assert.equal(m.q(".mk-rf-desc").textContent, "Failed sources keep serving their previous data.");
  assert.deepEqual(m.qa(".mk-rf-state").map(s => s.textContent), ["0s", "Failed"]);
  assert.deepEqual(m.qa(".mk-rf-foot button").map(b => b.textContent), ["Refresh again", "Done"]);
  assert.equal(m.q(".mk-rf-x").getAttribute("aria-label"), "Close");
  await m.unmount();
});

test("FilterField in the phone sheet: one CSS rule stretches every trigger, no markup change", () => {
  const css = readFileSync(new URL("./tailwind.css", import.meta.url), "utf8");
  assert.match(css, /@media \(width < 769px\) \{\n  \[data-slot="filter-bar"\]\[data-open\] \[data-slot="filter-field"\] :is\(\.mk-ms-trigger, \[data-slot="select-trigger"\], \[data-slot="combobox-trigger"\]\) \{\n    width: 100%;/);
});

test("PeriodPicker 'all' preset: min to today, labelled in 7 languages; null without min", async t => {
  let P;
  try {
    const esbuild = await import("esbuild");
    const out = await esbuild.build({ entryPoints: [new URL("./components/period.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", write: false });
    P = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
  } catch (e) {
    t.skip("esbuild not installed here: " + e.message);
    return;
  }
  assert.deepEqual(P.presetPeriod("all", "2026-11-19", "2024-01-01"), { unit: "custom", from: "2024-01-01", to: "2026-11-19", preset: "all" });
  assert.equal(P.presetPeriod("all", "2026-11-19"), null);
  assert.equal(P.periodLabel(P.presetPeriod("all", "2026-11-19", "2024-01-01")), "All time");
  assert.equal(P.presetLabel("all", "fr-CH"), "Toute la période");
  assert.equal(P.presetLabel("all", "de-CH"), "Gesamter Zeitraum");
  for (const lang of Object.keys(STRINGS)) assert.equal(typeof STRINGS[lang].period.allTime, "string", lang);
  const prev = P.shift(P.presetPeriod("all", "2026-11-19", "2024-01-01"), -1);
  assert.ok(prev.to < "2024-01-01", "‹ lands before min, so the picker disables it");
});
