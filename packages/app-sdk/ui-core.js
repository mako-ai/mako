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
