import { useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  Box,
  Alert,
} from "@mui/material";
import { BarChart3, Hash, Table2 } from "lucide-react";
import {
  useDashboardStore,
  type DashboardWidget,
} from "../../store/dashboardStore";
import { executeDashboardSql } from "../../dashboard-runtime/commands";

interface AddWidgetDialogProps {
  open: boolean;
  onClose: () => void;
  dashboardId?: string;
}

const defaultLayouts: Record<
  DashboardWidget["type"],
  DashboardWidget["layouts"]
> = {
  chart: { lg: { x: 0, y: 0, w: 6, h: 4 } },
  kpi: { lg: { x: 0, y: 0, w: 3, h: 2 } },
  table: { lg: { x: 0, y: 0, w: 12, h: 5 } },
};

export default function AddWidgetDialog({
  open,
  onClose,
  dashboardId,
}: AddWidgetDialogProps) {
  const dataSources = useDashboardStore(
    s =>
      (dashboardId ? s.openDashboards[dashboardId]?.dataSources : undefined) ??
      [],
  );

  const [widgetType, setWidgetType] =
    useState<DashboardWidget["type"]>("chart");
  const [dataSourceId, setDataSourceId] = useState("");
  const [title, setTitle] = useState("");
  const [localSql, setLocalSql] = useState("");

  // Chart config
  const [specJson, setSpecJson] = useState("");

  // KPI config
  const [kpiValueField, setKpiValueField] = useState("");
  const [kpiFormat, setKpiFormat] = useState("");
  const [kpiComparisonField, setKpiComparisonField] = useState("");
  const [kpiComparisonLabel, setKpiComparisonLabel] = useState("");

  // Table config
  const [tableColumns, setTableColumns] = useState("");
  const [tablePageSize, setTablePageSize] = useState<number>(25);

  // Preview state
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const handlePreview = async () => {
    if (!localSql.trim()) return;
    try {
      const result = await executeDashboardSql({
        sql: localSql,
        dataSourceId: dataSourceId || undefined,
      });
      setPreviewRows(result.rows.slice(0, 3));
      setPreviewError(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Query failed";
      setPreviewError(msg);
      setPreviewRows([]);
    }
  };

  const handleAdd = async () => {
    const { nanoid } = await import("nanoid");
    const store = useDashboardStore.getState();

    let vegaLiteSpec: Record<string, unknown> | undefined;
    if (widgetType === "chart" && specJson.trim()) {
      try {
        vegaLiteSpec = JSON.parse(specJson);
      } catch {
        setPreviewError("Invalid JSON in chart spec");
        return;
      }
    }

    const widget: DashboardWidget = {
      id: nanoid(),
      title: title || undefined,
      type: widgetType,
      dataSourceId,
      localSql,
      vegaLiteSpec,
      kpiConfig:
        widgetType === "kpi"
          ? {
              valueField: kpiValueField,
              format: kpiFormat || undefined,
              comparisonField: kpiComparisonField || undefined,
              comparisonLabel: kpiComparisonLabel || undefined,
            }
          : undefined,
      tableConfig:
        widgetType === "table"
          ? {
              columns: tableColumns
                ? tableColumns.split(",").map(c => c.trim())
                : undefined,
              pageSize: tablePageSize || 25,
            }
          : undefined,
      crossFilter: { enabled: true },
      layouts: defaultLayouts[widgetType],
    };

    if (dashboardId) store.addWidget(dashboardId, widget);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add Widget</DialogTitle>
      <DialogContent
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: 2.5,
          pt: "8px !important",
        }}
      >
        {/* Type selector */}
        <ToggleButtonGroup
          value={widgetType}
          exclusive
          onChange={(_, v) => v && setWidgetType(v)}
          fullWidth
          size="small"
        >
          <ToggleButton value="chart">
            <BarChart3 size={16} style={{ marginRight: 6 }} /> Chart
          </ToggleButton>
          <ToggleButton value="kpi">
            <Hash size={16} style={{ marginRight: 6 }} /> KPI
          </ToggleButton>
          <ToggleButton value="table">
            <Table2 size={16} style={{ marginRight: 6 }} /> Table
          </ToggleButton>
        </ToggleButtonGroup>

        {/* Data source */}
        <FormControl fullWidth size="small">
          <InputLabel>Data Source</InputLabel>
          <Select
            value={dataSourceId}
            label="Data Source"
            onChange={e => setDataSourceId(e.target.value)}
          >
            {dataSources.map(ds => (
              <MenuItem key={ds.id} value={ds.id}>
                {ds.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {/* Title */}
        <TextField
          label="Title"
          size="small"
          fullWidth
          value={title}
          onChange={e => setTitle(e.target.value)}
        />

        {/* SQL query */}
        <TextField
          label="SQL Query"
          size="small"
          fullWidth
          multiline
          minRows={3}
          maxRows={8}
          value={localSql}
          onChange={e => setLocalSql(e.target.value)}
          placeholder="SELECT * FROM ..."
          slotProps={{
            input: { sx: { fontFamily: "monospace", fontSize: 13 } },
          }}
        />

        {/* Type-specific config */}
        {widgetType === "chart" && (
          <TextField
            label="Vega-Lite Spec (JSON)"
            size="small"
            fullWidth
            multiline
            minRows={3}
            maxRows={8}
            value={specJson}
            onChange={e => setSpecJson(e.target.value)}
            placeholder='{"mark": "bar", "encoding": {...}}'
            helperText="Leave empty for auto-generated chart"
            slotProps={{
              input: { sx: { fontFamily: "monospace", fontSize: 13 } },
            }}
          />
        )}

        {widgetType === "kpi" && (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            <TextField
              label="Value Field"
              size="small"
              fullWidth
              required
              value={kpiValueField}
              onChange={e => setKpiValueField(e.target.value)}
            />
            <TextField
              label="Format"
              size="small"
              fullWidth
              value={kpiFormat}
              onChange={e => setKpiFormat(e.target.value)}
              placeholder="e.g. $,.2f"
            />
            <TextField
              label="Comparison Field"
              size="small"
              fullWidth
              value={kpiComparisonField}
              onChange={e => setKpiComparisonField(e.target.value)}
            />
            <TextField
              label="Comparison Label"
              size="small"
              fullWidth
              value={kpiComparisonLabel}
              onChange={e => setKpiComparisonLabel(e.target.value)}
              placeholder="e.g. vs last month"
            />
          </Box>
        )}

        {widgetType === "table" && (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            <TextField
              label="Columns (comma-separated)"
              size="small"
              fullWidth
              value={tableColumns}
              onChange={e => setTableColumns(e.target.value)}
              placeholder="col1, col2, col3"
              helperText="Leave empty to show all columns"
            />
            <TextField
              label="Page Size"
              size="small"
              fullWidth
              type="number"
              value={tablePageSize}
              onChange={e => setTablePageSize(Number(e.target.value) || 25)}
              slotProps={{ htmlInput: { min: 1, max: 500 } }}
            />
          </Box>
        )}

        {/* Preview */}
        {previewError && <Alert severity="error">{previewError}</Alert>}
        {previewRows.length > 0 && (
          <Box>
            <Typography variant="caption" color="text.secondary">
              Preview ({previewRows.length} rows)
            </Typography>
            <Box
              component="pre"
              sx={{
                mt: 0.5,
                p: 1,
                bgcolor: "action.hover",
                borderRadius: 1,
                fontSize: 12,
                fontFamily: "monospace",
                overflow: "auto",
                maxHeight: 160,
              }}
            >
              {JSON.stringify(previewRows, null, 2)}
            </Box>
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="outlined"
          onClick={handlePreview}
          disabled={!localSql.trim()}
        >
          Preview
        </Button>
        <Button
          variant="contained"
          onClick={handleAdd}
          disabled={!dataSourceId || !localSql.trim()}
        >
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}
