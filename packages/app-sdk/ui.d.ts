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
}

export interface MultiSelectProps<V extends string = string> {
  options: ReadonlyArray<V | MultiSelectOption<V>>;
  value: readonly V[];
  onChange: (next: V[]) => void;
  allLabel?: string;
  /**
   * true (default): an empty selection means "all".
   * false: "all" is every value selected; the All row selects every option.
   */
  emptyMeansAll?: boolean;
  /** An "Only" button on each row that selects just that value. */
  showOnly?: boolean;
  /** Chips shown in the trigger before "+n". Default 2. */
  maxChips?: number;
  /** Which edge the menu aligns to before flipping. Default "start". */
  align?: "start" | "end";
  className?: string;
  "aria-label"?: string;
}
export function MultiSelect<V extends string = string>(props: MultiSelectProps<V>): React.ReactElement;

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
  className?: string;
}
/** The house chart tooltip: a table with swatches, right-aligned numbers and a total row. */
export function TableTooltip(props: TableTooltipProps): React.ReactElement;
/** A recharts `<Tooltip content={tableTooltip((datum, label) => ({ … }))} />`. */
export function tableTooltip<D = any>(
  build: (datum: D, label: unknown) => TableTooltipProps | null,
): (props: { active?: boolean; payload?: readonly { payload?: unknown }[]; label?: unknown }) => React.ReactElement | null;
/**
 * The hovered datum's series in reading order: stacked = top segment first
 * (pass series bottom-up, as drawn), else highest value first. Drops empty.
 */
export function tooltipSeriesRows<K extends string>(
  datum: Record<string, unknown> | null | undefined,
  series: readonly { key: K; label?: string; color?: string }[],
  opts?: { stacked?: boolean },
): { key: K; label: string; color?: string; value: number }[];

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
  /** Header width (and min width), e.g. 120 or "12rem". */
  width?: number | string;
  /** Truncate the cell with an ellipsis past this width; the full value shows on hover. */
  maxWidth?: number | string;
  /** Truncate at 260px (or `maxWidth`) with the full value as the hover title. */
  truncate?: boolean;
  /** Pin to the left edge with a solid background. Use on the first column. */
  sticky?: boolean;
  /** Default true. */
  sortable?: boolean;
  /** Header hover text, e.g. the column's definition. */
  hint?: string;
  /**
   * false leaves the column out of CSV; a function exports a readable cell (a
   * level name). Numbers export as is; a Date at local or UTC midnight exports
   * as YYYY-MM-DD, any other Date as a full UTC ISO timestamp.
   */
  csv?: false | ((row: R) => unknown);
}
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
  /** Default 50. */
  defaultPageSize?: number;
  onPageSizeChange?: (size: number) => void;
  /** Default [25, 50, 100]; one entry hides the select. */
  pageSizes?: readonly number[];
  /** Plural noun for the footer: "1–50 of 312 customers". Default "rows". */
  noun?: string;
  /** Shown when there are no rows. Default "No rows match these filters." */
  empty?: React.ReactNode;
  /** Fill the parent's height; the body scrolls inside the card. */
  fill?: boolean;
  /** Body scroll height when not `fill`. Default 70vh. */
  maxHeight?: number | string;
  /** Row click (and Enter or Space on a focused row). Clicks on links, buttons and fields inside the row are theirs. */
  onRowClick?: (row: R, event: React.SyntheticEvent) => void;
  /** The accessible name of a clickable row, e.g. `c => \`Open ${c.name}\``. */
  rowLabel?: (row: R) => string;
  /** Adds an "Export CSV" button: downloads every row, as sorted. */
  exportFilename?: string;
  className?: string;
  style?: React.CSSProperties;
}
/** The house data table: sortable, paged, sticky header, optional pinned first column, CSV export. */
export function DataTable<R = any>(props: DataTableProps<R>): React.ReactElement;

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
