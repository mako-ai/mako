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
 * What a tooltip cell holds: "missing" (null, undefined, "", NaN, ±Infinity:
 * no data, or a metric the bucket cannot compute), "zero", or "value".
 */
export function tooltipValueState(v) {
  if (v == null || v === "") return "missing";
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  if (!Number.isFinite(n)) return "missing";
  return n === 0 ? "zero" : "value";
}

/**
 * The rows a chart tooltip shows for one hovered datum: every series, in a
 * fixed order, so the tooltip keeps its height and columns while the pointer
 * moves. A stack reads top segment first (series are given bottom-up, the
 * order they are drawn); other charts keep the series (legend) order. A zero
 * stays as a row with `state: "zero"`; a missing value stays with
 * `value: null` and `state: "missing"`. Render the cells with `tooltipCell`.
 *
 * `absentAsZero: true` counts a null or absent key as 0: a stack segment
 * with no rows in a bucket that has data shows a muted "0", not "–". NaN and
 * ±Infinity stay missing. `share: true` adds `share` to every row: its value
 * over the sum of the non-missing values, null when the value is missing or
 * the sum is not above 0. Render it with `tooltipCell(r.share, fmtPct,
 * { percent: true })`: a zero share shows a muted "0%".
 *
 * Opt-outs, for a caller that truly needs the pre-2.15 behaviour:
 * `hideEmpty: true` drops zero and missing rows; `byValue: true` sorts
 * non-stacked rows highest value first (missing last).
 * Returns `{ key, label, color, value, state }`, plus `share` with `share: true`.
 */
export function tooltipSeriesRows(
  datum,
  series,
  { stacked = false, hideEmpty = false, byValue = false, absentAsZero = false, share = false } = {},
) {
  let rows = series.map(s => {
    const raw = absentAsZero && datum?.[s.key] == null ? 0 : datum?.[s.key];
    const state = tooltipValueState(raw);
    return { key: s.key, label: s.label ?? s.key, color: s.color, value: state === "missing" ? null : Number(raw), state };
  });
  if (share) {
    const total = rows.reduce((a, r) => a + (r.value ?? 0), 0);
    rows = rows.map(r => ({ ...r, share: r.value == null || !(total > 0) ? null : r.value / total }));
  }
  if (hideEmpty) rows = rows.filter(r => r.state === "value");
  if (stacked) return rows.reverse();
  if (!byValue) return rows;
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (a.r.value == null || b.r.value == null) return a.r.value == null ? (b.r.value == null ? a.i - b.i : 1) : -1;
      return b.r.value - a.r.value || a.i - b.i;
    })
    .map(x => x.r);
}

/**
 * The text a tooltip value cell shows, and whether it is muted: a missing
 * value → muted "–", a zero → muted "0" ("0%" with `percent`), else
 * `format(value)`.
 */
export function tooltipCellText(value, format = String, { percent = false } = {}) {
  const state = tooltipValueState(value);
  if (state === "missing") return { text: "–", muted: true };
  if (state === "zero") return { text: percent ? "0%" : "0", muted: true };
  return { text: format(Number(value)), muted: false };
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
 * A DataTable's column groups: each run of adjacent columns with the same
 * `group` is one group, spanning those columns in the header's top row. A
 * column with no `group` is its own run (`group: null`) and spans both header
 * rows. `start` marks a run that follows a column that is not pinned: it
 * draws the line between sections. Returns null when no column has a `group`
 * (a one-row header).
 * Returns `[{ group: string | null, start: boolean, columns: [column, …] }]`.
 */
export function columnGroupRuns(columns) {
  if (!columns.some(c => c.group != null)) return null;
  const runs = [];
  columns.forEach((col, i) => {
    const group = col.group ?? null;
    const last = runs[runs.length - 1];
    if (group != null && last?.group === group) last.columns.push(col);
    else runs.push({ group, start: i > 0 && !columns[i - 1].sticky, columns: [col] });
  });
  return runs;
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

// ---------------------------------------------------------------------------
// MultiSelect: the All rule and the trigger text
// ---------------------------------------------------------------------------

/**
 * Where a MultiSelect stands. Nothing is filtered when the value is empty or
 * holds every option: `all` is true and `selected` is empty, so the All row
 * is ticked and every option row unticked. Otherwise `selected` is the value
 * in option order (values the options don't list yet are kept at the end).
 */
export function multiSelectState(value, optionValues) {
  const picked = [...new Set(value ?? [])];
  const covers = optionValues.length > 0 && optionValues.every(v => picked.includes(v));
  if (picked.length === 0 || covers) return { all: true, selected: [] };
  const known = optionValues.filter(v => picked.includes(v));
  return { all: false, selected: [...known, ...picked.filter(v => !optionValues.includes(v))] };
}

/** The value that means "All": [] by default, every option when `emptyMeansAll` is false. */
export function multiSelectAll(optionValues, emptyMeansAll = true) {
  return emptyMeansAll ? [] : [...optionValues];
}

/**
 * The next value after a click on option `v`. Under All, the click selects
 * only `v`. Otherwise it toggles `v`; unticking the last option or ticking
 * the last missing one returns to All.
 */
export function multiSelectToggle(value, optionValues, v, emptyMeansAll = true) {
  const { all, selected } = multiSelectState(value, optionValues);
  if (all) return optionValues.length === 1 ? multiSelectAll(optionValues, emptyMeansAll) : [v];
  const next = selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v];
  return multiSelectState(next, optionValues).all ? multiSelectAll(optionValues, emptyMeansAll) : next;
}

/**
 * The trigger text: the All label, the one selected option's label, or
 * "N selected" (or `many(n)`).
 */
export function multiSelectText(value, options, allLabel = "All", many = n => `${n} selected`) {
  const { all, selected } = multiSelectState(value, options.map(o => o.value));
  if (all) return allLabel;
  if (selected.length === 1) return options.find(o => o.value === selected[0])?.label ?? selected[0];
  return many(selected.length);
}

// ---------------------------------------------------------------------------
// Filter trees (2.20): the model behind FilterItems and MultiSelect
// ---------------------------------------------------------------------------
// Options form a tree ({ value, label, children? }); a flat list is a one-level
// tree. A selection is a list of leaf values, and [] means every leaf (All).
// Groups never sit in a selection: a group is ticked when all its leaves are.
// `none` is the open menu's "nothing ticked" draft: a click on a full All
// unticks every row. It emits nothing (an empty filter still means
// everything): the data keeps its selection until a row is ticked.

/** Every leaf value under `options`, in menu order. */
export function filterLeaves(options) {
  return options.flatMap(o => (o.children ? filterLeaves(o.children) : [o.value]));
}

/** The leaves under a node (a leaf is its own). */
export function filterLeavesOf(node) {
  return node.children ? filterLeaves(node.children) : [node.value];
}

/** The node with `value` anywhere in the tree. */
export function filterFind(options, value) {
  for (const o of options) {
    if (o.value === value) return o;
    const hit = o.children && filterFind(o.children, value);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * A selection in menu order; [] when it holds every leaf. Values the options
 * don't list (a URL pick before its options load, or one the current date
 * range lacks) are kept at the end, so the trigger never reads "All" over
 * filtered data and the next tick does not drop them.
 */
export function filterNormalize(options, picked) {
  const set = new Set(picked);
  const leaves = filterLeaves(options);
  const known = new Set(leaves);
  const out = leaves.filter(v => set.has(v));
  const unknown = [...set].filter(v => !known.has(v));
  if (leaves.length > 0 && out.length === leaves.length && !unknown.length) return [];
  return [...out, ...unknown];
}

/** A node's tick: "on" when every leaf under it is picked, "mixed" when some are, "off" when none (or in the draft). */
export function filterTick(node, selected, none = false) {
  const ls = filterLeavesOf(node);
  // A group with no children yet (still loading) picks nothing: never "on".
  if (none || !ls.length) return "off";
  if (!selected.length) return "on";
  const on = ls.filter(v => selected.includes(v)).length;
  return on === ls.length ? "on" : on ? "mixed" : "off";
}

/** The All row's tick: "on" with every leaf picked, "mixed" with some, "off" in the draft. */
export function filterAllTick(selected, none = false) {
  return none ? "off" : selected.length ? "mixed" : "on";
}

/**
 * A click on All. Full All goes to the draft ({ none: true }); a partial All
 * or the draft ticks every row ({ selected: [] }).
 */
export function filterToggleAll(selected, none = false) {
  return filterAllTick(selected, none) === "on" ? { none: true, selected } : { none: false, selected: [] };
}

/**
 * A click on a node: off when all its leaves are ticked, else on. From the
 * draft a tick picks that node alone. When the click leaves nothing ticked
 * the result is the draft ({ none: true }) and the selection is unchanged.
 */
export function filterToggle(options, selected, node, none = false) {
  const ls = filterLeavesOf(node);
  if (none) return { none: false, selected: filterNormalize(options, ls) };
  const current = selected.length ? selected : filterLeaves(options);
  const next = filterTick(node, selected) === "on" ? current.filter(v => !ls.includes(v)) : [...current, ...ls];
  return next.length ? { none: false, selected: filterNormalize(options, next) } : { none: true, selected };
}

/** The one node whose leaves are exactly the pick (a leaf, or a whole group), else undefined. */
export function filterPickedNode(options, selected) {
  const want = new Set(selected);
  const walk = list => {
    for (const o of list) {
      const ls = filterLeavesOf(o);
      if (ls.length === want.size && ls.every(v => want.has(v))) return o;
      if (o.children && ls.some(v => want.has(v))) return walk(o.children);
    }
    return undefined;
  };
  return walk(options);
}

/**
 * The trigger text: the All label; the one picked node's label ("404 Not
 * found", a whole group "OpenAI"); for a flat list "N selected" (`many(n)`);
 * for a tree its picked parts ("Pages + Assets: Images").
 */
export function filterText(options, selected, allLabel = "All", many = n => `${n} selected`) {
  if (!selected.length) return allLabel;
  const one = filterPickedNode(options, selected);
  if (one) return one.label;
  if (selected.length === 1) return selected[0]; // one value the options don't list (yet)
  if (!options.some(o => o.children)) return many(selected.length);
  const parts = list =>
    list.flatMap(o => {
      const st = filterTick(o, selected);
      if (st === "on") return [o.label];
      return st === "mixed" && o.children ? parts(o.children) : [];
    });
  // A value the options don't list (yet) reads as itself, never as All or "".
  const unknown = selected.filter(v => !filterFind(options, v));
  return [
    ...options.flatMap(o => {
      const st = filterTick(o, selected);
      if (st === "on") return [o.label];
      if (st === "mixed" && o.children) return [`${o.label}: ${parts(o.children).join(", ")}`];
      return [];
    }),
    ...unknown,
  ].join(" + ");
}

const sameSet = (a, b) => a.length === b.length && a.every(v => b.includes(v));

/**
 * The URL value of a selection: "" for the filter's default, "all" for every
 * leaf (when the default is narrower), else a whole group by its own value
 * and a partial one by its picked children, comma-separated.
 */
export function filterToParam(options, selectedIn, defaultsIn = []) {
  // All emitted as every leaf (emptyMeansAll false) compares as [].
  const selected = filterNormalize(options, selectedIn);
  const defaults = filterNormalize(options, defaultsIn);
  if (sameSet(selected, defaults)) return "";
  if (!selected.length) return "all";
  const walk = list =>
    list.flatMap(o => {
      const st = filterTick(o, selected);
      if (st === "on") return [o.value];
      return st === "mixed" && o.children ? walk(o.children) : [];
    });
  const unknown = selected.filter(v => !filterFind(options, v));
  return [...walk(options), ...unknown].join(",");
}

/**
 * A URL value back to a selection. `legacy` maps former values onto node
 * values first. Values the options don't list are kept (a URL pick read
 * before its options load stays a pick). Missing or empty: the default.
 */
export function filterFromParam(options, raw, defaults = [], legacy = {}) {
  if (raw == null || raw === "") return defaults;
  if (raw === "all") return [];
  const picked = raw.split(",").flatMap(v => {
    const node = filterFind(options, legacy[v] ?? v);
    return node ? filterLeavesOf(node) : [v];
  });
  if (!picked.length) return defaults;
  return filterNormalize(options, picked);
}

// ---------------------------------------------------------------------------
// One open popover at a time
// ---------------------------------------------------------------------------
let openPopoverClose = null;

/**
 * Register the popover that just opened: `close` is how to close it. Any other
 * kit popover that is open closes first.
 */
export function claimPopover(close) {
  const prev = openPopoverClose;
  openPopoverClose = close;
  if (prev && prev !== close) prev();
}

/** Forget `close` if it is still the open popover (on close or unmount). */
export function releasePopover(close) {
  if (openPopoverClose === close) openPopoverClose = null;
}

/**
 * Close whichever kit popover is open. Call it when a popover the kit doesn't
 * own opens (a Radix menu's onOpenChange), so one dropdown is open at a time.
 */
export function closePopovers() {
  const close = openPopoverClose;
  openPopoverClose = null;
  if (close) close();
}
