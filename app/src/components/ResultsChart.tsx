import React, {
  useRef,
  useEffect,
  useMemo,
  useCallback,
  useState,
} from "react";
import {
  Box,
  Typography,
  IconButton,
  Tooltip,
  CircularProgress,
} from "@mui/material";
import { Download, Undo2 } from "lucide-react";
import { useTheme } from "../contexts/ThemeContext";
import { MakoChartSpec } from "../lib/chart-spec";
import { generateAutoSpec } from "../lib/chart-auto-spec";
import { getVegaThemeConfig } from "../lib/chart-theme";

type VegaEmbedModule = typeof import("vega-embed");

let vegaEmbedPromise: Promise<VegaEmbedModule> | null = null;

function loadVegaEmbed(): Promise<VegaEmbedModule> {
  if (!vegaEmbedPromise) {
    vegaEmbedPromise = import("vega-embed");
  }
  return vegaEmbedPromise;
}

export interface CrossFilterSelection {
  field: string;
  values: unknown[];
  type: "point" | "interval";
}

function getMarkType(spec: Record<string, any>): string {
  if (!spec?.mark) return "";
  return typeof spec.mark === "string" ? spec.mark : spec.mark?.type || "";
}

/**
 * Inject a Vega-Lite selection param into the spec so that clicking
 * chart elements (pie slices, bars, etc.) produces a selection signal.
 */
function injectSelectionParams(spec: Record<string, any>): Record<string, any> {
  if (!spec) return spec;
  if (spec.layer) return spec;
  const existingParams = Array.isArray(spec.params) ? spec.params : [];
  const hasCrossfilterParam = existingParams.some(
    (param: any) => param?.name === "crossfilter",
  );
  if (hasCrossfilterParam) return spec;

  const mark = getMarkType(spec);
  const enc = spec.encoding || {};
  let selectionConfig: Record<string, any> | null = null;

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

  const enhanced: Record<string, any> = { ...spec };
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
  onSelectionChange?: (selection: CrossFilterSelection | null) => void;
}

const ResultsChart: React.FC<ResultsChartProps> = ({
  data,
  fields,
  spec,
  onSpecChange,
  onRenderError,
  onRenderSuccess,
  enableSelection,
  onSelectionChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const selectionEmitFrameRef = useRef<number | null>(null);
  const lastSelectionRef = useRef<string>("__init__");
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
  const isCustomSpec = spec != null;

  const handleReset = useCallback(() => {
    if (autoSpec && onSpecChange) {
      onSpecChange(null as unknown as MakoChartSpec);
    }
  }, [autoSpec, onSpecChange]);

  const handleDownload = useCallback(async (format: "png" | "svg") => {
    if (!viewRef.current) return;
    try {
      const url = await viewRef.current.toImageURL(
        format,
        format === "png" ? 2 : undefined,
      );
      const link = document.createElement("a");
      link.download = `chart.${format}`;
      link.href = url;
      link.click();
    } catch {
      // Silently fail — download is best-effort
    }
  }, []);

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

    async function render() {
      setLoading(true);
      setError(null);

      try {
        const vegaEmbedModule = await loadVegaEmbed();
        const embed = vegaEmbedModule.default;

        if (cancelled || !containerRef.current) return;

        const themeConfig = getVegaThemeConfig(effectiveMode);

        const baseSpec = enableSelection
          ? injectSelectionParams(activeSpec as Record<string, any>)
          : activeSpec;

        const fullSpec: any = {
          ...baseSpec,
          $schema: "https://vega.github.io/schema/vega-lite/v6.json",
          width: "container",
          height: "container",
          autosize: { type: "fit", contains: "padding" },
          data: { values: data },
        };

        if (viewRef.current) {
          viewRef.current.finalize();
          viewRef.current = null;
        }

        const result = await embed(containerRef.current, fullSpec, {
          actions: false,
          renderer: "canvas",
          config: themeConfig,
        });

        if (cancelled) {
          result.view.finalize();
          return;
        }

        viewRef.current = result.view;

        if (enableSelection && onSelectionChangeRef.current) {
          const scheduleEmitSelection = () => {
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
                  onSelectionChangeRef.current?.(next);
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
              scheduleEmitSelection();
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
      {/* Chart toolbar */}
      <Box
        sx={{
          px: 1,
          py: 0.5,
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          backgroundColor: "background.default",
          minHeight: 36,
        }}
      >
        <Tooltip title="Download PNG">
          <IconButton
            size="small"
            onClick={() => handleDownload("png")}
            sx={{ p: 0.5 }}
          >
            <Download size={16} />
          </IconButton>
        </Tooltip>
        <Tooltip title="Download SVG">
          <IconButton
            size="small"
            onClick={() => handleDownload("svg")}
            sx={{ p: 0.5 }}
          >
            <Download size={16} />
          </IconButton>
        </Tooltip>
        {isCustomSpec && (
          <Tooltip title="Revert to auto-generated chart">
            <IconButton size="small" onClick={handleReset} sx={{ p: 0.5 }}>
              <Undo2 size={16} />
            </IconButton>
          </Tooltip>
        )}
        <Box sx={{ flex: 1 }} />
        {isCustomSpec && (
          <Typography variant="caption" color="text.secondary">
            Custom spec
          </Typography>
        )}
      </Box>

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

export default ResultsChart;
