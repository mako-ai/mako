// The fixtures behind ui-baseline-2.29.json: DataTable (every 2.27-2.29
// option), TableTooltip, MultiSelect, FreshnessBadge and RefreshAllButton,
// rendered by SDK 2.29.0 before the 2.30 props existed. Server markup for
// all of them, plus the open states (FreshnessBadge panel, RefreshAllButton
// modal) in jsdom. The 2.30 test renders them again with the new props left
// out or set to their off value and expects the same bytes.
// Regenerate only on purpose, from a 2.29.0 copy of the package:
//   node test-support/ui-baseline-2.29.mjs [path to 2.29.0 app-sdk] > test-support/ui-baseline-2.29.json
import { pathToFileURL } from "node:url";

const ROWS = Array.from({ length: 60 }, (_, i) => ({ id: i, name: `Org ${i}`, country: ["FR", "ES", "IT"][i % 3], mrr: (i * 37) % 101, days: (i * 13) % 40 }));
const COLS = [
  { id: "name", label: "Customer", value: r => r.name, sticky: true },
  { id: "country", label: "Country", value: r => r.country, align: "center", width: 90, info: "Where the office is" },
  { id: "mrr", label: "MRR", num: true, value: r => r.mrr, render: r => `€${r.mrr}` },
  { id: "days", label: "Renewal in", num: true, value: r => r.days, sortDescFirst: false },
];
const GROUPED = [
  { id: "name", label: "Customer", value: r => r.name, sticky: true },
  { id: "country", label: "Country", value: r => r.country, group: "where" },
  { id: "mrr", label: "MRR", num: true, value: r => r.mrr, group: "money", grow: true, minWidth: 120 },
];
const total = rs => ({ id: "total", name: "Total", country: "", mrr: rs.reduce((s, r) => s + r.mrr, 0), days: null });

/** name → DataTable props. `extra.table` and `extra.column` are spread on top in the 2.30 test. */
export function tableCases() {
  return {
    "dt-plain": { rows: ROWS, columns: COLS },
    "dt-sorted-p2": { rows: ROWS, columns: COLS, defaultSort: { id: "days", dir: "asc" }, page: 2, pageSize: 25, noun: "customers" },
    "dt-wrap-expand-total": {
      rows: ROWS.slice(0, 8), columns: COLS, wrapHeaders: true, renderExpanded: r => `Detail ${r.name}`, canExpand: r => r.id % 2 === 0,
      defaultExpanded: { 2: true }, totalRow: total, onTotalRowClick: () => {}, exportFilename: "x", exportTotalRow: true,
    },
    "dt-grouped-click": { rows: ROWS.slice(0, 5), columns: GROUPED, groups: [{ id: "money", label: "Money" }], onRowClick: () => {}, rowLabel: r => `Open ${r.name}`, rowClassName: r => (r.mrr > 50 ? "hot" : undefined), fill: true, maxHeight: 300 },
    "dt-locale-fr": { rows: Array.from({ length: 1234 }, (_, i) => ({ id: i, name: `Org ${i}`, mrr: i })), columns: COLS.slice(0, 1).concat(COLS[2]), locale: "fr-CH", exportFilename: "x", title: "Clients", description: "Tous" },
    "dt-empty": { rows: [], columns: COLS, noun: "customers", totalRow: total },
  };
}

const TIP_ROWS = [
  { label: "New", color: "#2563eb", cells: [1200, 4, null] },
  { label: "Churn", color: "#dc2626", cells: [-300, "", 0] },
];
/** name → TableTooltip props. */
export function tooltipCases() {
  return {
    "tip-full": { title: "March 2026", columns: ["MRR", "Orgs", "%"], rows: TIP_ROWS, total: { label: "Net", cells: [900, 3, "75%"] }, after: [{ label: "Average", cells: [450, null, null] }, { label: "Median", cells: [400, null, null] }], colWidth: 64 },
    "tip-rows": { rows: TIP_ROWS, className: "x", colWidth: "9ch" },
    "tip-total-only": { title: "Q1", total: { label: "All", color: "#000", cells: [1] } },
  };
}

const FB = {
  tone: "warn", headline: "2h old", title: "Data as of 09:05", meta: "2h ago", schedule: "Rebuilt at 06:30",
  sources: [{ key: "a", label: "Close", note: "CRM", value: "09:05", tone: "ok" }, { label: "Stripe", detail: "Late", tone: "bad" }],
  action: "Load latest", footer: "Times in Zurich",
};
/** name → [component, props]. */
export function controlCases() {
  return {
    "ms-closed": ["MultiSelect", { options: ["CH", "FR", "ES"], value: ["CH"], onChange() {}, "aria-label": "Market" }],
    "fb-closed": ["FreshnessBadge", FB],
    "fb-empty": ["FreshnessBadge", { headline: "Checking…", tone: "loading" }],
    "rf-closed": ["RefreshAllButton", { bindings: ["b", "a", "fresh"], last: ["fresh"], schedule: "Data also refreshes at 06:30." }],
    "rf-none": ["RefreshAllButton", { bindings: [] }],
  };
}

/** Server markup of every case. `extra` = { table, column, tooltip, row, control: { [component]: props } }. */
export function renderServer(React, server, ui, extra = {}) {
  const h = React.createElement;
  const out = {};
  for (const [name, props] of Object.entries(tableCases())) {
    const columns = props.columns.map(c => ({ ...c, ...extra.column }));
    const rows = extra.row ? props.rows.map(r => ({ ...r, ...extra.row })) : props.rows;
    out[name] = server.renderToStaticMarkup(h(ui.DataTable, { ...props, rows, columns, ...extra.table }));
  }
  for (const [name, props] of Object.entries(tooltipCases())) {
    const tipRow = r => ({ ...r, ...extra.tipRow });
    const p = { ...props, rows: props.rows?.map(tipRow), total: props.total && tipRow(props.total), after: props.after?.map(tipRow), ...extra.tooltip };
    if (!props.rows) delete p.rows;
    if (!props.after) delete p.after;
    out[name] = server.renderToStaticMarkup(h(ui.TableTooltip, p));
  }
  for (const [name, [comp, props]] of Object.entries(controlCases())) {
    out[name] = server.renderToStaticMarkup(h(ui[comp], { ...props, ...extra.control?.[comp] }));
  }
  return out;
}

/** The open states in jsdom: the badge's panel and the refresh modal, after a click on their trigger. */
export async function renderOpen({ React, client, win, ui }, extra = {}) {
  const h = React.createElement;
  const out = {};
  const open = {
    "fb-open": [h(ui.FreshnessBadge, { ...FB, ...extra.FreshnessBadge }), ".mk-fresh-trigger"],
    "rf-open": [h(ui.RefreshAllButton, { bindings: ["b", "a"], refresh: async () => {}, ...extra.RefreshAllButton }), ".mk-refresh"],
  };
  for (const [name, [el, sel]] of Object.entries(open)) {
    win.document.body.innerHTML = "<div id=root></div>";
    const root = client.createRoot(win.document.getElementById("root"));
    await React.act(() => root.render(el));
    await React.act(() => win.document.querySelector(sel).click());
    out[name] = win.document.body.innerHTML;
    await React.act(() => root.unmount());
  }
  return out;
}

/** jsdom globals for renderOpen. Returns the window and a restore function. */
export function setupDom(JSDOM) {
  const dom = new JSDOM("<!doctype html><body><div id=root></div></body>");
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const keys = ["window", "document", "Node", "Element", "HTMLElement", "MouseEvent", "KeyboardEvent", "Event"];
  const saved = keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  for (const k of keys) Object.defineProperty(globalThis, k, { value: k === "window" ? win : win[k], configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    win,
    restore() {
      for (const [k, d] of saved) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
      delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = pathToFileURL((process.argv[2] ?? new URL("../", import.meta.url).pathname).replace(/\/?$/, "/"));
  const { JSDOM } = await import("jsdom");
  const { win, restore } = setupDom(JSDOM);
  const [React, server, client] = await Promise.all([import("react"), import("react-dom/server"), import("react-dom/client")]);
  const ui = await import(new URL("ui.js", root).href);
  const out = { ...renderServer(React, server, ui), ...(await renderOpen({ React, client, win, ui })) };
  restore();
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}
