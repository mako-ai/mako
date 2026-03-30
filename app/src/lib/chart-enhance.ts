/**
 * Chart enhancement utilities — render-time upgrades for Vega-Lite specs.
 *
 * These functions are applied transparently during chart rendering to inject
 * best-practice interaction patterns (hover rules, all-series tooltips) without
 * requiring the AI agent or auto-spec generator to produce them explicitly.
 */

type Spec = Record<string, any>;

function getMarkType(spec: Spec): string {
  if (!spec?.mark) return "";
  return typeof spec.mark === "string" ? spec.mark : spec.mark?.type || "";
}

/**
 * Detect a multi-series temporal chart and upgrade it to a layered spec with:
 * - The original line/area layer
 * - A hover-rule layer with nearest-point selection, conditional opacity,
 *   pivot transform, and dynamic all-series tooltip
 *
 * Skips specs that are already layered or don't match the pattern.
 */
export function enhanceMultiSeriesHover(spec: Spec, data: any[]): Spec {
  if (!spec || data.length === 0) return spec;
  if (spec.layer) return spec;

  const mark = getMarkType(spec);
  if (mark !== "line" && mark !== "area") return spec;

  const enc = spec.encoding;
  if (!enc) return spec;

  const colorField = enc.color?.field;
  if (!colorField) return spec;

  const xEnc = enc.x;
  if (!xEnc) return spec;
  const isTemporalX = xEnc.type === "temporal" || xEnc.timeUnit;
  if (!isTemporalX) return spec;

  const xField = xEnc.field;
  const yField = enc.y?.field;
  if (!xField || !yField) return spec;

  const seriesValues = Array.from(
    new Set(data.map(row => row[colorField]).filter(v => v != null)),
  ).sort((a, b) => String(a).localeCompare(String(b)));

  if (seriesValues.length === 0 || seriesValues.length > 50) return spec;

  const { transform, title, description, width, height, autosize, ...rest } =
    spec;

  const outer: Spec = {};
  if (title !== undefined) outer.title = title;
  if (description !== undefined) outer.description = description;
  if (width !== undefined) outer.width = width;
  if (height !== undefined) outer.height = height;
  if (autosize !== undefined) outer.autosize = autosize;
  if (transform !== undefined) outer.transform = transform;

  const lineLayer: Spec = { ...rest };

  const tooltipEntries: Spec[] = [
    {
      field: xField,
      type: "temporal",
      ...(xEnc.title ? { title: xEnc.title } : {}),
      ...(xEnc.timeUnit ? { timeUnit: xEnc.timeUnit } : {}),
    },
    ...seriesValues.map(v => ({
      field: String(v),
      type: "quantitative" as const,
      format: enc.y?.format || ".2f",
    })),
  ];

  const hoverRuleLayer: Spec = {
    params: [
      {
        name: "__mako_tooltip",
        select: {
          type: "point",
          fields: [xField],
          nearest: true,
          on: "pointerover",
          clear: "pointerout",
        },
      },
    ],
    transform: [
      {
        pivot: colorField,
        value: yField,
        groupby: [xField],
      },
    ],
    mark: { type: "rule", color: "#888", strokeWidth: 1 },
    encoding: {
      x: { field: xField, type: "temporal" },
      opacity: {
        value: 0,
        condition: {
          param: "__mako_tooltip",
          empty: false,
          value: 0.5,
        },
      },
      tooltip: tooltipEntries,
    },
  };

  return {
    ...outer,
    layer: [lineLayer, hoverRuleLayer],
  };
}

/**
 * Ensure a spec has tooltip entries. If encoding channels exist but no
 * tooltip is defined, infer tooltip from x, y, and color channels.
 * Never overwrites existing tooltips.
 */
export function ensureTooltips(spec: Spec): Spec {
  if (!spec) return spec;

  if (spec.layer) {
    let changed = false;
    const layers = spec.layer.map((layer: Spec) => {
      const patched = ensureTooltipsSingle(layer);
      if (patched !== layer) changed = true;
      return patched;
    });
    return changed ? { ...spec, layer: layers } : spec;
  }

  return ensureTooltipsSingle(spec);
}

function ensureTooltipsSingle(spec: Spec): Spec {
  const enc = spec.encoding;
  if (!enc) return spec;
  if (enc.tooltip) return spec;

  const entries: Spec[] = [];
  for (const ch of ["x", "y", "color"] as const) {
    const def = enc[ch];
    if (def?.field && def?.type) {
      entries.push({ field: def.field, type: def.type });
    }
  }

  if (entries.length === 0) return spec;

  return {
    ...spec,
    encoding: { ...enc, tooltip: entries },
  };
}
