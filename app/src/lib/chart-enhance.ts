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
  if (spec.__mako_tooltip_meta) return spec;

  if (spec.layer) return extractMetaFromLayeredSpec(spec);

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

  const seriesFieldStrs = seriesValues.map(String);

  const tooltipEntries: Spec[] = [
    {
      field: xField,
      type: "temporal",
      ...(xEnc.title ? { title: xEnc.title } : {}),
      ...(xEnc.timeUnit ? { timeUnit: xEnc.timeUnit } : {}),
    },
    ...seriesFieldStrs.map(v => ({
      field: v,
      type: "quantitative" as const,
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
    __mako_tooltip_meta: {
      xField,
      xTitle: xEnc.title || undefined,
      seriesFields: seriesFieldStrs,
    },
  };
}

/**
 * For already-layered specs (e.g. built by the agent using the template),
 * detect the `__mako_tooltip` hover-rule layer and extract enough metadata
 * for the custom tooltip handler to render SVG dots + total.
 */
function extractMetaFromLayeredSpec(spec: Spec): Spec {
  if (!Array.isArray(spec.layer)) return spec;

  const hoverLayerIdx = spec.layer.findIndex(
    (layer: Spec) =>
      Array.isArray(layer.params) &&
      layer.params.some((p: any) => p?.name?.startsWith("__mako_tooltip")),
  );
  if (hoverLayerIdx === -1) return spec;

  const hoverLayer = spec.layer[hoverLayerIdx];
  const tooltipEntries = hoverLayer.encoding?.tooltip;
  if (!Array.isArray(tooltipEntries) || tooltipEntries.length === 0) {
    return spec;
  }

  const temporalEntry = tooltipEntries.find((e: any) => e.type === "temporal");
  if (!temporalEntry) return spec;

  const isMetaField = (f: string) =>
    /^(__mako_|—\s*total$|total$)/i.test(f.trim());

  const seriesFields = tooltipEntries
    .filter(
      (e: any) => e.type === "quantitative" && !isMetaField(String(e.field)),
    )
    .map((e: any) => String(e.field));

  if (seriesFields.length === 0) return spec;

  // Strip title + format from series tooltip entries and drop any
  // agent-injected total/meta fields — the custom handler renders its own.
  const cleanedTooltips = tooltipEntries
    .filter(
      (e: any) => e.type !== "quantitative" || !isMetaField(String(e.field)),
    )
    .map((e: any) => {
      if (e.type === "temporal") return e;
      const { title: _t, format: _f, ...rest } = e;
      return rest;
    });

  const cleanedLayers = spec.layer.map((layer: Spec, i: number) => {
    if (i !== hoverLayerIdx) return layer;
    return {
      ...layer,
      encoding: { ...layer.encoding, tooltip: cleanedTooltips },
    };
  });

  return {
    ...spec,
    layer: cleanedLayers,
    __mako_tooltip_meta: {
      xField: temporalEntry.field,
      xTitle: temporalEntry.title || undefined,
      seriesFields,
    },
  };
}
