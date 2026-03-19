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
} from "@mui/material";
import { X, Copy } from "lucide-react";
import Editor from "@monaco-editor/react";
import {
  useDashboardStore,
  type DashboardWidget,
} from "../../store/dashboardStore";
import { useTheme } from "../../contexts/ThemeContext";

interface WidgetInspectorProps {
  widget: DashboardWidget;
  onClose: () => void;
}

const WidgetInspector: React.FC<WidgetInspectorProps> = ({
  widget,
  onClose,
}) => {
  const { modifyWidget, addWidget } = useDashboardStore();
  const { effectiveMode } = useTheme();

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
  }, [widget.id]);

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

    modifyWidget(widget.id, changes);
    onClose();
  };

  const handleDuplicate = async () => {
    const { nanoid } = await import("nanoid");
    const newWidget: DashboardWidget = {
      ...widget,
      id: nanoid(),
      title: `${widget.title || "Widget"} (copy)`,
      layout: {
        ...widget.layout,
        y: widget.layout.y + widget.layout.h,
      },
    };
    addWidget(newWidget);
    onClose();
  };

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
