// Pure helpers behind @makoai/app-sdk/ui — no React, so `node --test` can
// cover them without installing anything.

const TONE_ALIASES = {
  green: "ok",
  ok: "ok",
  fresh: "ok",
  amber: "warn",
  warn: "warn",
  warning: "warn",
  stale: "warn",
  red: "bad",
  bad: "bad",
  error: "bad",
  loading: "loading",
};

/** ok | warn | bad | loading | neutral, from either vocabulary. */
export function normalizeTone(tone) {
  return TONE_ALIASES[tone] ?? "neutral";
}

function matches(patterns, name) {
  return patterns.findIndex(p => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name));
}

/**
 * The order a refresh runs in: `first` (slowest/heaviest, so they overlap the
 * light ones), then everything else by name, then `last` (e.g. the freshness
 * snapshot, so the badge reflects the rebuilt data). Patterns ending in `*`
 * match a prefix. `skip` drops bindings that must not be rebuilt on demand.
 */
export function refreshOrder(bindings, { first = [], last = [], skip = [] } = {}) {
  const rank = name => {
    const l = matches(last, name);
    if (l >= 0) return 1000 + l;
    const f = matches(first, name);
    return f >= 0 ? f : 500;
  };
  return [...bindings]
    .filter(name => matches(skip, name) < 0)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** 75 → "1m 15s", 42 → "42s". */
export function formatSeconds(s) {
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/**
 * The rows a chart tooltip shows for one hovered datum, in the order the eye
 * reads the chart: a stack top segment first (series are given bottom-up, the
 * order they are drawn), lines highest first. Empty (null, undefined, 0)
 * values are left out. Returns `{ key, label, color, value }`.
 */
export function tooltipSeriesRows(datum, series, { stacked = false } = {}) {
  const rows = series
    .map(s => ({ key: s.key, label: s.label ?? s.key, color: s.color, value: datum?.[s.key] }))
    .filter(r => r.value != null && r.value !== 0 && !Number.isNaN(Number(r.value)));
  return stacked ? rows.reverse() : rows.sort((a, b) => Number(b.value) - Number(a.value));
}

// ---------------------------------------------------------------------------
// Data tables: sort, page and CSV, without React
// ---------------------------------------------------------------------------

/** null, undefined, "" and NaN sort last both ways and export as an empty cell. */
const isEmpty = v => v == null || v === "" || (typeof v === "number" && Number.isNaN(v));
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Compare two cell values ascending: numbers and dates by value, text A→Z. */
export function compareValues(a, b) {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (typeof x === "number" && typeof y === "number") return x - y;
  if (typeof x === "boolean" && typeof y === "boolean") return Number(x) - Number(y);
  return collator.compare(String(x), String(y));
}

/**
 * The direction a column sorts in on its first click: numbers largest first
 * (`num: true`), text A→Z.
 */
export function firstSortDir(column) {
  return column?.num ? "desc" : "asc";
}

/** The sort after a header click: the same column flips, a new one starts at its first direction. */
export function nextSort(sort, column) {
  if (sort && sort.id === column.id) return { id: column.id, dir: sort.dir === "asc" ? "desc" : "asc" };
  return { id: column.id, dir: firstSortDir(column) };
}

/**
 * A sorted copy of `rows` by the column `sort.id` (its `value(row)`), stable,
 * empty values last in both directions. No sort or an unknown column returns
 * the rows in their given order.
 */
export function sortRows(rows, columns, sort) {
  const col = sort && columns.find(c => c.id === sort.id);
  if (!col) return rows.slice();
  const sign = sort.dir === "desc" ? -1 : 1;
  return rows
    .map((row, i) => ({ row, i, v: col.value(row) }))
    .sort((a, b) => {
      const ea = isEmpty(a.v);
      const eb = isEmpty(b.v);
      if (ea || eb) return ea && eb ? a.i - b.i : ea ? 1 : -1;
      return compareValues(a.v, b.v) * sign || a.i - b.i;
    })
    .map(x => x.row);
}

/**
 * Paging math for `total` rows. `page` is 1-based and clamped into range.
 * Returns `{ page, pageCount, start, end }`: rows `start` (inclusive) to
 * `end` (exclusive) are on the page.
 */
export function pageSlice(total, page, pageSize) {
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (p - 1) * size;
  return { page: p, pageCount, start, end: Math.min(start + size, total) };
}

// A leading = + - @ would run as a formula in a spreadsheet: the apostrophe keeps it text.
const csvSafe = v => {
  const t = isEmpty(v) ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
};
const csvHeader = c => (typeof c.label === "string" || typeof c.label === "number" ? String(c.label) : c.id);

/**
 * The rows as CSV text: a header row of column labels, then one line per row
 * from each column's `csv(row)` (or `value(row)`); columns with `csv: false`
 * are left out. Every cell is quoted, a byte-order mark keeps Excel on UTF-8,
 * and a cell starting with = + - @ gets a leading apostrophe.
 */
export function toCsv(rows, columns) {
  const cols = columns.filter(c => c.csv !== false);
  const table = [cols.map(csvHeader), ...rows.map(r => cols.map(c => (typeof c.csv === "function" ? c.csv(r) : c.value(r))))];
  return "﻿" + table.map(line => line.map(v => '"' + csvSafe(v).replace(/"/g, '""') + '"').join(",")).join("\r\n") + "\r\n";
}

/** Parse CSV text (quoted or not, CRLF or LF) into rows of cells. */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += ch;
  }
  if (cell !== "" || row.length) row.push(cell), rows.push(row);
  return rows;
}

/** CSV text as tab-separated lines, which paste into spreadsheet columns. */
export function csvToTsv(text) {
  return parseCsv(text)
    .map(r => r.map(v => v.replace(/[\t\r\n]+/g, " ")).join("\t"))
    .join("\n");
}
