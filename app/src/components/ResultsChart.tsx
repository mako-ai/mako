import React, {
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useState,
} from "react";
import { Box, Typography, CircularProgress } from "@mui/material";
import { useTheme } from "../contexts/ThemeContext";
import { MakoChartSpec } from "../lib/chart-spec";
import { generateAutoSpec } from "../lib/chart-auto-spec";
import { getVegaThemeConfig } from "../lib/chart-theme";
import {
  buildChartRenderPlan,
  type CrossFilterSelection,
} from "../lib/chart-render-planner";
import {
  createMakoTooltipFormatter,
  populateColorMap,
  type TooltipMeta,
} from "../lib/chart-tooltip";

type VegaEmbedModule = typeof import("vega-embed");

let vegaEmbedPromise: Promise<VegaEmbedModule> | null = null;

function loadVegaEmbed(): Promise<VegaEmbedModule> {
  if (!vegaEmbedPromise) {
    vegaEmbedPromise = import("vega-embed");
  }
  return vegaEmbedPromise;
}

function parseSelectionSignal(value: any): CrossFilterSelection | null {
  if (!value || !Array.isArray(value) || value.length === 0) return null;

  const entry = value.find((item: any) => item?.fields?.[0]);
  if (!entry) return null;
  const fieldMeta = entry.fields[0];
  const field: string | undefined = fieldMeta?.field;
  if (!field) return null;

  if (fieldMeta.type === "E") {
    const projectedValues = value
      .flatMap((item: any) => {
        const values = Array.isArray(item?.values) ? item.values : [];
        if (values.length === 0) return [];
        const first = values[0];

        if (first && typeof first === "object" && !Array.isArray(first)) {
          return values
            .map((v: any) =>
              v && typeof v === "object" ? v[field] : undefined,
            )
            .filter((v: unknown) => v !== undefined);
        }

        if (Array.isArray(first)) {
          return values
            .map((v: any[]) => v[0])
            .filter((v: unknown) => v !== undefined);
        }

        return values;
      })
      .filter((v: unknown) => v !== undefined);

    const uniqueValues = Array.from(
      new Set(projectedValues.map(v => JSON.stringify(v))),
    ).map(v => JSON.parse(v));

    if (uniqueValues.length === 0) return null;
    return { field, values: uniqueValues, type: "point" };
  }

  if (fieldMeta.type === "R") {
    const lastRangeEntry = [...value]
      .reverse()
      .find((item: any) => Array.isArray(item?.values?.[0]));
    const range = lastRangeEntry?.values?.[0];
    if (Array.isArray(range) && range.length === 2) {
      return { field, values: range, type: "interval" };
    }
  }

  return null;
}

interface ResultsChartProps {
  data: any[];
  fields?: Array<{ name?: string; originalName?: string } | string>;
  spec?: MakoChartSpec | null;
  onSpecChange?: (spec: MakoChartSpec) => void;
  onRenderError?: (error: string) => void;
  onRenderSuccess?: () => void;
  enableSelection?: boolean;
  activeSelection?: CrossFilterSelection | null;
  onSelectionChange?: (selection: CrossFilterSelection | null) => void;
}

const ResultsChart: React.FC<ResultsChartProps> = ({
  data,
  fields,
  spec,
  onRenderError,
  onRenderSuccess,
  enableSelection,
  activeSelection,
  onSelectionChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const selectionEmitFrameRef = useRef<number | null>(null);
  const lastSelectionRef = useRef<string>("__init__");
  const shiftKeyRef = useRef(false);
  const onRenderErrorRef = useRef(onRenderError);
  const onRenderSuccessRef = useRef(onRenderSuccess);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const { effectiveMode } = useTheme();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onRenderErrorRef.current = onRenderError;
  }, [onRenderError]);

  useEffect(() => {
    onRenderSuccessRef.current = onRenderSuccess;
  }, [onRenderSuccess]);

  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);

  const autoSpec = useMemo(() => {
    if (data.length === 0) return null;
    return generateAutoSpec(data, fields);
  }, [data, fields]);

  const activeSpec = spec ?? autoSpec;

  const dispatchContainerResize = useCallback(() => {
    if (resizeFrameRef.current !== null) {
      cancelAnimationFrame(resizeFrameRef.current);
    }

    resizeFrameRef.current = requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      if (!viewRef.current) return;
      window.dispatchEvent(new Event("resize"));
    });
  }, []);

  useEffect(() => {
    if (!containerRef.current || !activeSpec || data.length === 0) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const containerEl = containerRef.current;
    const resizeObserver = new ResizeObserver(() => {
      if (cancelled) return;
      dispatchContainerResize();
    });
    resizeObserver.observe(containerEl);

    const handleMouseDown = (e: MouseEvent) => {
      shiftKeyRef.current = e.shiftKey;
    };
    containerEl.addEventListener("mousedown", handleMouseDown, true);

    async function render() {
      setLoading(true);
      setError(null);

      try {
        const vegaEmbedModule = await loadVegaEmbed();
        const embed = vegaEmbedModule.default;

        if (cancelled || !containerRef.current) return;

        const themeConfig = getVegaThemeConfig(effectiveMode);

        const renderPlan = buildChartRenderPlan({
          spec: activeSpec as Record<string, any>,
          data,
          enableSelection: !!enableSelection,
          activeSelection,
        });
        const baseSpec = renderPlan.spec;
        const tooltipMeta = renderPlan.tooltipMeta as TooltipMeta | undefined;

        const colorMapRef: { current: Record<string, string> } = {
          current: {},
        };
        const tooltipOpt = tooltipMeta
          ? {
              formatTooltip: createMakoTooltipFormatter(
                tooltipMeta,
                colorMapRef,
              ),
            }
          : undefined;

        // Shallow-clone each row so Vega can attach its internal
        // Symbol(vega_id) property.  Data arriving from Zustand/Immer
        // stores is frozen and would throw "object is not extensible".
        const clonedData = data.map(d => ({ ...d }));

        const fullSpec: any = {
          ...baseSpec,
          $schema: "https://vega.github.io/schema/vega-lite/v6.json",
          width: "container",
          height: "container",
          autosize: { type: "fit", contains: "padding" },
          data: { values: clonedData },
        };

        if (viewRef.current) {
          viewRef.current.finalize();
          viewRef.current = null;
        }

        const result = await embed(containerRef.current, fullSpec, {
          actions: false,
          renderer: "canvas",
          config: themeConfig,
          ...(tooltipOpt ? { tooltip: tooltipOpt } : {}),
        });

        if (tooltipMeta) {
          populateColorMap(
            result.view as any,
            tooltipMeta.seriesFields,
            colorMapRef,
          );
        }

        if (cancelled) {
          result.view.finalize();
          return;
        }

        viewRef.current = result.view;

        if (enableSelection && onSelectionChangeRef.current) {
          const scheduleEmitSelection = () => {
            const additive = shiftKeyRef.current;
            if (selectionEmitFrameRef.current !== null) {
              cancelAnimationFrame(selectionEmitFrameRef.current);
            }
            selectionEmitFrameRef.current = requestAnimationFrame(() => {
              selectionEmitFrameRef.current = null;
              if (cancelled) return;
              try {
                const store = result.view.data("crossfilter_store");
                const next = parseSelectionSignal(store);
                const signature = JSON.stringify(next);
                if (signature !== lastSelectionRef.current) {
                  lastSelectionRef.current = signature;
                  onSelectionChangeRef.current?.(
                    next ? { ...next, additive } : null,
                  );
                }
              } catch {
                if (lastSelectionRef.current !== "null") {
                  lastSelectionRef.current = "null";
                  onSelectionChangeRef.current?.(null);
                }
              }
            });
          };

          try {
            let attached = false;
            for (const signalName of [
              "crossfilter_modify",
              "crossfilter",
              "crossfilter_tuple",
            ]) {
              try {
                result.view.addSignalListener(
                  signalName,
                  (_name: string, _value: unknown) => {
                    if (cancelled) return;
                    scheduleEmitSelection();
                  },
                );
                attached = true;
              } catch {
                // Try next candidate signal
              }
            }
            if (attached) {
              // Set the dedup baseline without emitting. Emitting null
              // here would clear active cross-filter clauses when the
              // chart re-embeds after receiving filtered data from
              // another widget's selection.
              // If an activeSelection was injected into the spec, set the
              // baseline to its signature so click-to-deselect works.
              if (activeSelection) {
                const { additive: _, ...sel } = activeSelection;
                lastSelectionRef.current = JSON.stringify(sel);
              } else {
                lastSelectionRef.current = "null";
              }
            } else if (lastSelectionRef.current !== "null") {
              lastSelectionRef.current = "null";
              onSelectionChangeRef.current?.(null);
            }
          } catch {
            // Signal may not exist for this spec — ignore
          }
        }

        dispatchContainerResize();
        setLoading(false);
        onRenderSuccessRef.current?.();
      } catch (e: any) {
        if (!cancelled) {
          const errorMsg = e?.message || "Failed to render chart";
          setError(errorMsg);
          setLoading(false);
          onRenderErrorRef.current?.(errorMsg);
        }
      }
    }

    render();

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      containerEl.removeEventListener("mousedown", handleMouseDown, true);
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      if (selectionEmitFrameRef.current !== null) {
        cancelAnimationFrame(selectionEmitFrameRef.current);
        selectionEmitFrameRef.current = null;
      }
      lastSelectionRef.current = "__init__";
      if (viewRef.current) {
        viewRef.current.finalize();
        viewRef.current = null;
      }
    };
  }, [
    activeSelection,
    activeSpec,
    data,
    dispatchContainerResize,
    effectiveMode,
    enableSelection,
  ]);

  if (data.length === 0) {
    return (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "text.secondary",
        }}
      >
        <Typography>No data to chart</Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Chart container */}
      <Box
        sx={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
          minHeight: 0,
        }}
      >
        {loading && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1,
              backgroundColor: "background.paper",
            }}
          >
            <CircularProgress size={24} />
          </Box>
        )}

        {error && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 1,
              backgroundColor: "background.paper",
              p: 3,
            }}
          >
            <Typography
              color="error"
              variant="body2"
              sx={{
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
                maxWidth: 500,
                textAlign: "center",
              }}
            >
              {error}
            </Typography>
          </Box>
        )}

        <Box
          ref={containerRef}
          sx={{
            width: "100%",
            height: "100%",
            "& .vega-embed": {
              width: "100%",
              height: "100%",
            },
            "& .vega-embed canvas": {
              width: "100% !important",
              height: "100% !important",
            },
          }}
        />
      </Box>
    </Box>
  );
};

export type { CrossFilterSelection };
export default ResultsChart;
