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
 * Detect whether a layer is a hover-rule layer by structure:
 * rule mark + at least one param with point selection on a single field.
 */
function isHoverRuleLayer(layer: Spec): boolean {
  if (getMarkType(layer) !== "rule") return false;
  if (!Array.isArray(layer.params) || layer.params.length === 0) return false;
  return layer.params.some(
    (p: any) =>
      p?.select?.type === "point" &&
      Array.isArray(p.select.fields) &&
      p.select.fields.length === 1,
  );
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

  const hoverLayer = spec.layer.find(isHoverRuleLayer);
  if (!hoverLayer) return spec;

  const hoverParam = hoverLayer.params.find(
    (p: any) =>
      p?.select?.type === "point" &&
      Array.isArray(p.select.fields) &&
      p.select.fields.length === 1,
  );
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

  // Attach metadata only — never mutate the spec's layers or tooltip entries.
  return {
    ...spec,
    __mako_tooltip_meta: {
      xField: temporalEntry.field,
      xTitle: temporalEntry.title || undefined,
      seriesFields,
    },
  };
}
