import type * as React from "react";

/** ok | warn | bad (or green | amber | red), plus loading and neutral. */
export type Tone =
  | "ok"
  | "warn"
  | "bad"
  | "green"
  | "amber"
  | "red"
  | "warning"
  | "error"
  | "fresh"
  | "stale"
  | "loading"
  | "neutral";

/** Join class names, skipping falsy ones. */
export function cx(...parts: Array<string | false | null | undefined>): string;

export function normalizeTone(tone: Tone | string | undefined): "ok" | "warn" | "bad" | "loading" | "neutral";

/**
 * The order RefreshAllButton runs bindings in: `first`, the rest by name,
 * then `last`. Patterns ending in `*` match a prefix; `skip` drops bindings.
 */
export function refreshOrder(
  bindings: readonly string[],
  options?: { first?: readonly string[]; last?: readonly string[]; skip?: readonly string[] },
): string[];

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "outline" | "primary" | "ghost";
  size?: "md" | "sm";
}
export const Button: React.ForwardRefExoticComponent<ButtonProps & React.RefAttributes<HTMLButtonElement>>;

export function StatusDot(props: { tone?: Tone; className?: string }): React.ReactElement;

export function PageHeader(props: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}): React.ReactElement;

export interface CardProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}
export function Card(props: CardProps): React.ReactElement;

export function KpiTile(props: {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: React.ReactNode;
  /** Colours the delta. */
  tone?: Tone;
  hint?: React.ReactNode;
  className?: string;
}): React.ReactElement;

export function KpiRow(props: { className?: string; children?: React.ReactNode }): React.ReactElement;

export interface MultiSelectOption<V extends string = string> {
  value: V;
  label: string;
  /** A colour swatch shown next to the label (e.g. a chart series colour). */
  color?: string;
  /** What the option covers, shown on hover. */
  title?: string;
  /** A count shown muted at the row's right edge (2.28). Search ignores it; the trigger never shows it. A number is formatted (1,234). */
  count?: number | string;
  /** A group (2.20): its row ticks every leaf under it; hover submenus: FilterMenu in `@makoai/app-sdk/menu`. */
  children?: ReadonlyArray<MultiSelectOption<V>>;
}

/** A node's tick in a filter tree. */
export type FilterTick = "on" | "mixed" | "off";

/**
 * The rows of one filter (2.20): All, a separator, one tri-state row per
 * option, a group's children indented under it. Use it in an app's own composite menu
 * (several filters in one dropdown); MultiSelect renders it in its popover.
 * Drop-in for the apps' NestedFilterItems (`selected` = `value`).
 */
export interface FilterItemsProps<V extends string = string> {
  options: ReadonlyArray<V | MultiSelectOption<V>>;
  /** The selected leaf values; empty or every leaf = All. */
  value?: readonly V[];
  /** Alias of `value` (NestedFilterItems). */
  selected?: readonly V[];
  onChange: (next: V[]) => void;
  allLabel?: string;
  emptyMeansAll?: boolean;
  showOnly?: boolean;
  /** The "nothing ticked" draft, when the parent shows it; else FilterItems keeps it. */
  none?: boolean;
  onNoneChange?: (none: boolean) => void;
  /**
   * A search input above the rows (2.27), as shadcn's Command: it takes focus,
   * filters rows by label as you type (a group whose label matches keeps its
   * rows) and hides All while a query is typed. ArrowDown/ArrowUp move the
   * highlighted row, Enter ticks it. Default false: no input, rows unchanged.
   */
  searchable?: boolean;
  /** The search input's placeholder and accessible name. Default "Search". */
  searchPlaceholder?: string;
  /** Shown when no row matches. Default "No match". */
  searchEmpty?: string;
  className?: string;
  "aria-label"?: string;
}
export function FilterItems<V extends string = string>(props: FilterItemsProps<V>): React.ReactElement;

export interface MultiSelectProps<V extends string = string> {
  /** Strings, options, or groups with `children` (2.20): a flat list is a one-level tree. */
  options: ReadonlyArray<V | MultiSelectOption<V>>;
  /**
   * The selected leaf values. Empty, or every leaf, means "All". The All rule
   * (2.20): under All every row is ticked; unticking one leaves All partial
   * (–); a click on a full All unticks every row (a draft that emits
   * nothing: the trigger reads `noneLabel` and the first tick picks that row
   * alone); a click on a partial All ticks every row.
   */
  value?: readonly V[];
  /** Alias of `value` (drop-in for NestedFilterMenu). */
  selected?: readonly V[];
  onChange: (next: V[]) => void;
  allLabel?: string;
  /** Trigger text while nothing is ticked. Default "None". */
  noneLabel?: string;
  /** Replaces the trigger text. */
  summary?: string;
  /** The texts the trigger's width is fixed to. Default: All, top-level labels, "N selected", none. */
  sizeTo?: readonly string[];
  /** More texts the width also fits. */
  probes?: readonly string[];
  /** A class on the trigger button (e.g. a fixed width). */
  triggerClassName?: string;
  /** Alias of `aria-label` (NestedFilterMenu). */
  label?: string;
  /**
   * What All emits. true (default): []. false: every option's value.
   * Both spellings display as All either way.
   */
  emptyMeansAll?: boolean;
  /** An "Only" button on each row that selects just that value. */
  showOnly?: boolean;
  /** Trigger text for several values. Default `${n} selected`. */
  formatMany?: (n: number) => string;
  /** @deprecated 2.17: the trigger reads "All", the one label, or "N selected". Ignored. */
  maxChips?: number;
  /** Which edge the menu aligns to before flipping. Default "start". */
  align?: "start" | "end";
  /** A search input at the top of the menu (2.27): search, All, a separator, the values. See FilterItemsProps. */
  searchable?: boolean;
  /** Default "Search". */
  searchPlaceholder?: string;
  /** Default "No match". */
  searchEmpty?: string;
  className?: string;
  "aria-label"?: string;
}
export function MultiSelect<V extends string = string>(props: MultiSelectProps<V>): React.ReactElement;

/**
 * The kit's one checkbox, drawn only (the row around it takes the click),
 * coloured from theme tokens. Use it for the rows of an app's own menus.
 */
export function Checkbox(props: { checked?: boolean | "mixed"; className?: string }): React.ReactElement;

/** Every leaf value under a filter tree, in menu order. */
export function filterLeaves<V extends string>(options: ReadonlyArray<MultiSelectOption<V>>): V[];
/** The leaves under a node (a leaf is its own). */
export function filterLeavesOf<V extends string>(node: MultiSelectOption<V>): V[];
/** The node with `value` anywhere in the tree. */
export function filterFind<V extends string>(options: ReadonlyArray<MultiSelectOption<V>>, value: V): MultiSelectOption<V> | undefined;
/** A selection in menu order; [] when it holds every leaf. */
export function filterNormalize<V extends string>(options: ReadonlyArray<MultiSelectOption<V>>, picked: Iterable<V>): V[];
/** A node's tick; `none` = the nothing-ticked draft. */
export function filterTick<V extends string>(node: MultiSelectOption<V>, selected: readonly V[], none?: boolean): FilterTick;
/** The All row's tick. */
export function filterAllTick(selected: readonly string[], none?: boolean): FilterTick;
/** A click on All: full → the draft; partial or draft → every row. */
export function filterToggleAll<V extends string>(selected: readonly V[], none?: boolean): { none: boolean; selected: V[] };
/** A click on a node; leaving nothing ticked returns the draft with the selection unchanged. */
export function filterToggle<V extends string>(
  options: ReadonlyArray<MultiSelectOption<V>>,
  selected: readonly V[],
  node: MultiSelectOption<V>,
  none?: boolean,
): { none: boolean; selected: V[] };
/** The one node whose leaves are exactly the pick. */
export function filterPickedNode<V extends string>(options: ReadonlyArray<MultiSelectOption<V>>, selected: readonly V[]): MultiSelectOption<V> | undefined;
/** Trigger text: All label, the one node, "N selected" (flat), or the picked parts (tree). */
export function filterText<V extends string>(
  options: ReadonlyArray<MultiSelectOption<V>>,
  selected: readonly V[],
  allLabel?: string,
  many?: (n: number) => string,
): string;
/** URL value: "" for the default, "all", else whole groups by value and partial ones by children. */
export function filterToParam<V extends string>(options: ReadonlyArray<MultiSelectOption<V>>, selected: readonly V[], defaults?: readonly V[]): string;
/** A URL value back to a selection; `legacy` maps former values first. */
export function filterFromParam<V extends string>(
  options: ReadonlyArray<MultiSelectOption<V>>,
  raw: string | null | undefined,
  defaults?: readonly V[],
  legacy?: Record<string, string>,
): V[];

/** Where a MultiSelect stands: `all` when the value is empty or holds every option (then `selected` is empty). */
export function multiSelectState<V extends string>(
  value: readonly V[] | null | undefined,
  optionValues: readonly V[],
): { all: boolean; selected: V[] };
/** The next value after a click on `v`, by the All rule. */
export function multiSelectToggle<V extends string>(
  value: readonly V[],
  optionValues: readonly V[],
  v: V,
  emptyMeansAll?: boolean,
): V[];
/** The trigger text: the All label, the one label, or "N selected" (`many(n)`). */
export function multiSelectText<V extends string>(
  value: readonly V[],
  options: ReadonlyArray<{ value: V; label: string }>,
  allLabel?: string,
  many?: (n: number) => string,
): string;
/**
 * Close whichever kit popover (MultiSelect, FreshnessBadge) is open. Call it
 * when an app's own menu opens: `onOpenChange={o => o && closePopovers()}`.
 */
export function closePopovers(): void;

export interface FreshnessSource {
  key?: string;
  label: React.ReactNode;
  note?: React.ReactNode;
  detail?: React.ReactNode;
  /** Right-aligned, e.g. "Synced 09:05" or "2h ago". */
  value?: React.ReactNode;
  tone?: Tone;
}

export interface FreshnessBadgeProps {
  tone?: Tone;
  headline: React.ReactNode;
  /** Panel heading, e.g. "Data as of 09:05". */
  title?: React.ReactNode;
  /** Right of the heading, e.g. "12m ago". */
  meta?: React.ReactNode;
  schedule?: React.ReactNode;
  sources?: FreshnessSource[];
  /** A callout above the sources, e.g. a "Load latest" button. */
  action?: React.ReactNode;
  footer?: React.ReactNode;
  align?: "start" | "end";
  className?: string;
}
export function FreshnessBadge(props: FreshnessBadgeProps): React.ReactElement;

export interface RefreshAllButtonProps {
  /** The app's binding names (see the README for the build-time define). */
  bindings: readonly string[];
  /** Human labels per binding name; unlisted names show as-is. */
  labels?: Record<string, string>;
  /** Run these first (heaviest/slowest). `*` suffix = prefix match. */
  first?: readonly string[];
  /** Run these last (e.g. the freshness snapshot). */
  last?: readonly string[];
  /** Never rebuild these on demand (static, or too big for a request). */
  skip?: readonly string[];
  /** Bindings rebuilt at once. Default 3; keep it low. */
  concurrency?: number;
  /** Appended to the description, e.g. "Data also refreshes at 06:30." */
  schedule?: string;
  /** Override the rebuild (tests, custom engines). Default refreshBinding. */
  refresh?: (name: string) => Promise<unknown>;
  className?: string;
}
export function RefreshAllButton(props: RefreshAllButtonProps): React.ReactElement;

/** One tooltip row: swatch + label, then the cells (right-aligned). */
export interface TooltipRow {
  label: React.ReactNode;
  /** The series colour for the 9px swatch; omit for no swatch. */
  color?: string;
  /** A null or undefined cell shows a muted "–"; "" stays blank. */
  cells: React.ReactNode[];
  key?: string;
}
export interface TableTooltipProps {
  title?: React.ReactNode;
  /** Column headers for the cells, e.g. ["MRR", "Orgs", "% of due"]. */
  columns?: string[];
  /** Top-down as drawn (see `tooltipSeriesRows`). */
  rows?: TooltipRow[];
  /** Bold row under a rule: the stack total, "All selected", the base. */
  total?: TooltipRow;
  /** Rows after the total, apart: a value on another axis. */
  after?: TooltipRow[];
  /** The value columns' minimum width: "9ch", or px as a number. Default 7ch. */
  colWidth?: number | string;
  className?: string;
}
/** The house chart tooltip: a table with swatches, right-aligned numbers and a total row. */
export function TableTooltip(props: TableTooltipProps): React.ReactElement;
/** A recharts `<Tooltip content={tableTooltip((datum, label) => ({ … }))} />`. */
export function tableTooltip<D = any>(
  build: (datum: D, label: unknown) => TableTooltipProps | null,
): (props: { active?: boolean; payload?: readonly { payload?: unknown }[]; label?: unknown }) => React.ReactElement | null;
/** "missing" (null, undefined, "", NaN, ±Infinity), "zero" or "value". */
export type TooltipValueState = "missing" | "zero" | "value";
export function tooltipValueState(value: unknown): TooltipValueState;
export interface TooltipSeriesRow<K extends string = string> {
  key: K;
  label: string;
  color?: string;
  /** null when missing. */
  value: number | null;
  state: TooltipValueState;
  /** With `share: true`: value ÷ the sum of the non-missing values; null when missing or the sum is not above 0. */
  share?: number | null;
}
export interface TooltipSeriesRowsOptions {
  /** Pass series bottom-up, as drawn; the rows read top segment first. */
  stacked?: boolean;
  /** Opt-out: drop zero and missing rows (pre-2.15). Breaks the fixed tooltip height. */
  hideEmpty?: boolean;
  /** Opt-out: sort non-stacked rows highest value first, missing last (pre-2.15). */
  byValue?: boolean;
  /** A null or absent key counts as 0 (a muted "0"): a stack segment with no rows in the bucket. NaN stays missing. */
  absentAsZero?: boolean;
  /** Adds `share`: value ÷ the sum of the non-missing values; null when missing or the sum is not above 0. */
  share?: boolean;
}
/**
 * Every series of the hovered datum, in a fixed order: stacked = top segment
 * first (pass series bottom-up, as drawn), else legend (series) order. Zero
 * and missing values keep their row; render the cells with `tooltipCell`.
 */
export function tooltipSeriesRows<K extends string>(
  datum: Record<string, unknown> | null | undefined,
  series: readonly { key: K; label?: string; color?: string }[],
  opts?: TooltipSeriesRowsOptions,
): TooltipSeriesRow<K>[];
export interface TooltipCellOptions {
  /** A zero shows "0%" instead of "0". */
  percent?: boolean;
}
/** A cell's text and whether it is muted (zero or missing). */
export function tooltipCellText(
  value: unknown,
  format?: (value: number) => string,
  opts?: TooltipCellOptions,
): { text: string; muted: boolean };
/** A value cell: missing → muted "–", zero → muted "0" / "0%", else `format(value)`. */
export function tooltipCell(
  value: unknown,
  format?: (value: number) => string,
  opts?: TooltipCellOptions,
): React.ReactNode;

/** A table sort: the column id and its direction. */
export interface DataTableSort {
  id: string;
  dir: "asc" | "desc";
}
export interface DataTableColumn<R = any> {
  id: string;
  /** Header text; also the CSV header when it is a string (else `id`). */
  label: React.ReactNode;
  /** The cell's raw value: what it sorts by and what CSV exports. */
  value: (row: R) => unknown;
  /** What the cell shows; defaults to `value(row)`. */
  render?: (row: R) => React.ReactNode;
  /** A number: right-aligned, tabular figures, sorts largest first on the first click. */
  num?: boolean;
  align?: "left" | "right" | "center";
  /** A date column: takes the 110px default width. */
  date?: boolean;
  /**
   * The column's fixed width: px as a number (120) or any CSS length ("12rem").
   * Defaults by kind: numbers (`num` or right-aligned) 96px, `date` 110px, the
   * first or sticky column 240px, other text 140px. The rows on screen never
   * change it, so sorting, filtering and paging never shift the layout.
   */
  width?: number | string;
  /**
   * This column takes the space left when the card is wider than the sum of
   * the widths. Without any `grow` column, the first column grows.
   */
  grow?: boolean;
  /** A growing column's floor; defaults to its `width`. Other columns are exactly `width`. */
  minWidth?: number | string;
  /**
   * Default true: the cell stays on one line and ellipsizes at the column's
   * width, the raw value (text or number) as its hover title. false wraps the
   * text inside the column instead (the width still holds; the row grows).
   */
  truncate?: boolean;
  /** Pin to the left edge with a solid background. Use on the first column. */
  sticky?: boolean;
  /** Default true. */
  sortable?: boolean;
  /** Header hover text, e.g. the column's definition. */
  hint?: string;
  /**
   * The column group's id. Adjacent columns with the same `group` share one
   * label in a header row on top (see `DataTableProps.groups`); ungrouped
   * columns span both header rows.
   */
  group?: string;
  /**
   * false leaves the column out of CSV; a function exports a readable cell (a
   * level name). Numbers export as is; a Date at local or UTC midnight exports
   * as YYYY-MM-DD, any other Date as a full UTC ISO timestamp.
   */
  csv?: false | ((row: R) => unknown);
}
/** A column group's header: its label spans the adjacent columns with `group: id`. */
export interface DataTableGroup {
  id: string;
  label?: React.ReactNode;
  /** On the group's header cell, e.g. a colour per section. */
  className?: string;
}
/** The header runs of a DataTable's columns; null when no column has a `group`. */
export function columnGroupRuns<C extends { id: string; group?: string; sticky?: boolean }>(
  columns: readonly C[],
): { group: string | null; start: boolean; columns: C[] }[] | null;
/**
 * Every piece of text a DataTable renders itself: the footer, the pager's
 * aria-labels, the sort hint and the export button. Text with numbers is a
 * function that gets the raw numbers, so the app formats them in its locale.
 */
export interface DataTableLabels {
  /** The footer with rows. Default `<b>1–50</b> of <b>312</b> customers`. */
  range: (from: number, to: number, total: number, noun: string) => React.ReactNode;
  /** The footer with no rows. Default "No customers". */
  none: (noun: string) => React.ReactNode;
  /** The body cell with no rows. Default "No rows match these filters." The `empty` prop wins over it. */
  empty: React.ReactNode;
  /** Default "Page 2 of 7". */
  page: (page: number, pageCount: number) => string;
  /** One page-size option. Default "50 per page". */
  perPage: (size: number) => string;
  /** The page-size select's aria-label. Default "Rows per page". */
  rowsPerPage: string;
  /** The « button's aria-label. Default "First page". */
  first: string;
  /** The ‹ button's aria-label. Default "Previous page". */
  previous: string;
  /** The › button's aria-label. Default "Next page". */
  next: string;
  /** The » button's aria-label. Default "Last page". */
  last: string;
  /** A sortable header's hover title. Default "MRR · click to sort". */
  sortHint: (label: string) => string;
  /** Default "Export CSV". */
  exportCsv: string;
  /** The export button's hover title. Default "Export every row on every page, as sorted". */
  exportTitle: string;
  /** Shown when the browser blocks the CSV download. */
  exportFailed: string;
}
/** The English defaults of `DataTableLabels`. */
export const DATA_TABLE_LABELS: DataTableLabels;
export interface DataTableProps<R = any> {
  /** Default [] (renders the empty state while loading). */
  rows?: readonly R[];
  columns: readonly DataTableColumn<R>[];
  /** A stable key per row; defaults to `row.id`, else the position. */
  rowKey?: (row: R) => React.Key;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Controls in the card's title row (search, filters). */
  actions?: React.ReactNode;
  /** Controlled sort (put it in the URL); pair with `onSortChange`. */
  sort?: DataTableSort | null;
  defaultSort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort) => void;
  /**
   * Controlled page, 1-based; pair with `onPageChange`. A page past the end
   * shows the last page and reports it through `onPageChange` (once there are
   * rows), so a URL stays in sync.
   */
  page?: number;
  onPageChange?: (page: number) => void;
  /**
   * The filter state (search text, selected values; any JSON-serialisable
   * value). When it changes the table goes back to page 1. A sort or page-size
   * click also resets the page. New row objects with the same key (a load, a
   * background refresh, rows rebuilt inline) keep the page.
   */
  resetKey?: unknown;
  pageSize?: number;
  /** Default 50. `defaultPageSize={100}` opens on 100 rows; a size outside `pageSizes` is added to the select. */
  defaultPageSize?: number;
  onPageSizeChange?: (size: number) => void;
  /** Default [25, 50, 100]; one entry hides the select. */
  pageSizes?: readonly number[];
  /** Plural noun for the footer: "1–50 of 312 customers". Default "rows". */
  noun?: string;
  /** Shown when there are no rows. Default "No rows match these filters." */
  empty?: React.ReactNode;
  /**
   * Override any footer, pager, sort-hint or export text, e.g. French:
   * `{ page: (p, n) => "Page " + p + " sur " + n }`. Missing keys keep the
   * English default (`DATA_TABLE_LABELS`). The README has a full French set.
   */
  labels?: Partial<DataTableLabels>;
  /** Fill the parent's height; the body scrolls inside the card. */
  fill?: boolean;
  /** Body scroll height when not `fill`. Default 70vh. */
  maxHeight?: number | string;
  /** Row click (and Enter or Space on a focused row). Clicks on links, buttons and fields inside the row are theirs. */
  onRowClick?: (row: R, event: React.SyntheticEvent) => void;
  /** The accessible name of a clickable row, e.g. `c => \`Open ${c.name}\``. */
  rowLabel?: (row: R) => string;
  /**
   * A class for a body row, e.g. `d => d.status === "lost" ? "deal-lost" : undefined`.
   * Tint the row by setting `--mk-dt-row-bg` in that class: every cell paints
   * it, the pinned first column included. Use an opaque colour, such as
   * `color-mix(in srgb, var(--negative) 12%, var(--card))`, so scrolled cells
   * stay hidden behind the pin. Default undefined: rows get no class.
   */
  rowClassName?: (row: R) => string | undefined;
  /** Adds an "Export CSV" button: downloads every row, as sorted. */
  exportFilename?: string;
  /** Labels and classes for the column groups, by `DataTableColumn.group`. A group not listed shows its id. */
  groups?: readonly DataTableGroup[];
  className?: string;
  style?: React.CSSProperties;
}
/**
 * The house data table: sortable, paged, sticky header, optional pinned first
 * column, CSV export. Fixed column widths (`table-layout: fixed` + a
 * `<colgroup>`): no layout shift on sort, filter, page, empty or loading.
 */
export function DataTable<R = any>(props: DataTableProps<R>): React.ReactElement;

/** Default widths in px by kind. */
export const COLUMN_WIDTHS: { num: number; date: number; first: number; text: number };
/** A column's width when it sets none: num/right 96, date 110, first or sticky 240, text 140. */
export function defaultColumnWidth(column: Pick<DataTableColumn, "num" | "align" | "date" | "sticky">, index?: number): number;
/**
 * The fixed layout a DataTable renders: each `<col>` width (null for a
 * growing column) and the table's min-width, the sum of the columns.
 */
export function columnLayout(columns: readonly Pick<DataTableColumn, "id" | "num" | "align" | "date" | "sticky" | "width" | "minWidth" | "grow">[]): {
  cols: { id: string; width: string | null }[];
  minWidth: string;
};
/** A sorted copy: stable, by `value(row)`, empty values (null, "", NaN) last both ways. */
export function sortRows<R>(rows: readonly R[], columns: readonly DataTableColumn<R>[], sort: DataTableSort | null | undefined): R[];
/** The sort after a header click: same column flips; a new one starts desc for `num`, else asc. */
export function nextSort(sort: DataTableSort | null | undefined, column: Pick<DataTableColumn, "id" | "num">): DataTableSort;
/** Compare two cell values ascending: numbers, bigints, dates and two numeric strings by value; text A→Z. */
export function compareValues(a: unknown, b: unknown): number;
/** Paging math, 1-based and clamped: rows `start` (inclusive) to `end` (exclusive). */
export function pageSlice(total: number, page: number, pageSize: number): { page: number; pageCount: number; start: number; end: number };
/** The clamped page to report when `requested` is out of range; null when it is fine or there are no rows yet. */
export function pageToSync(requested: number, total: number, pageSize: number): number | null;
/** A `resetKey` as a comparable string (JSON; Sets and Maps as arrays, bigints as text). */
export function serializeResetKey(key: unknown): string;
/** CSV text with a header row; skips `csv: false` columns; quotes every cell; cells via `csvCell`. */
export function toCsv<R>(rows: readonly R[], columns: readonly DataTableColumn<R>[]): string;
/** One CSV cell: numbers as is, text starting with = + - @ tab or CR guarded with an apostrophe, dates via `csvDate`. */
export function csvCell(value: unknown): string;
/** A Date at local or UTC midnight as YYYY-MM-DD; any other Date as a full UTC ISO timestamp. */
export function csvDate(date: Date): string;
/** CSV text as tab-separated lines (pastes into spreadsheet columns). */
export function csvToTsv(text: string): string;
/** Download CSV text as a file. Works inside Mako's app frame. */
export function saveCsv(filename: string, text: string): "downloaded" | "failed";

export { formatDate, formatTime, toDayKey, toInstant } from "./index";
export type { FormatDateOptions, FormatTimeOptions, TimeValue } from "./index";
