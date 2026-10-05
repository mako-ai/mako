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
import { refreshBinding } from "./index.js";
import { formatSeconds as fmtSecs, normalizeTone, refreshOrder } from "./ui-core.js";

export { normalizeTone, refreshOrder };

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
  const hasPanel = title != null || schedule != null || sources.length > 0 || action || footer;

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
        ? "Running"
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
