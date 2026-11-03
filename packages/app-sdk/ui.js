// @makoai/app-sdk/ui — Mako's house dashboard kit. Plain ESM, no build step,
// no dependencies beyond React: styles come from `@makoai/app-sdk/ui.css`,
// colours from the theme tokens the SDK injects (index.js).
//
// What lives here is what the workspace kept re-forking app to app: the
// refresh-every-binding button and its progress modal, the multi-select
// filter, the freshness badge's popover, and the few page blocks (header,
// card, KPI tile) a new app starts from. Anything app-specific — which
// bindings are heavy, how freshness is computed — stays in the app and comes
// in through props.
import * as React from "react";
import { createPortal } from "react-dom";
import { bindingPhaseLabel, refreshBinding, useBindingProgress } from "./index.js";
import {
  COLUMN_WIDTHS,
  columnLayout,
  compareValues,
  csvCell,
  csvDate,
  csvToTsv,
  defaultColumnWidth,
  formatSeconds as fmtSecs,
  nextSort,
  normalizeTone,
  pageSlice,
  pageToSync,
  refreshOrder,
  serializeResetKey,
  sortRows,
  toCsv,
  tooltipSeriesRows,
} from "./ui-core.js";

export {
  COLUMN_WIDTHS,
  columnLayout,
  compareValues,
  csvCell,
  csvDate,
  csvToTsv,
  defaultColumnWidth,
  nextSort,
  normalizeTone,
  pageSlice,
  pageToSync,
  refreshOrder,
  serializeResetKey,
  sortRows,
  toCsv,
  tooltipSeriesRows,
};

const h = React.createElement;

/** Join class names, skipping falsy ones. */
export function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Icons (inline, so the kit needs no icon library)
// ---------------------------------------------------------------------------
function svg(size, strokeWidth, children, className) {
  return h(
    "svg",
    {
      className,
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    ...children,
  );
}
const IconCheck = ({ size = 11 }) =>
  svg(size, 3.2, [h("polyline", { key: "p", points: "20 6 9 17 4 12" })]);
const IconChevron = ({ className }) =>
  svg(12, 2.2, [h("polyline", { key: "p", points: "6 9 12 15 18 9" })], className);
const IconX = ({ size = 16 }) =>
  svg(size, 2, [h("path", { key: "p", d: "M18 6 6 18M6 6l12 12" })]);
const IconRefresh = () =>
  svg(14, 2.2, [
    h("path", { key: "a", d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }),
    h("path", { key: "b", d: "M21 3v5h-5" }),
    h("path", { key: "c", d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }),
    h("path", { key: "d", d: "M3 21v-5h5" }),
  ]);

// ---------------------------------------------------------------------------
// Popover plumbing shared by MultiSelect and FreshnessBadge
// ---------------------------------------------------------------------------
const PHONE = "(max-width: 640px)";

/**
 * Close on outside click and Escape, and keep the `.mk-pop` inside `wrapRef`
 * within the viewport: it opens under its trigger aligned to `align`, flips
 * to the other edge when that would overflow, and as a last resort is pinned
 * to the viewport margin. On phones the popover is a bottom sheet (CSS) and
 * is left alone.
 */
function usePopover(open, setOpen, wrapRef, align) {
  React.useEffect(() => {
    if (!open) return undefined;
    const onDoc = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = e => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, wrapRef]);

  React.useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const pop = wrapRef.current?.querySelector(".mk-pop");
      if (!pop) return;
      pop.style.left = "";
      pop.style.right = "";
      if (window.matchMedia(PHONE).matches) return;
      const margin = 8;
      const start = align === "end" ? "right" : "left";
      const other = start === "left" ? "right" : "left";
      pop.style[start] = "0";
      pop.style[other] = "auto";
      let r = pop.getBoundingClientRect();
      if (r.right > window.innerWidth - margin || r.left < margin) {
        pop.style[start] = "auto";
        pop.style[other] = "0";
        r = pop.getBoundingClientRect();
      }
      if (r.left < margin) {
        const wrap = wrapRef.current.getBoundingClientRect();
        pop.style.right = "auto";
        pop.style.left = `${margin - wrap.left}px`;
      }
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, wrapRef, align]);
}

// ---------------------------------------------------------------------------
// Page blocks
// ---------------------------------------------------------------------------

/** Outline button; `variant="primary"` is the filled one, `"ghost"` borderless. */
export const Button = React.forwardRef(function Button(
  { variant = "outline", size = "md", className, type = "button", ...rest },
  ref,
) {
  return h("button", {
    ref,
    type,
    className: cx("mk-btn", `mk-btn--${variant}`, size === "sm" && "mk-btn--sm", className),
    ...rest,
  });
});

/** A status dot: `ok` | `warn` | `bad` | `neutral` | `loading`. */
export function StatusDot({ tone = "neutral", className }) {
  return h("span", { className: cx("mk-dot", `mk-tone-${normalizeTone(tone)}`, className) });
}

/** The page's title row: title + subtitle on the left, actions on the right. */
export function PageHeader({ title, subtitle, actions, className, children }) {
  return h(
    "header",
    { className: cx("mk-header", className) },
    h(
      "div",
      { className: "mk-header-text" },
      h("h1", { className: "mk-header-title" }, title),
      subtitle != null && h("p", { className: "mk-header-subtitle" }, subtitle),
    ),
    actions != null && h("div", { className: "mk-header-actions" }, actions),
    children,
  );
}

/** A 12px panel with an optional title row. */
export function Card({ title, description, actions, className, children, ...rest }) {
  const head =
    title != null || actions != null
      ? h(
          "div",
          { className: "mk-card-head" },
          h(
            "div",
            null,
            title != null && h("h2", { className: "mk-card-title" }, title),
            description != null && h("p", { className: "mk-card-desc" }, description),
          ),
          actions != null && h("div", { className: "mk-card-actions" }, actions),
        )
      : null;
  return h("section", { className: cx("mk-card", className), ...rest }, head, children);
}

/** One KPI: label, big value, an optional delta (tone colours it) and hint. */
export function KpiTile({ label, value, delta, tone, hint, className }) {
  return h(
    "div",
    { className: cx("mk-kpi", className) },
    h("div", { className: "mk-kpi-label" }, label),
    h("div", { className: "mk-kpi-value" }, value),
    (delta != null || hint != null) &&
      h(
        "div",
        { className: "mk-kpi-foot" },
        delta != null &&
          h("span", { className: cx("mk-kpi-delta", tone && `mk-tone-${normalizeTone(tone)}`) }, delta),
        hint != null && h("span", { className: "mk-kpi-hint" }, hint),
      ),
  );
}

/** A row of KPI tiles that wraps. */
export function KpiRow({ className, children }) {
  return h("div", { className: cx("mk-kpi-row", className) }, children);
}

// ---------------------------------------------------------------------------
// Chart tooltips: a table, never a coloured "name : value" list
// ---------------------------------------------------------------------------

function TooltipRow({ row, className }) {
  return h(
    "tr",
    { className },
    h(
      "th",
      { scope: "row" },
      h("span", { className: "mk-tip-swatch", style: { background: row.color ?? "transparent" } }),
      row.label,
    ),
    ...(row.cells ?? []).map((c, i) => h("td", { key: i }, c)),
  );
}

/**
 * The house chart tooltip: a bold title, small muted column headers, one row
 * per series with a 9px swatch in the series colour and the label in the
 * popover's text colour, right-aligned tabular numbers, then a bold `total`
 * row under a rule. `after` rows follow the total, apart (a value on another
 * axis, such as an average next to a rate).
 */
export function TableTooltip({ title, columns = [], rows = [], total, after, className }) {
  return h(
    "div",
    { className: cx("mk-tip", className) },
    title != null && h("div", { className: "mk-tip-title" }, title),
    h(
      "table",
      null,
      columns.length > 0 &&
        h("thead", null, h("tr", null, h("th", null), ...columns.map(c => h("th", { key: c }, c)))),
      h(
        "tbody",
        null,
        ...rows.map(r => h(TooltipRow, { key: r.key ?? r.label, row: r })),
        total && h(TooltipRow, { key: "__total", row: total, className: cx("mk-tip-total", rows.length > 0 && "mk-tip-rule") }),
        ...(after ?? []).map((r, i) =>
          h(TooltipRow, { key: `__after_${r.key ?? r.label}`, row: r, className: i === 0 ? "mk-tip-rule" : undefined }),
        ),
      ),
    ),
  );
}

/**
 * A recharts `<Tooltip content={…} />` from a builder: `build(datum, label)`
 * gets the hovered data row and the axis label and returns TableTooltip props
 * (or null to show nothing).
 */
export function tableTooltip(build) {
  return function TableTooltipContent({ active, payload, label }) {
    const datum = payload?.[0]?.payload;
    if (!active || !datum) return null;
    const props = build(datum, label);
    return props ? h(TableTooltip, props) : null;
  };
}

// ---------------------------------------------------------------------------
// DataTable: sortable, paged, sticky header, CSV export
// ---------------------------------------------------------------------------

const IconSort = ({ dir }) =>
  svg(
    12,
    2,
    [
      h("path", {
        key: "p",
        d:
          dir === "asc"
            ? "m5 12 7-7 7 7M12 19V5"
            : dir === "desc"
              ? "M12 5v14M19 12l-7 7-7-7"
              : "m21 16-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16",
      }),
    ],
    dir ? undefined : "mk-dt-faint",
  );

/** A value that is controlled when `value !== undefined`, local state otherwise. */
function useControlled(value, initial, onChange) {
  const [local, setLocal] = React.useState(initial);
  const controlled = value !== undefined;
  const set = React.useCallback(
    next => {
      if (!controlled) setLocal(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );
  return [controlled ? value : local, set];
}

/**
 * Download CSV text (from `toCsv`) as `filename` (".csv" added when missing).
 * Mako's app frames allow downloads, so this works inside Mako and out.
 * Returns "downloaded", or "failed" when the browser refused.
 */
export function saveCsv(filename, text) {
  if (typeof document === "undefined") return "failed";
  try {
    const name = /\.csv$/i.test(filename) ? filename : `${filename}.csv`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8;" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return "downloaded";
  } catch {
    return "failed";
  }
}

const fmtCount = n => n.toLocaleString("en-US");
// A click on a link, button or field inside a row is that control's, not the row's.
const INTERACTIVE = "a,button,input,select,textarea,label,[role=button]";

/**
 * The house data table: click-to-sort headers, a sticky header (and first
 * column with `sticky`), right-aligned tabular numbers, and a pager footer
 * ("1–50 of 312 customers", rows per page, « ‹ Page x of y › »). Sort, page
 * and page size are each controlled (`sort` + `onSortChange`, …) or left to
 * the table. Pass the filter state as `resetKey`: when it changes the table
 * goes back to page 1. `fill` makes the card fill its parent's height with the
 * body scrolling inside; `exportFilename` adds an "Export CSV" button.
 *
 * Columns have fixed widths (`table-layout: fixed` and a `<colgroup>`), from
 * each column's `width` or a default by kind (see `columnLayout`). The rows
 * on screen never change a width, so sorting, filtering and paging never
 * shift the layout. Cells ellipsize at their width with the full value on hover.
 */
export function DataTable({
  rows = [],
  columns,
  rowKey,
  title,
  description,
  actions,
  sort: sortProp,
  defaultSort = null,
  onSortChange,
  page: pageProp,
  onPageChange,
  pageSize: pageSizeProp,
  defaultPageSize = 50,
  onPageSizeChange,
  pageSizes = [25, 50, 100],
  noun = "rows",
  empty = "No rows match these filters.",
  fill = false,
  maxHeight,
  onRowClick,
  rowLabel,
  resetKey,
  exportFilename,
  className,
  style,
}) {
  const [sort, setSort] = useControlled(sortProp, defaultSort, onSortChange);
  const [rawPage, setRawPage] = useControlled(pageProp, 1, onPageChange);
  const [pageSize, setPageSize] = useControlled(pageSizeProp, defaultPageSize, onPageSizeChange);
  // A page size outside the list (defaultPageSize={200}) still shows as the selected option.
  const sizeOptions = pageSizes.includes(pageSize) ? pageSizes : [...pageSizes, pageSize].sort((a, b) => a - b);
  const [note, setNote] = React.useState(null);
  const scrollRef = React.useRef(null);

  const sorted = React.useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);
  const layout = React.useMemo(() => columnLayout(columns), [columns]);
  const { page, pageCount, start, end } = pageSlice(sorted.length, rawPage, pageSize);
  const visible = sorted.slice(start, end);

  const goTo = p => {
    if (p !== rawPage) setRawPage(p);
    scrollRef.current?.scrollTo?.({ top: 0 });
  };

  // Back to page 1 when the filters change, as the caller states them in
  // `resetKey`. Row identity never resets the page: a load, a background
  // refresh or rows rebuilt inline keep it.
  const key = serializeResetKey(resetKey);
  const prevKey = React.useRef(key);
  React.useEffect(() => {
    if (prevKey.current === key) return;
    prevKey.current = key;
    if (rawPage !== 1) goTo(1);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // A page past the end (rows shrank, a stale URL) shows the last page; report
  // it so a controlled page matches. Skipped while there are no rows yet.
  const syncTo = pageToSync(rawPage, sorted.length, pageSize);
  React.useEffect(() => {
    if (syncTo != null) setRawPage(syncTo);
  }, [syncTo]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (!note) return undefined;
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);

  const sortBy = col => {
    setSort(nextSort(sort, col));
    goTo(1);
  };
  const exportCsv = () => {
    const res = saveCsv(exportFilename, toCsv(sorted, columns));
    setNote(res === "failed" ? "The browser blocked the download. Open the app in a new tab and export again." : null);
  };

  const cellClass = (col, extra) =>
    cx(col.num && "mk-dt-num", col.align === "right" && "mk-dt-num", col.align === "center" && "mk-dt-center", col.sticky && "mk-dt-pin", extra);

  const head = h(
    "thead",
    null,
    h(
      "tr",
      null,
      ...columns.map(col => {
        const active = sort?.id === col.id;
        const text = typeof col.label === "string" ? col.label : col.id;
        const label =
          col.sortable === false
            ? h("span", { className: "mk-dt-label", title: col.hint ?? text }, h("span", { className: "mk-dt-th-text" }, col.label))
            : h(
                "button",
                {
                  type: "button",
                  className: "mk-dt-sort",
                  onClick: () => sortBy(col),
                  title: `${col.hint ?? text} · click to sort`,
                },
                h("span", { className: "mk-dt-th-text" }, col.label),
                h(IconSort, { dir: active ? sort.dir : null }),
              );
        return h(
          "th",
          {
            key: col.id,
            scope: "col",
            className: cellClass(col, active && "mk-dt-sorted"),
            "aria-sort": col.sortable === false ? undefined : active ? (sort.dir === "asc" ? "ascending" : "descending") : "none",
          },
          label,
        );
      }),
    ),
  );

  // Every cell ellipsizes at its column's width, with the raw value (text or
  // a number) as the hover title. `truncate: false` wraps instead.
  const cell = (col, row) => {
    const v = col.value(row);
    const content = col.render ? col.render(row) : v;
    if (col.truncate === false) return h("div", { className: "mk-dt-wrap" }, content);
    const title = typeof v === "string" || typeof v === "number" || typeof v === "bigint" ? String(v) : undefined;
    return h("div", { className: "mk-dt-cell", title: title || undefined }, content);
  };

  const body = h(
    "tbody",
    null,
    visible.length === 0
      ? h("tr", { key: "__empty" }, h("td", { colSpan: columns.length, className: "mk-dt-empty" }, empty))
      : visible.map((row, i) => {
          const key = rowKey ? rowKey(row) : (row?.id ?? start + i);
          const click = onRowClick
            ? {
                tabIndex: 0,
                className: "mk-dt-click",
                "aria-label": rowLabel ? rowLabel(row) : undefined,
                onClick: e => {
                  if (!e.target.closest?.(INTERACTIVE)) onRowClick(row, e);
                },
                onKeyDown: e => {
                  if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
                    e.preventDefault();
                    onRowClick(row, e);
                  }
                },
              }
            : null;
          return h(
            "tr",
            { key, ...click },
            ...columns.map(col => h("td", { key: col.id, className: cellClass(col) || undefined }, cell(col, row))),
          );
        }),
  );

  const footer = h(
    "footer",
    { className: "mk-dt-foot" },
    h(
      "span",
      { "aria-live": "polite" },
      sorted.length
        ? [h("b", { key: "r" }, `${fmtCount(start + 1)}–${fmtCount(end)}`), " of ", h("b", { key: "t" }, fmtCount(sorted.length)), ` ${noun}`]
        : `No ${noun}`,
    ),
    h(
      "div",
      { className: "mk-dt-nav" },
      pageSizes.length > 1 &&
        h(
          "select",
          {
            className: "mk-dt-size",
            "aria-label": "Rows per page",
            value: pageSize,
            onChange: e => {
              setPageSize(Number(e.target.value));
              goTo(1);
            },
          },
          ...sizeOptions.map(n => h("option", { key: n, value: n }, `${n} per page`)),
        ),
      h(Button, { size: "sm", "aria-label": "First page", disabled: page <= 1, onClick: () => goTo(1) }, "«"),
      h(Button, { size: "sm", "aria-label": "Previous page", disabled: page <= 1, onClick: () => goTo(page - 1) }, "‹"),
      h("span", { className: "mk-dt-page" }, `Page ${page} of ${pageCount}`),
      h(Button, { size: "sm", "aria-label": "Next page", disabled: page >= pageCount, onClick: () => goTo(page + 1) }, "›"),
      h(Button, { size: "sm", "aria-label": "Last page", disabled: page >= pageCount, onClick: () => goTo(pageCount) }, "»"),
    ),
  );

  const exportButton =
    exportFilename != null &&
    h(
      Button,
      { key: "__export", disabled: !sorted.length, onClick: exportCsv, title: "Export every row on every page, as sorted" },
      "Export CSV",
    );

  return h(
    Card,
    {
      title,
      description,
      actions: actions != null || exportButton ? h(React.Fragment, null, actions, exportButton) : undefined,
      className: cx("mk-dt", fill && "mk-dt--fill", className),
      style,
    },
    note && h("p", { className: "mk-dt-note", role: "status" }, note),
    h(
      "div",
      { className: "mk-dt-scroll", ref: scrollRef, style: !fill && maxHeight != null ? { maxHeight } : undefined },
      h(
        "table",
        { className: "mk-dt-table", style: { minWidth: layout.minWidth } },
        h(
          "colgroup",
          null,
          ...layout.cols.map(c => h("col", { key: c.id, style: c.width ? { width: c.width } : undefined })),
        ),
        head,
        body,
      ),
    ),
    footer,
  );
}

// ---------------------------------------------------------------------------
// MultiSelect
// ---------------------------------------------------------------------------
function toOption(o) {
  return typeof o === "string" ? { value: o, label: o } : o;
}

/**
 * Multi-select filter (shadcn combobox look). Controlled: `value` is the
 * selected values, `onChange` gets the next array.
 *
 * `emptyMeansAll` (default true): an empty selection is "all" — the common
 * filter shape. Set it to false when "all" is every value selected; the
 * "All" row then selects every option instead of clearing.
 */
export function MultiSelect({
  options,
  value,
  onChange,
  allLabel = "All",
  emptyMeansAll = true,
  showOnly = false,
  maxChips = 2,
  align = "start",
  className,
  "aria-label": ariaLabel,
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  usePopover(open, setOpen, ref, align);
  const opts = options.map(toOption);
  const allOn = emptyMeansAll ? value.length === 0 : value.length === opts.length;
  const chosen = opts.filter(o => value.includes(o.value));

  const toggle = v =>
    onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v]);
  const all = () => onChange(emptyMeansAll ? [] : opts.map(o => o.value));

  const box = on => h("span", { className: cx("mk-ms-box", on && "on") }, on && h(IconCheck));
  const dot = o =>
    o.color ? h("span", { className: "mk-ms-swatch", style: { background: o.color } }) : null;

  return h(
    "div",
    { className: cx("mk-ms", className), ref },
    h(
      "button",
      {
        type: "button",
        className: cx("mk-ms-trigger", open && "open"),
        "aria-haspopup": "listbox",
        "aria-expanded": open,
        "aria-label": ariaLabel,
        onClick: () => setOpen(o => !o),
      },
      h(
        "span",
        { className: "mk-ms-value" },
        allOn || chosen.length === 0
          ? h("span", null, allLabel)
          : h(
              "span",
              { className: "mk-ms-chips" },
              ...chosen.slice(0, maxChips).map(o =>
                h("span", { key: o.value, className: "mk-ms-chip" }, dot(o), o.label),
              ),
              chosen.length > maxChips &&
                h("span", { key: "+", className: "mk-ms-chip mk-ms-more" }, `+${chosen.length - maxChips}`),
            ),
      ),
      h(IconChevron, { className: "mk-ms-caret" }),
    ),
    open &&
      h(
        "div",
        { className: "mk-pop mk-ms-menu", role: "listbox", "aria-multiselectable": true },
        h(
          "button",
          { type: "button", className: cx("mk-ms-opt", allOn && "active"), onClick: all },
          box(allOn),
          h("span", { className: "mk-ms-label" }, allLabel),
        ),
        h("div", { className: "mk-ms-sep" }),
        ...opts.map(o => {
          const on = value.includes(o.value);
          return h(
            "div",
            {
              key: o.value,
              role: "option",
              "aria-selected": on,
              tabIndex: 0,
              className: cx("mk-ms-opt", on && "active"),
              onClick: () => toggle(o.value),
              onKeyDown: e => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(o.value);
                }
              },
            },
            box(on),
            dot(o),
            h("span", { className: "mk-ms-label" }, o.label),
            showOnly &&
              h(
                "button",
                {
                  type: "button",
                  className: "mk-ms-only",
                  onClick: e => {
                    e.stopPropagation();
                    onChange([o.value]);
                  },
                },
                "Only",
              ),
          );
        }),
      ),
  );
}

// ---------------------------------------------------------------------------
// FreshnessBadge
// ---------------------------------------------------------------------------
/**
 * How old the data is, as a dot + headline that opens a panel listing each
 * source. Presentational: the app decides what "fresh" means and passes the
 * verdict in. `tone`/source tones accept ok|warn|bad (or green|amber|red).
 *
 * sources: [{ key, label, note?, value?, detail?, tone? }]
 * action:  a node shown as a callout above the sources (e.g. "Load latest").
 */
export function FreshnessBadge({
  tone = "neutral",
  headline,
  title,
  meta,
  schedule,
  sources = [],
  action,
  footer,
  align = "end",
  className,
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  usePopover(open, setOpen, ref, align);
  const t = normalizeTone(tone);
  // A footer alone is not a panel: while the app is still checking, the
  // badge must not open onto an empty box.
  const hasPanel = title != null || schedule != null || sources.length > 0 || !!action;

  return h(
    "div",
    { className: cx("mk-fresh", className), ref },
    h(
      "button",
      {
        type: "button",
        className: cx("mk-fresh-trigger", `mk-tone-${t}`, open && "open"),
        "aria-haspopup": hasPanel ? "dialog" : undefined,
        "aria-expanded": hasPanel ? open : undefined,
        "aria-live": "polite",
        disabled: !hasPanel,
        onClick: () => setOpen(o => !o),
      },
      h("span", { className: cx("mk-dot", `mk-tone-${t}`) }),
      h("span", { className: "mk-fresh-headline" }, headline),
    ),
    open &&
      hasPanel &&
      h(
        "div",
        { className: "mk-pop mk-fresh-pop", role: "dialog", "aria-label": "Data freshness" },
        (title != null || meta != null) &&
          h(
            "div",
            { className: "mk-fresh-head" },
            h("strong", null, title),
            meta != null && h("span", null, meta),
          ),
        schedule != null && h("p", { className: "mk-fresh-schedule" }, schedule),
        action && h("div", { className: "mk-fresh-action" }, action),
        sources.length > 0 &&
          h(
            "ul",
            { className: "mk-fresh-sources", "aria-label": "Sources" },
            ...sources.map(s =>
              h(
                "li",
                { key: s.key ?? s.label },
                h("span", { className: cx("mk-dot", `mk-tone-${normalizeTone(s.tone)}`) }),
                h(
                  "span",
                  { className: "mk-fresh-source" },
                  h("span", null, s.label),
                  s.note != null && h("small", null, s.note),
                  s.detail != null && h("small", { className: "mk-fresh-detail" }, s.detail),
                ),
                h("span", { className: "mk-fresh-value" }, s.value ?? "—"),
              ),
            ),
          ),
        footer != null && h("p", { className: "mk-fresh-foot" }, footer),
      ),
  );
}

// ---------------------------------------------------------------------------
// RefreshAllButton
// ---------------------------------------------------------------------------
/**
 * Re-runs every binding's warehouse query, `concurrency` at a time, and
 * updates the app as each one lands (refreshBinding). The header shows one
 * fixed-size button; progress lives in a modal (confirm → live checklist
 * with per-source timings → summary). Closing the modal does not stop the
 * refresh. A failed binding is reported and keeps serving its old data.
 *
 * `bindings` is the app's binding names — usually a build-time define over
 * `bindings/*.sql` (see the README). Keep `concurrency` low: stacked heavy
 * warehouse builds fail transiently and can wedge a slot pool.
 */
export function RefreshAllButton({
  bindings,
  labels = {},
  first,
  last,
  skip,
  concurrency = 3,
  schedule,
  refresh = refreshBinding,
  className,
}) {
  const sources = React.useMemo(
    () => refreshOrder(bindings, { first, last, skip }),
    // Patterns are usually literals; key them by content, not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bindings.join("\0"), (first ?? []).join("\0"), (last ?? []).join("\0"), (skip ?? []).join("\0")],
  );
  const busy = React.useRef(false);
  const [state, setState] = React.useState({ status: "idle" });
  const [items, setItems] = React.useState({});
  const [errors, setErrors] = React.useState([]);
  const [took, setTook] = React.useState({});
  const [open, setOpen] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const closeRef = React.useRef(null);
  // What each running source is waiting on: the warehouse, the link, the
  // download or DuckDB (progress.js).
  const progress = useBindingProgress();

  const running = state.status === "running";
  const total = sources.length;
  const labelOf = name => labels[name] ?? name;

  React.useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = e => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  async function refreshAll() {
    if (busy.current) return;
    busy.current = true;
    const startedAt = Date.now();
    const failures = [];
    let done = 0;
    let next = 0;
    setNow(startedAt);
    setErrors([]);
    setTook({});
    setItems(Object.fromEntries(sources.map(n => [n, "queued"])));
    setState({ status: "running", done, startedAt });
    const mark = (name, st) => setItems(m => ({ ...m, [name]: st }));
    async function worker() {
      while (next < sources.length) {
        const name = sources[next++];
        mark(name, "running");
        const t0 = Date.now();
        try {
          await refresh(name);
          mark(name, "done");
        } catch (error) {
          failures.push({ name, message: error instanceof Error ? error.message : String(error) });
          setErrors([...failures]);
          mark(name, "failed");
        }
        const secs = Math.round((Date.now() - t0) / 1000);
        setTook(m => ({ ...m, [name]: secs }));
        done += 1;
        setState({ status: "running", done, startedAt });
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
      setState({
        status: "done",
        at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        failures,
        seconds: Math.round((Date.now() - startedAt) / 1000),
      });
    } finally {
      busy.current = false;
    }
  }

  const failedCount = state.status === "done" ? state.failures.length : 0;
  const label = running
    ? `Refreshing ${state.done}/${total}…`
    : state.status === "done"
      ? failedCount
        ? `${total - failedCount}/${total} refreshed`
        : `Refreshed ${state.at}`
      : "Refresh data";
  const elapsed = running
    ? Math.max(0, Math.round((now - state.startedAt) / 1000))
    : state.status === "done"
      ? state.seconds
      : 0;
  const doneCount = running ? state.done : state.status === "done" ? total : 0;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;

  const title =
    state.status === "idle"
      ? "Refresh data"
      : running
        ? "Refreshing data…"
        : failedCount
          ? "Refresh finished with errors"
          : "Data refreshed";
  const desc =
    state.status === "idle"
      ? `Re-runs ${total} warehouse ${total === 1 ? "query" : "queries"} (${concurrency} at a time) and updates the app as each one lands.${schedule ? ` ${schedule}` : ""}`
      : running
        ? "You can close this — the refresh keeps running in the background."
        : failedCount
          ? "Failed sources keep serving their previous data."
          : `All ${total} sources rebuilt in ${fmtSecs(elapsed)}.`;

  const itemIcon = st =>
    st === "done"
      ? svg(14, 2.5, [h("path", { key: "p", d: "M20 6 9 17l-5-5" })])
      : st === "failed"
        ? h(IconX, { size: 14 })
        : st === "running"
          ? h("span", { className: "mk-rf-spin" })
          : h("span", { className: "mk-rf-dot" });
  const itemState = (st, name) =>
    st === "queued"
      ? state.status === "idle"
        ? ""
        : "Queued"
      : st === "running"
        ? bindingPhaseLabel(progress[name]) || "Running"
        : st === "done"
          ? took[name] != null
            ? fmtSecs(took[name])
            : "Done"
          : "Failed";

  const modal =
    open &&
    createPortal(
      h(
        "div",
        {
          className: "mk-rf-backdrop",
          onMouseDown: e => e.target === e.currentTarget && setOpen(false),
        },
        h(
          "div",
          { className: "mk-rf-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "mk-rf-title" },
          h(
            "div",
            { className: "mk-rf-head" },
            h(
              "div",
              null,
              h("h2", { id: "mk-rf-title", className: "mk-rf-title" }, title),
              h("p", { className: "mk-rf-desc" }, desc),
            ),
            h(
              "button",
              { ref: closeRef, type: "button", className: "mk-rf-x", "aria-label": "Close", onClick: () => setOpen(false) },
              h(IconX),
            ),
          ),
          state.status !== "idle" &&
            h(
              "div",
              { className: "mk-rf-progress" },
              h(
                "div",
                {
                  className: "mk-rf-bar",
                  role: "progressbar",
                  "aria-valuemin": 0,
                  "aria-valuemax": total,
                  "aria-valuenow": doneCount,
                },
                h("div", {
                  className: cx("mk-rf-fill", (failedCount || errors.length) && "has-err"),
                  style: { width: `${pct}%` },
                }),
              ),
              h(
                "div",
                { className: "mk-rf-meta" },
                h("span", null, `${doneCount} of ${total} rebuilt`),
                h("span", null, fmtSecs(elapsed)),
              ),
            ),
          h(
            "ul",
            { className: "mk-rf-list", "aria-live": "polite" },
            ...sources.map(name => {
              const st = state.status === "idle" ? "queued" : (items[name] ?? "queued");
              const err = errors.find(e => e.name === name);
              return h(
                "li",
                { key: name, className: cx("mk-rf-item", st), title: name },
                h("span", { className: "mk-rf-ico" }, itemIcon(st)),
                h(
                  "span",
                  { className: "mk-rf-name" },
                  labelOf(name),
                  err && h("span", { className: "mk-rf-err" }, err.message),
                ),
                h("span", { className: "mk-rf-state" }, itemState(st, name)),
              );
            }),
          ),
          h(
            "div",
            { className: "mk-rf-foot" },
            state.status === "idle" && [
              h(Button, { key: "c", onClick: () => setOpen(false) }, "Cancel"),
              h(Button, { key: "s", variant: "primary", onClick: refreshAll }, "Start refresh"),
            ],
            running && h(Button, { onClick: () => setOpen(false) }, "Hide"),
            state.status === "done" && [
              h(Button, { key: "a", onClick: refreshAll }, "Refresh again"),
              h(Button, { key: "d", variant: "primary", onClick: () => setOpen(false) }, "Done"),
            ],
          ),
        ),
      ),
      document.body,
    );

  return h(
    React.Fragment,
    null,
    h(
      "button",
      {
        type: "button",
        className: cx(
          "mk-btn mk-btn--outline mk-refresh",
          running && "refreshing",
          state.status === "done" && (failedCount ? "failed" : "ok"),
          className,
        ),
        title: running
          ? "Refresh in progress — click to see details."
          : `Re-runs every binding's warehouse query.${schedule ? ` ${schedule}` : ""}`,
        disabled: !total,
        onClick: () => setOpen(true),
        "aria-haspopup": "dialog",
      },
      h(IconRefresh),
      label,
    ),
    modal,
  );
}
