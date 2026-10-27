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

const isNumeric = v => typeof v === "number" || typeof v === "bigint";
const isNumericString = v => typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));

/**
 * Compare two cell values ascending: numbers, bigints and dates by value (a
 * bigint against a number too), two numeric strings ("1.5", "-10") as
 * numbers, booleans false first, everything else as text A→Z with digit runs
 * in numeric order.
 */
export function compareValues(a, b) {
  let x = a instanceof Date ? a.getTime() : a;
  let y = b instanceof Date ? b.getTime() : b;
  if (isNumericString(x) && isNumericString(y)) (x = Number(x)), (y = Number(y));
  if (isNumeric(x) && isNumeric(y)) return x < y ? -1 : x > y ? 1 : 0;
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

/** Default column widths in px, by kind: see `defaultColumnWidth`. */
export const COLUMN_WIDTHS = { num: 96, date: 110, first: 240, text: 140 };

/** A width as CSS: a number is px, a string passes through ("12rem", "20%"). */
export function cssLength(v) {
  return typeof v === "number" ? `${v}px` : v;
}

/**
 * A column's width when it sets none: numbers (`num` or right-aligned) 96px,
 * dates (`date`) 110px, the first or sticky column 240px, other text 140px.
 */
export function defaultColumnWidth(column, index = 1) {
  if (column?.num || column?.align === "right") return COLUMN_WIDTHS.num;
  if (column?.date) return COLUMN_WIDTHS.date;
  if (column?.sticky || index === 0) return COLUMN_WIDTHS.first;
  return COLUMN_WIDTHS.text;
}

/**
 * The fixed layout of a DataTable: one `<col>` width per column and the
 * table's minimum width (their sum). Every column is exactly its `width`
 * (default `defaultColumnWidth`). The flexible columns (`grow: true`, else the
 * first column) take the space left when the card is wider than the sum; their
 * floor is `minWidth`, else their width. Widths never depend on the rows, so
 * sorting, filtering and paging never move a column.
 * Returns `{ cols: [{ id, width: CSS length | null (flexible) }], minWidth }`.
 */
export function columnLayout(columns) {
  const anyGrow = columns.some(c => c.grow);
  let px = 0;
  const other = [];
  const cols = columns.map((c, i) => {
    const grow = anyGrow ? !!c.grow : i === 0;
    const base = c.width ?? defaultColumnWidth(c, i);
    const floor = grow ? (c.minWidth ?? base) : base;
    if (typeof floor === "number") px += floor;
    else other.push(floor);
    return { id: c.id, width: grow ? null : cssLength(base) };
  });
  const minWidth = other.length ? `calc(${[`${px}px`, ...other].join(" + ")})` : `${px}px`;
  return { cols, minWidth };
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

/**
 * The page to report back when the requested page is out of range, so a
 * controlled page (in the URL) matches what the table shows. null when the
 * requested page is fine, or while there are no rows yet (still loading), so
 * `?page=3` survives the first render.
 */
export function pageToSync(requested, total, pageSize) {
  if (!(total > 0)) return null;
  const { page } = pageSlice(total, requested, pageSize);
  return page === requested ? null : page;
}

/**
 * A `resetKey` as a comparable string: JSON, with Sets and Maps as arrays and
 * bigints as text. Two keys that serialise the same are the same filters.
 */
export function serializeResetKey(key) {
  if (key === undefined) return "";
  try {
    return JSON.stringify(key, (_, v) =>
      v instanceof Set ? [...v] : v instanceof Map ? [...v.entries()] : typeof v === "bigint" ? `${v}n` : v,
    );
  } catch {
    return String(key);
  }
}

const pad2 = n => String(n).padStart(2, "0");

/**
 * A Date as CSV text: a date at local midnight is that local day
 * (YYYY-MM-DD), a date at UTC midnight (how DuckDB hands over a DATE) is that
 * UTC day, anything else is the full ISO timestamp in UTC.
 */
export function csvDate(d) {
  if (Number.isNaN(d.getTime())) return "";
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  const iso = d.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

const PLAIN_NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/**
 * One cell as CSV text. Numbers, bigints and plain numeric text ("-5",
 * "-1.25e3") pass through as they are. Other text starting with = + - @ tab
 * or CR would run as a formula in a spreadsheet, so it gets a leading
 * apostrophe.
 */
export function csvCell(v) {
  if (isEmpty(v)) return "";
  if (isNumeric(v)) return String(v);
  if (v instanceof Date) return csvDate(v);
  const t = String(v);
  if (PLAIN_NUMBER.test(t)) return t;
  return /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
}
const csvHeader = c => (typeof c.label === "string" || typeof c.label === "number" ? String(c.label) : c.id);

/**
 * The rows as CSV text: a header row of column labels, then one line per row
 * from each column's `csv(row)` (or `value(row)`); columns with `csv: false`
 * are left out. Every cell is quoted, a byte-order mark keeps Excel on UTF-8,
 * and cells go through `csvCell` (numbers as is, text formulas guarded, dates
 * as `csvDate`).
 */
export function toCsv(rows, columns) {
  const cols = columns.filter(c => c.csv !== false);
  const table = [cols.map(csvHeader), ...rows.map(r => cols.map(c => (typeof c.csv === "function" ? c.csv(r) : c.value(r))))];
  return "﻿" + table.map(line => line.map(v => '"' + csvCell(v).replace(/"/g, '""') + '"').join(",")).join("\r\n") + "\r\n";
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
