import React, { useState, useEffect } from "react";
import {
  Box,
  Typography,
  TextField,
  Button,
  IconButton,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Divider,
  Chip,
} from "@mui/material";
import { X, Copy } from "lucide-react";
import Editor from "@monaco-editor/react";
import {
  useDashboardStore,
  type DashboardWidget,
} from "../../store/dashboardStore";
import { useTheme } from "../../contexts/ThemeContext";
import { useDashboardRuntimeStore } from "../../dashboard-runtime/store";
import { previewDashboardQuery } from "../../dashboard-runtime/commands";

interface WidgetInspectorProps {
  widget: DashboardWidget;
  onClose: () => void;
  dashboardId?: string;
}

function resolveWidgetLayout(widget: DashboardWidget) {
  const fallback = { x: 0, y: 0, w: 6, h: 4 };
  const candidate = (widget as any).layout ?? (widget as any).layouts?.lg;
  if (!candidate || typeof candidate !== "object") {
    return fallback;
  }

  return {
    x: typeof candidate.x === "number" ? candidate.x : fallback.x,
    y: typeof candidate.y === "number" ? candidate.y : fallback.y,
    w: typeof candidate.w === "number" ? candidate.w : fallback.w,
    h: typeof candidate.h === "number" ? candidate.h : fallback.h,
  };
}

const WidgetInspector: React.FC<WidgetInspectorProps> = ({
  widget,
  onClose,
  dashboardId,
}) => {
  const { modifyWidget, addWidget } = useDashboardStore();
  const { effectiveMode } = useTheme();
  const runtimeSession = useDashboardRuntimeStore(state =>
    dashboardId ? state.sessions[dashboardId] || null : null,
  );
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [title, setTitle] = useState(widget.title || "");
  const [localSql, setLocalSql] = useState(widget.localSql);
  const [specJson, setSpecJson] = useState(
    widget.vegaLiteSpec ? JSON.stringify(widget.vegaLiteSpec, null, 2) : "",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(widget.title || "");
    setLocalSql(widget.localSql);
    setSpecJson(
      widget.vegaLiteSpec ? JSON.stringify(widget.vegaLiteSpec, null, 2) : "",
    );
    setError(null);
  }, [widget.id, widget.title, widget.localSql, widget.vegaLiteSpec]);

  const handleApply = () => {
    setError(null);
    const changes: Partial<DashboardWidget> = {
      title: title || undefined,
      localSql,
    };

    if (widget.type === "chart" && specJson) {
      try {
        changes.vegaLiteSpec = JSON.parse(specJson);
      } catch (e: unknown) {
        setError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    if (dashboardId) modifyWidget(dashboardId, widget.id, changes);
    onClose();
  };

  const handleDuplicate = async () => {
    const { nanoid } = await import("nanoid");
    const lgLayout = widget.layouts?.lg ?? resolveWidgetLayout(widget);
    const newWidget: DashboardWidget = {
      ...widget,
      id: nanoid(),
      title: `${widget.title || "Widget"} (copy)`,
      layouts: {
        ...(widget.layouts ?? {}),
        lg: {
          ...lgLayout,
          y: lgLayout.y + lgLayout.h,
        },
      },
    };
    if (dashboardId) addWidget(dashboardId, newWidget);
    onClose();
  };

  const handlePreview = async () => {
    if (!dashboardId) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await previewDashboardQuery({
        dashboardId,
        dataSourceId: widget.dataSourceId,
        sql: localSql,
      });
      setPreviewRows(result.rows.slice(0, 10));
    } catch (error) {
      setPreviewRows([]);
      setPreviewError(
        error instanceof Error ? error.message : "Failed to preview query",
      );
    } finally {
      setPreviewLoading(false);
    }
  };

  const widgetRuntime = runtimeSession?.widgets[widget.id];
  const dataSourceRuntime = runtimeSession?.dataSources[widget.dataSourceId];

  return (
    <Box
      sx={{
        width: 400,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid",
        borderColor: "divider",
        backgroundColor: "background.paper",
      }}
    >
      <Box
        sx={{
          px: 2,
          py: 1.5,
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography variant="subtitle2" sx={{ flex: 1, fontWeight: 600 }}>
          Widget Inspector
        </Typography>
        <IconButton size="small" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </Box>

      <Box
        sx={{
          flex: 1,
          overflow: "auto",
          p: 2,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <TextField
          label="Title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          size="small"
          fullWidth
        />

        <FormControl size="small" fullWidth>
          <InputLabel>Type</InputLabel>
          <Select value={widget.type} label="Type" disabled>
            <MenuItem value="chart">Chart</MenuItem>
            <MenuItem value="kpi">KPI</MenuItem>
            <MenuItem value="table">Table</MenuItem>
          </Select>
        </FormControl>

        <Divider />

        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
          <Chip
            size="small"
            label={`Source: ${widget.dataSourceId}`}
            variant="outlined"
          />
          {widgetRuntime?.queryStatus && (
            <Chip
              size="small"
              label={`Query: ${widgetRuntime.queryStatus}`}
              color={
                widgetRuntime.queryStatus === "error" ? "error" : "default"
              }
              variant="outlined"
            />
          )}
          {widgetRuntime?.renderStatus && (
            <Chip
              size="small"
              label={`Render: ${widgetRuntime.renderStatus}`}
              color={
                widgetRuntime.renderStatus === "error" ? "error" : "default"
              }
              variant="outlined"
            />
          )}
        </Box>

        {dataSourceRuntime?.error && (
          <Typography variant="caption" color="error">
            Data source error: {dataSourceRuntime.error}
          </Typography>
        )}
        {widgetRuntime?.queryError && (
          <Typography variant="caption" color="error">
            Query error
            {widgetRuntime.queryErrorKind
              ? ` (${widgetRuntime.queryErrorKind})`
              : ""}
            : {widgetRuntime.queryError}
          </Typography>
        )}
        {widgetRuntime?.renderError && (
          <Typography variant="caption" color="error">
            Render error
            {widgetRuntime.renderErrorKind
              ? ` (${widgetRuntime.renderErrorKind})`
              : ""}
            : {widgetRuntime.renderError}
          </Typography>
        )}

        <Typography variant="caption" color="text.secondary">
          SQL Query (runs against local DuckDB)
        </Typography>
        <Box
          sx={{
            height: 150,
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 1,
          }}
        >
          <Editor
            height="100%"
            language="sql"
            value={localSql}
            onChange={val => setLocalSql(val || "")}
            theme={effectiveMode === "dark" ? "vs-dark" : "light"}
            options={{
              minimap: { enabled: false },
              lineNumbers: "off",
              fontSize: 12,
              scrollBeyondLastLine: false,
              wordWrap: "on",
            }}
          />
        </Box>
        <Button
          size="small"
          variant="outlined"
          onClick={handlePreview}
          disabled={previewLoading}
        >
          {previewLoading ? "Running..." : "Test run query"}
        </Button>
        {previewError && (
          <Typography variant="caption" color="error">
            {previewError}
          </Typography>
        )}
        {previewRows.length > 0 && (
          <Box
            sx={{
              maxHeight: 140,
              overflow: "auto",
              border: "1px solid",
              borderColor: "divider",
              borderRadius: 1,
              p: 1,
              backgroundColor: "background.default",
            }}
          >
            <Typography variant="caption" color="text.secondary">
              Preview (first {previewRows.length} rows)
            </Typography>
            <pre
              style={{
                margin: 0,
                marginTop: 8,
                fontSize: 11,
                whiteSpace: "pre-wrap",
              }}
            >
              {JSON.stringify(previewRows, null, 2)}
            </pre>
          </Box>
        )}

        {widget.type === "chart" && (
          <>
            <Typography variant="caption" color="text.secondary">
              Vega-Lite Spec (JSON)
            </Typography>
            <Box
              sx={{
                height: 200,
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 1,
              }}
            >
              <Editor
                height="100%"
                language="json"
                value={specJson}
                onChange={val => setSpecJson(val || "")}
                theme={effectiveMode === "dark" ? "vs-dark" : "light"}
                options={{
                  minimap: { enabled: false },
                  lineNumbers: "off",
                  fontSize: 12,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                }}
              />
            </Box>
          </>
        )}

        {error && (
          <Typography color="error" variant="caption">
            {error}
          </Typography>
        )}
        {widgetRuntime?.lastQueryAt && (
          <Typography variant="caption" color="text.secondary">
            Last query: {new Date(widgetRuntime.lastQueryAt).toLocaleString()}
          </Typography>
        )}
        {widgetRuntime?.lastRenderAt && (
          <Typography variant="caption" color="text.secondary">
            Last render: {new Date(widgetRuntime.lastRenderAt).toLocaleString()}
          </Typography>
        )}
      </Box>

      <Box
        sx={{
          p: 2,
          display: "flex",
          gap: 1,
          borderTop: "1px solid",
          borderColor: "divider",
        }}
      >
        <Button
          variant="contained"
          size="small"
          onClick={handleApply}
          sx={{ flex: 1 }}
        >
          Apply
        </Button>
        <Button
          variant="outlined"
          size="small"
          onClick={handleDuplicate}
          startIcon={<Copy size={14} />}
        >
          Duplicate
        </Button>
      </Box>
    </Box>
  );
};

export default WidgetInspector;
