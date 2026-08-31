import { useEffect, useState } from "react";
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
  Switch,
  FormControlLabel,
  Typography,
  Box,
  Divider,
} from "@mui/material";
import { Copy, RotateCcw, Trash2 } from "lucide-react";
import { useDashboardStore } from "../../store/dashboardStore";
import { useWorkspace } from "../../contexts/workspace-context";
import { useConsoleStore } from "../../store/consoleStore";
import MaterializationScheduleControls from "../MaterializationScheduleControls";
import type { MaterializationScheduleValue } from "../../lib/materializationSchedule";
import { useConfirm } from "../ConfirmDialog";

interface DashboardSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  dashboardId?: string;
}

export default function DashboardSettingsDialog({
  open,
  onClose,
  dashboardId,
}: DashboardSettingsDialogProps) {
  const { currentWorkspace } = useWorkspace();
  const confirm = useConfirm();
  const workspaceId = currentWorkspace?.id;
  const dashboard = useDashboardStore(s =>
    dashboardId ? s.openDashboards[dashboardId] : undefined,
  );

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<"private" | "workspace">("private");
  const [gridColumns, setGridColumns] = useState(12);
  const [rowHeight, setRowHeight] = useState(80);
  const [materializationSchedule, setMaterializationSchedule] =
    useState<MaterializationScheduleValue>({
      enabled: true,
      cron: "0 0 * * *",
      timezone: "UTC",
    });
  const [crossFilterEnabled, setCrossFilterEnabled] = useState(false);
  const [crossFilterResolution, setCrossFilterResolution] = useState<
    "intersect" | "union"
  >("intersect");
  const [crossFilterEngine, setCrossFilterEngine] = useState<
    "mosaic" | "legacy"
  >("mosaic");
  const isReadOnly = dashboard?.readOnly === true;

  useEffect(() => {
    if (dashboard && open) {
      setTitle(dashboard.title);
      setDescription(dashboard.description ?? "");
      setAccess(dashboard.access);
      setGridColumns(dashboard.layout.columns);
      setRowHeight(dashboard.layout.rowHeight);
      const schedule = dashboard.materializationSchedule ?? {
        enabled: true,
        cron: "0 0 * * *",
        timezone: "UTC",
      };
      setMaterializationSchedule({
        enabled: schedule.enabled,
        cron: schedule.cron,
        timezone: schedule.timezone ?? "UTC",
        dataFreshnessTtlMs: schedule.dataFreshnessTtlMs ?? null,
      });
      setCrossFilterEnabled(dashboard.crossFilter.enabled);
      setCrossFilterResolution(dashboard.crossFilter.resolution);
      setCrossFilterEngine(dashboard.crossFilter.engine ?? "mosaic");
    }
  }, [dashboard, open]);

  const handleSave = async () => {
    if (!workspaceId || !dashboard) return;
    await useDashboardStore
      .getState()
      .updateDashboard(workspaceId, dashboard._id, {
        title,
        description,
        access,
        layout: { columns: gridColumns, rowHeight },
        materializationSchedule: {
          enabled: materializationSchedule.enabled,
          cron: materializationSchedule.enabled
            ? materializationSchedule.cron?.trim() || null
            : null,
          timezone: materializationSchedule.timezone ?? "UTC",
          dataFreshnessTtlMs:
            materializationSchedule.dataFreshnessTtlMs ?? null,
        },
        crossFilter: {
          enabled: crossFilterEnabled,
          resolution: crossFilterResolution,
          engine: crossFilterEngine,
        },
      } as any);
    useDashboardStore.setState(state => {
      if (dashboardId && state.openDashboards[dashboardId]) {
        Object.assign(state.openDashboards[dashboardId], {
          title,
          description,
          access,
          layout: { columns: gridColumns, rowHeight },
          materializationSchedule: {
            enabled: materializationSchedule.enabled,
            cron: materializationSchedule.enabled
              ? materializationSchedule.cron?.trim() || null
              : null,
            timezone: materializationSchedule.timezone ?? "UTC",
            dataFreshnessTtlMs:
              materializationSchedule.dataFreshnessTtlMs ?? null,
          },
          crossFilter: {
            enabled: crossFilterEnabled,
            resolution: crossFilterResolution,
            engine: crossFilterEngine,
          },
        });
      }
    });
    onClose();
  };

  const handleDuplicate = async () => {
    if (!workspaceId || !dashboard) return;
    await useDashboardStore
      .getState()
      .duplicateDashboard(workspaceId, dashboard._id);
    onClose();
  };

  const handleDelete = async () => {
    if (!workspaceId || !dashboard) return;
    if (
      !(await confirm({
        title: "Delete dashboard?",
        body: "This dashboard will be permanently deleted.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }
    await useDashboardStore
      .getState()
      .deleteDashboard(workspaceId, dashboard._id);
    const tabs = useConsoleStore.getState().tabs;
    const dashTab = Object.values(tabs).find(
      t => t.kind === "dashboard" && t.metadata?.dashboardId === dashboard._id,
    );
    if (dashTab) {
      useConsoleStore.getState().closeTab(dashTab.id);
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Dashboard Settings</DialogTitle>
      <DialogContent
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: 2.5,
          pt: "16px !important",
        }}
      >
        <TextField
          label="Title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          fullWidth
          size="small"
          disabled={isReadOnly}
        />
        <TextField
          label="Description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          fullWidth
          multiline
          minRows={2}
          size="small"
          disabled={isReadOnly}
        />
        <FormControl size="small" fullWidth disabled={isReadOnly}>
          <InputLabel>Access</InputLabel>
          <Select
            value={access}
            label="Access"
            onChange={e => setAccess(e.target.value as "private" | "workspace")}
          >
            <MenuItem value="private">Private</MenuItem>
            <MenuItem value="workspace">Workspace</MenuItem>
          </Select>
        </FormControl>

        <Box sx={{ display: "flex", gap: 2 }}>
          <TextField
            label="Grid columns"
            type="number"
            value={gridColumns}
            onChange={e => setGridColumns(Number(e.target.value))}
            size="small"
            fullWidth
            slotProps={{ htmlInput: { min: 1 } }}
            disabled={isReadOnly}
          />
          <TextField
            label="Row height"
            type="number"
            value={rowHeight}
            onChange={e => setRowHeight(Number(e.target.value))}
            size="small"
            fullWidth
            slotProps={{ htmlInput: { min: 20 } }}
            disabled={isReadOnly}
          />
        </Box>

        {!isReadOnly && (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 2,
            }}
          >
            <Box>
              <Typography variant="body2">Responsive layout</Typography>
              <Typography variant="caption" color="text.secondary">
                Smaller screens are arranged automatically from your
                large-screen layout. Resetting clears any manual tablet/mobile
                tweaks.
              </Typography>
            </Box>
            <Button
              variant="outlined"
              size="small"
              startIcon={<RotateCcw size={16} />}
              onClick={() => {
                if (dashboardId) {
                  useDashboardStore
                    .getState()
                    .resetResponsiveLayouts(dashboardId);
                }
              }}
              sx={{ flexShrink: 0 }}
            >
              Reset to auto
            </Button>
          </Box>
        )}

        <MaterializationScheduleControls
          value={materializationSchedule}
          onChange={setMaterializationSchedule}
          disabled={isReadOnly}
          title="Automatic materialization"
          caption="Applies to every data source in this dashboard."
        />

        <FormControlLabel
          control={
            <Switch
              checked={crossFilterEnabled}
              onChange={e => setCrossFilterEnabled(e.target.checked)}
              disabled={isReadOnly}
            />
          }
          label="Cross-filtering enabled"
        />

        {crossFilterEnabled && (
          <>
            <FormControl size="small" fullWidth>
              <InputLabel>Cross-filter resolution</InputLabel>
              <Select
                value={crossFilterResolution}
                label="Cross-filter resolution"
                onChange={e =>
                  setCrossFilterResolution(
                    e.target.value as "intersect" | "union",
                  )
                }
              >
                <MenuItem value="intersect">Intersect</MenuItem>
                <MenuItem value="union">Union</MenuItem>
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel>Cross-filter engine</InputLabel>
              <Select
                value={crossFilterEngine}
                label="Cross-filter engine"
                onChange={e =>
                  setCrossFilterEngine(e.target.value as "mosaic" | "legacy")
                }
              >
                <MenuItem value="mosaic">Mosaic</MenuItem>
                <MenuItem value="legacy">Legacy</MenuItem>
              </Select>
            </FormControl>
          </>
        )}

        <Divider sx={{ mt: 1 }} />

        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Typography variant="subtitle2" color="text.secondary">
            Actions
          </Typography>
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<Copy size={16} />}
              onClick={handleDuplicate}
            >
              Duplicate
            </Button>
            {!isReadOnly && (
              <Button
                variant="outlined"
                color="error"
                size="small"
                startIcon={<Trash2 size={16} />}
                onClick={handleDelete}
              >
                Delete
              </Button>
            )}
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{isReadOnly ? "Close" : "Cancel"}</Button>
        {!isReadOnly && (
          <Button variant="contained" onClick={handleSave}>
            Save
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
