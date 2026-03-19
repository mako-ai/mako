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

interface ResultsChartProps {
  data: any[];
  fields?: Array<{ name?: string; originalName?: string } | string>;
  spec?: MakoChartSpec | null;
  onSpecChange?: (spec: MakoChartSpec) => void;
  onRenderError?: (error: string) => void;
  onRenderSuccess?: () => void;
}

const ResultsChart: React.FC<ResultsChartProps> = ({
  data,
  fields,
  spec,
  onSpecChange,
  onRenderError,
  onRenderSuccess,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);
  const { effectiveMode } = useTheme();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!containerRef.current || !activeSpec || data.length === 0) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function render() {
      setLoading(true);
      setError(null);

      try {
        const vegaEmbedModule = await loadVegaEmbed();
        const embed = vegaEmbedModule.default;

        if (cancelled || !containerRef.current) return;

        const themeConfig = getVegaThemeConfig(effectiveMode);

        const fullSpec: any = {
          ...activeSpec,
          $schema: "https://vega.github.io/schema/vega-lite/v5.json",
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
        setLoading(false);
        onRenderSuccess?.();
      } catch (e: any) {
        if (!cancelled) {
          const errorMsg = e?.message || "Failed to render chart";
          setError(errorMsg);
          setLoading(false);
          onRenderError?.(errorMsg);
        }
      }
    }

    render();

    return () => {
      cancelled = true;
      if (viewRef.current) {
        viewRef.current.finalize();
        viewRef.current = null;
      }
    };
  }, [activeSpec, data, effectiveMode, onRenderError, onRenderSuccess]);

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
