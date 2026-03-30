/**
 * Custom tooltip formatter for multi-series hover-rule charts.
 *
 * Renders each series with an inline SVG colored dot matching the
 * chart's color scale, and appends a "Total" row when multiple
 * series are visible. Used by ResultsChart when the spec carries
 * `__mako_tooltip_meta` (injected by chart-enhance.ts).
 */

export interface TooltipMeta {
  xField: string;
  xTitle?: string;
  seriesFields: string[];
}

function fmtNum(val: unknown): string {
  if (typeof val === "number") {
    return val.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: val % 1 === 0 ? 0 : 2,
    });
  }
  const str = String(val ?? "");
  const cleaned = str.replace(/,/g, "");
  const n = parseFloat(cleaned);
  if (isNaN(n)) return str;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: n % 1 === 0 ? 0 : 2,
  });
}

const DOT_SIZE = 8;
const DOT_GAP = 4;
const DOT_SLOT = DOT_SIZE + DOT_GAP;

function svgDot(color: string): string {
  return `<svg width="${DOT_SIZE}" height="${DOT_SIZE}" style="display:inline-block;vertical-align:-1px;margin-right:${DOT_GAP}px"><circle cx="${DOT_SIZE / 2}" cy="${DOT_SIZE / 2}" r="${DOT_SIZE / 2}" fill="${color}"/></svg>`;
}

function dotSpacer(): string {
  return `<span style="display:inline-block;width:${DOT_SLOT}px"></span>`;
}

/**
 * Build a vega-tooltip `formatTooltip` callback.
 *
 * `colorMapRef.current` is populated after embed from `view.scale('color')`,
 * so it will always be filled before the first hover triggers this function.
 */
export function createMakoTooltipFormatter(
  meta: TooltipMeta,
  colorMapRef: { current: Record<string, string> },
) {
  const dateKey = meta.xTitle || meta.xField;

  return function formatTooltip(
    value: Record<string, unknown>,
    sanitize: (v: string) => string,
  ): string {
    if (!value || typeof value !== "object") return "";

    const colorMap = colorMapRef.current;
    const dateKeys = new Set([dateKey, meta.xField]);
    const skipKey = (k: string) =>
      dateKeys.has(k) || /^(__mako_|—\s*total$|total$)/i.test(k.trim());

    const rows: string[] = [];
    const kStyle = `white-space:nowrap;padding:1px 8px 1px 0`;
    const vStyle = `text-align:right;font-variant-numeric:tabular-nums;padding:1px 0`;

    // Date header (invisible spacer keeps it aligned with dotted rows)
    const dateVal = value[dateKey] ?? value[meta.xField];
    if (dateVal != null) {
      rows.push(
        `<tr><td style="${kStyle}">${dotSpacer()}${sanitize(String(dateKey))}</td><td style="${vStyle}">${sanitize(String(dateVal))}</td></tr>`,
      );
    }

    // Series rows: iterate the value's own keys, display labels verbatim,
    // and match colors by trying exact key then fuzzy substring against
    // the color scale entries.
    let total = 0;
    let count = 0;
    for (const [key, raw] of Object.entries(value)) {
      if (raw == null || skipKey(key)) continue;
      const num =
        typeof raw === "number"
          ? raw
          : parseFloat(String(raw).replace(/,/g, ""));
      if (isNaN(num)) continue;
      total += num;
      count++;
      const color =
        colorMap[key] ||
        Object.keys(colorMap).reduce<string | null>(
          (found, f) => found || (key.includes(f) ? colorMap[f] : null),
          null,
        ) ||
        "#888";
      rows.push(
        `<tr><td style="${kStyle}">${svgDot(color)} ${sanitize(key)}</td><td style="${vStyle}">${sanitize(fmtNum(raw))}</td></tr>`,
      );
    }

    // Total row (only when there are 2+ visible series)
    if (count > 1) {
      const sep = "border-top:1px solid rgba(128,128,128,0.3);padding-top:3px";
      rows.push(
        `<tr><td style="${kStyle};${sep}">${svgDot("#888")} Total</td><td style="${vStyle};${sep}">${sanitize(fmtNum(total))}</td></tr>`,
      );
    }

    return `<table style="border-spacing:0">${rows.join("")}</table>`;
  };
}

/**
 * After vega-embed finishes, call this to populate the color map
 * from the Vega view's compiled color scale.
 */
export function populateColorMap(
  view: { scale: (name: string) => (val: unknown) => string },
  seriesFields: string[],
  colorMapRef: { current: Record<string, string> },
): void {
  try {
    const colorScale = view.scale("color");
    if (typeof colorScale === "function") {
      for (const s of seriesFields) {
        colorMapRef.current[s] = colorScale(s);
      }
    }
  } catch {
    // Scale not available — dots fall back to gray
  }
}
