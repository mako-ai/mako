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

function isPointHoverParam(param: any): boolean {
  return (
    param?.select?.type === "point" &&
    Array.isArray(param.select.fields) &&
    param.select.fields.length === 1 &&
    param?.name !== "crossfilter"
  );
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

  if (spec.layer) {
    const normalized = normalizeBarHoverLayer(spec);
    return extractMetaFromLayeredSpec(normalized);
  }

  const stackedBarEnhanced = enhanceSimpleStackedBarHover(spec, data);
  if (stackedBarEnhanced !== spec) {
    return stackedBarEnhanced;
  }

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

function enhanceSimpleStackedBarHover(spec: Spec, data: any[]): Spec {
  const mark = getMarkType(spec);
  if (mark !== "bar") return spec;

  const enc = spec.encoding || {};
  const xEnc = enc.x;
  const yEnc = enc.y;
  const colorEnc = enc.color;
  if (!xEnc?.field || !yEnc?.field || !colorEnc?.field) return spec;
  if (xEnc.type !== "nominal" && xEnc.type !== "ordinal") return spec;

  const colorField = colorEnc.field;
  const xField = xEnc.field;
  const yField = yEnc.field;

  const seriesValues = resolveStackedBarSeriesValues(
    spec,
    data,
    colorField,
    xField,
    yField,
  );
  if (seriesValues.length <= 1 || seriesValues.length > 50) return spec;

  const { transform, title, description, width, height, autosize, ...rest } =
    spec;
  const outer: Spec = {};
  if (title !== undefined) outer.title = title;
  if (description !== undefined) outer.description = description;
  if (width !== undefined) outer.width = width;
  if (height !== undefined) outer.height = height;
  if (autosize !== undefined) outer.autosize = autosize;
  if (transform !== undefined) outer.transform = transform;

  const barLayer: Spec = { ...rest };
  const tooltipEntries: Spec[] = [
    {
      field: xField,
      type: xEnc.type || "nominal",
      ...(xEnc.title ? { title: xEnc.title } : {}),
    },
    ...seriesValues.map(v => ({
      field: v,
      type: "quantitative" as const,
    })),
  ];

  const hoverLayer: Spec = {
    params: [
      {
        name: "__mako_tooltip",
        select: {
          type: "point",
          fields: [xField],
          on: "pointerover",
          clear: "pointerout",
        },
      },
    ],
    transform: [
      {
        joinaggregate: [{ op: "sum", field: yField, as: "__mako_total" }],
        groupby: [xField],
      },
      {
        pivot: colorField,
        value: yField,
        groupby: [xField, "__mako_total"],
      },
    ],
    mark: { type: "bar", fillOpacity: 0, strokeOpacity: 0 },
    encoding: {
      x: { ...xEnc, field: xField },
      y: { field: "__mako_total", type: "quantitative" },
      tooltip: tooltipEntries,
    },
  };

  return {
    ...outer,
    layer: [barLayer, hoverLayer],
    __mako_tooltip_meta: {
      xField,
      xTitle: xEnc.title || undefined,
      seriesFields: seriesValues,
    },
  };
}

function resolveStackedBarSeriesValues(
  spec: Spec,
  data: any[],
  colorField: string,
  xField: string,
  yField: string,
): string[] {
  const fromData = Array.from(
    new Set(data.map(row => row[colorField]).filter(v => v != null)),
  )
    .map(String)
    .sort((a, b) => a.localeCompare(b));
  if (fromData.length > 0) return fromData;

  // If the color field is created via fold/as transform, infer categories
  // from the fold source columns.
  const transforms = Array.isArray(spec.transform) ? spec.transform : [];
  for (const transform of transforms) {
    const foldCols = Array.isArray(transform?.fold) ? transform.fold : null;
    const asFields = Array.isArray(transform?.as) ? transform.as : null;
    const foldedField = asFields?.[0];
    if (
      foldCols &&
      foldedField &&
      String(foldedField) === colorField &&
      foldCols.length > 0
    ) {
      return foldCols.map((v: unknown) => String(v));
    }
  }

  // Fallback: infer from quantitative tooltip fields (excluding x/meta fields).
  const tooltip = Array.isArray(spec.encoding?.tooltip)
    ? spec.encoding.tooltip
    : [];
  const inferred = tooltip
    .filter((entry: any) => {
      const field = String(entry?.field ?? "");
      return (
        entry?.type === "quantitative" &&
        field &&
        field !== yField &&
        field !== xField &&
        !/^(__mako_|—\s*total$|total$)/i.test(field.trim())
      );
    })
    .map((entry: any) => String(entry.field));
  return Array.from(new Set(inferred));
}

/**
 * For layered stacked-bar hover patterns, replace the visible hover rule with
 * an invisible bar overlay so tooltips appear only while hovering bars.
 * This keeps the rich multi-series tooltip but removes the black vertical line
 * and nearest-point snapping behavior.
 */
function normalizeBarHoverLayer(spec: Spec): Spec {
  if (!Array.isArray(spec.layer)) return spec;

  const barLayerIndex = spec.layer.findIndex(
    (layer: Spec) => getMarkType(layer) === "bar",
  );
  if (barLayerIndex === -1) return spec;
  const barLayer = spec.layer[barLayerIndex];
  const hoverLayerIndex = spec.layer.findIndex(isHoverTooltipLayer);
  if (hoverLayerIndex === -1) return spec;
  const hoverLayer = spec.layer[hoverLayerIndex];

  const barEnc = barLayer.encoding || {};
  const hoverEnc = hoverLayer.encoding || {};
  const xField =
    barEnc.x?.field ??
    hoverEnc.x?.field ??
    hoverLayer.params?.[0]?.select?.fields?.[0];
  const xType = barEnc.x?.type ?? hoverEnc.x?.type ?? "nominal";
  const yField = barEnc.y?.field;
  const colorField = barEnc.color?.field;
  const tooltip = hoverEnc.tooltip;

  if (
    !xField ||
    !yField ||
    !colorField ||
    !Array.isArray(tooltip) ||
    tooltip.length === 0
  ) {
    return spec;
  }

  const hoverParam = Array.isArray(hoverLayer.params)
    ? hoverLayer.params.find(isPointHoverParam)
    : null;

  const nextHoverLayer: Spec = {
    ...hoverLayer,
    params: [
      {
        ...(hoverParam || {}),
        name: "__mako_tooltip",
        select: {
          type: "point",
          fields: [xField],
          on: "pointerover",
          clear: "pointerout",
        },
      },
    ],
    transform: [
      {
        joinaggregate: [{ op: "sum", field: yField, as: "__mako_total" }],
        groupby: [xField],
      },
      {
        pivot: colorField,
        value: yField,
        groupby: [xField, "__mako_total"],
      },
    ],
    mark: { type: "bar", fillOpacity: 0, strokeOpacity: 0 },
    encoding: {
      x: { ...(barEnc.x || {}), field: xField, type: xType },
      y: {
        field: "__mako_total",
        type: "quantitative",
      },
      tooltip,
    },
  };

  const nextLayers = [...spec.layer];
  nextLayers[hoverLayerIndex] = nextHoverLayer;
  return { ...spec, layer: nextLayers };
}

/**
 * Detect whether a layer is a hover-tooltip layer by structure while
 * explicitly ignoring crossfilter selections.
 */
function isHoverTooltipLayer(layer: Spec): boolean {
  const mark = getMarkType(layer);
  if (mark !== "rule" && mark !== "bar") return false;
  if (!Array.isArray(layer.params) || layer.params.length === 0) return false;
  return layer.params.some(isPointHoverParam);
}

/**
 * Recursively walk an encoding object and rename any `condition.param`
 * references from `oldName` to `newName`.
 */
function updateParamRefs(encoding: any, oldName: string, newName: string) {
  if (!encoding || typeof encoding !== "object") return;
  for (const channel of Object.values(encoding)) {
    const cond = (channel as any)?.condition;
    if (!cond) continue;
    const conditions = Array.isArray(cond) ? cond : [cond];
    for (const c of conditions) {
      if (c && c.param === oldName) {
        c.param = newName;
      }
    }
  }
}

/**
 * For already-layered specs (e.g. built by the agent using the template),
 * detect the hover-rule layer and extract enough metadata for the custom
 * tooltip handler to render SVG dots + total.
 *
 * Detection is structural (rule mark + point selection), not name-based,
 * so agent-generated specs with non-standard param names are handled.
 * Non-standard names are auto-corrected to `__mako_tooltip` so the
 * condition reference stays in sync.
 */
function extractMetaFromLayeredSpec(spec: Spec): Spec {
  if (!Array.isArray(spec.layer)) return spec;

  const hoverLayer = spec.layer.find(isHoverTooltipLayer);
  if (!hoverLayer) return spec;

  const hoverParam = hoverLayer.params.find(isPointHoverParam);
  if (hoverParam && hoverParam.name !== "__mako_tooltip") {
    const oldName = hoverParam.name;
    hoverParam.name = "__mako_tooltip";
    for (const layer of spec.layer) {
      updateParamRefs(layer.encoding, oldName, "__mako_tooltip");
    }
  }

  const tooltipEntries = hoverLayer.encoding?.tooltip;
  if (!Array.isArray(tooltipEntries) || tooltipEntries.length === 0) {
    return spec;
  }

  const selectedXField = hoverParam?.select?.fields?.[0];
  const xEntry =
    tooltipEntries.find((e: any) => e?.field === selectedXField) ||
    tooltipEntries.find(
      (e: any) =>
        e?.type === "temporal" ||
        e?.type === "ordinal" ||
        e?.type === "nominal",
    );
  const xField = String(xEntry?.field ?? selectedXField ?? "");
  if (!xField) return spec;

  const isMetaField = (f: string) =>
    /^(__mako_|—\s*total$|total$)/i.test(f.trim());

  const seriesFields = tooltipEntries
    .filter(
      (e: any) =>
        e.type === "quantitative" &&
        String(e.field) !== xField &&
        !isMetaField(String(e.field)),
    )
    .map((e: any) => String(e.field));

  if (seriesFields.length === 0) return spec;

  // Attach metadata only — never mutate the spec's layers or tooltip entries.
  return {
    ...spec,
    __mako_tooltip_meta: {
      xField,
      xTitle: xEntry?.title || undefined,
      seriesFields,
    },
  };
}
