import { enhanceMultiSeriesHover } from "./chart-enhance";
import type { TooltipMeta } from "./chart-tooltip";

type Spec = Record<string, any>;

export interface CrossFilterSelection {
  field: string;
  values: unknown[];
  type: "point" | "interval";
  additive?: boolean;
}

interface BuildRenderPlanInput {
  spec: Spec;
  data: any[];
  enableSelection: boolean;
  activeSelection: CrossFilterSelection | null | undefined;
}

interface BuildRenderPlanOutput {
  spec: Spec;
  tooltipMeta?: TooltipMeta;
}

function getMarkType(spec: Spec): string {
  if (!spec?.mark) return "";
  return typeof spec.mark === "string" ? spec.mark : spec.mark?.type || "";
}

function stabilizeColorDomain(spec: Spec, data: any[]): Spec {
  if (!spec || data.length === 0) return spec;

  const patchEncoding = (encoding: Spec | undefined): Spec | undefined => {
    if (!encoding?.color?.field) return encoding;
    if (encoding.color.scale?.domain) return encoding;

    const field = encoding.color.field;
    const unique = Array.from(new Set(data.map(row => row[field])))
      .filter(v => v != null)
      .sort((a, b) => String(a).localeCompare(String(b)));

    if (unique.length === 0) return encoding;

    return {
      ...encoding,
      color: {
        ...encoding.color,
        scale: { ...encoding.color.scale, domain: unique },
      },
    };
  };

  if (Array.isArray(spec.layer)) {
    const patchedLayers = spec.layer.map((layer: Spec) => {
      const patched = patchEncoding(layer.encoding);
      return patched !== layer.encoding
        ? { ...layer, encoding: patched }
        : layer;
    });
    const changed = patchedLayers.some(
      (l: Spec, i: number) => l !== spec.layer[i],
    );
    return changed ? { ...spec, layer: patchedLayers } : spec;
  }

  const patched = patchEncoding(spec.encoding);
  return patched !== spec.encoding ? { ...spec, encoding: patched } : spec;
}

function hasCrossfilterInNode(node: Spec | undefined): boolean {
  if (!node || typeof node !== "object") return false;

  if (
    Array.isArray(node.params) &&
    node.params.some((param: any) => param?.name === "crossfilter")
  ) {
    return true;
  }

  if (
    node.selection &&
    typeof node.selection === "object" &&
    Object.prototype.hasOwnProperty.call(node.selection, "crossfilter")
  ) {
    return true;
  }

  return false;
}

function injectSelectionParams(spec: Spec): Spec {
  if (!spec) return spec;

  if (Array.isArray(spec.layer)) {
    const alreadyHasCrossfilter =
      hasCrossfilterInNode(spec) ||
      spec.layer.some((layer: Spec) => hasCrossfilterInNode(layer));
    if (alreadyHasCrossfilter) return spec;

    const layerIndex = spec.layer.findIndex((layer: Spec) => {
      const mark = getMarkType(layer);
      const enc = layer.encoding || {};
      if (mark !== "bar") return false;
      return (
        !!enc.x?.field &&
        (enc.x.type === "nominal" ||
          enc.x.type === "ordinal" ||
          !!enc.color?.field)
      );
    });
    if (layerIndex === -1) return spec;

    const targetLayer = spec.layer[layerIndex];
    const enc = targetLayer.encoding || {};
    const selectionField =
      enc.x?.field && (enc.x.type === "nominal" || enc.x.type === "ordinal")
        ? enc.x.field
        : enc.color?.field;
    if (!selectionField) return spec;

    const layerParams = Array.isArray(targetLayer.params)
      ? targetLayer.params
      : [];
    const nextEncoding =
      enc && !enc.opacity
        ? {
            ...enc,
            opacity: {
              condition: { param: "crossfilter", value: 1 },
              value: 0.3,
            },
          }
        : enc;
    const updatedLayer = {
      ...targetLayer,
      encoding: nextEncoding,
      params: [
        ...layerParams,
        {
          name: "crossfilter",
          select: { type: "point", fields: [selectionField] },
        },
      ],
    };
    const nextLayers = [...spec.layer];
    nextLayers[layerIndex] = updatedLayer;
    return { ...spec, layer: nextLayers };
  }

  const existingParams = Array.isArray(spec.params) ? spec.params : [];
  const hasCrossfilterParam = existingParams.some(
    (param: any) => param?.name === "crossfilter",
  );
  if (hasCrossfilterParam) return spec;

  const mark = getMarkType(spec);
  const enc = spec.encoding || {};
  let selectionConfig: Spec | null = null;

  if (mark === "arc") {
    if (enc.color?.field) {
      selectionConfig = {
        name: "crossfilter",
        select: { type: "point", encodings: ["color"] },
      };
    }
  } else if (mark === "bar") {
    if (
      enc.x?.field &&
      (enc.x.type === "nominal" || enc.x.type === "ordinal")
    ) {
      selectionConfig = {
        name: "crossfilter",
        select: { type: "point", encodings: ["x"] },
      };
    } else if (enc.color?.field) {
      selectionConfig = {
        name: "crossfilter",
        select: { type: "point", encodings: ["color"] },
      };
    }
  } else if (mark === "line" || mark === "area") {
    if (enc.x?.field) {
      selectionConfig = {
        name: "crossfilter",
        select: { type: "interval", encodings: ["x"] },
      };
    }
  } else if (mark === "point" || mark === "circle" || mark === "square") {
    selectionConfig = {
      name: "crossfilter",
      select: { type: "interval" },
    };
  }

  if (!selectionConfig) return spec;

  const enhanced: Spec = { ...spec };
  enhanced.params = [...existingParams, selectionConfig];

  if (enhanced.encoding && !enhanced.encoding.opacity) {
    enhanced.encoding = {
      ...enhanced.encoding,
      opacity: {
        condition: { param: "crossfilter", value: 1 },
        value: 0.3,
      },
    };
  }

  return enhanced;
}

function injectActiveSelection(
  spec: Spec,
  activeSelection: CrossFilterSelection | null | undefined,
): Spec {
  if (!activeSelection) return spec;

  const withValue = (param: any) => {
    if (param?.name !== "crossfilter") return param;
    if (activeSelection.type === "point") {
      return {
        ...param,
        value: activeSelection.values.map(v => ({
          [activeSelection.field]: v,
        })),
      };
    }
    if (
      activeSelection.type === "interval" &&
      activeSelection.values.length === 2
    ) {
      return {
        ...param,
        value: { [activeSelection.field]: activeSelection.values },
      };
    }
    return param;
  };

  const rewrite = (node: Spec): Spec => {
    let changed = false;
    const next: Spec = { ...node };
    if (Array.isArray(node.params)) {
      next.params = node.params.map((param: any) => {
        const updated = withValue(param);
        if (updated !== param) changed = true;
        return updated;
      });
    }
    if (Array.isArray(node.layer)) {
      next.layer = node.layer.map((child: Spec) => rewrite(child));
      changed = true;
    }
    return changed ? next : node;
  };

  return rewrite(spec);
}

function sanitizeSelectionNames(spec: Spec): Spec {
  if (!spec || typeof spec !== "object") return spec;

  const used = new Set<string>();

  const sanitizeNode = (node: Spec): Spec => {
    let changed = false;
    const nextNode: Spec = { ...node };

    const dedupeParams = (params: any[]): any[] => {
      const next: any[] = [];
      for (const param of params) {
        const name =
          param?.name && typeof param.name === "string" ? param.name : null;
        if (!name) {
          next.push(param);
          continue;
        }
        if (used.has(name)) {
          changed = true;
          continue;
        }
        used.add(name);
        next.push(param);
      }
      return next;
    };

    if (Array.isArray(nextNode.params)) {
      nextNode.params = dedupeParams(nextNode.params);
      changed = true;
    }

    if (Array.isArray(nextNode.layer)) {
      nextNode.layer = nextNode.layer.map((child: Spec) => sanitizeNode(child));
      changed = true;
    }

    return changed ? nextNode : node;
  };

  return sanitizeNode(spec);
}

export function buildChartRenderPlan({
  spec,
  data,
  enableSelection,
  activeSelection,
}: BuildRenderPlanInput): BuildRenderPlanOutput {
  const withSelection = enableSelection ? injectSelectionParams(spec) : spec;
  const withHoverEnhancement = enhanceMultiSeriesHover(withSelection, data);
  const withActiveSelection = enableSelection
    ? injectActiveSelection(withHoverEnhancement, activeSelection)
    : withHoverEnhancement;
  const withStabilizedColors = stabilizeColorDomain(withActiveSelection, data);
  const withSanitizedSelections = sanitizeSelectionNames(withStabilizedColors);

  const { __mako_tooltip_meta: tooltipMetaRaw, ...renderSpec } =
    withSanitizedSelections as Spec;

  return {
    spec: renderSpec,
    tooltipMeta: tooltipMetaRaw as TooltipMeta | undefined,
  };
}
