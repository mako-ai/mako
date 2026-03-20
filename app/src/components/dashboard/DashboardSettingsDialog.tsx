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
  Alert,
} from "@mui/material";
import { Copy, Trash2 } from "lucide-react";
import { useDashboardStore } from "../../store/dashboardStore";
import { useWorkspace } from "../../contexts/workspace-context";
import { useConsoleStore } from "../../store/consoleStore";

interface DashboardSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  dashboardId?: string;
}

const CACHE_TTL_OPTIONS = [
  { label: "5 min", value: 300 },
  { label: "15 min", value: 900 },
  { label: "1 hour", value: 3600 },
  { label: "6 hours", value: 21600 },
  { label: "24 hours", value: 86400 },
];

export default function DashboardSettingsDialog({
  open,
  onClose,
  dashboardId,
}: DashboardSettingsDialogProps) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const dashboard = useDashboardStore(s =>
    dashboardId ? s.openDashboards[dashboardId] : undefined,
  );

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<"private" | "workspace">("private");
  const [gridColumns, setGridColumns] = useState(12);
  const [rowHeight, setRowHeight] = useState(80);
  const [cacheTtl, setCacheTtl] = useState(900);
  const [crossFilterEnabled, setCrossFilterEnabled] = useState(false);
  const [crossFilterResolution, setCrossFilterResolution] = useState<
    "intersect" | "union"
  >("intersect");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (dashboard && open) {
      setTitle(dashboard.title);
      setDescription(dashboard.description ?? "");
      setAccess(dashboard.access);
      setGridColumns(dashboard.layout.columns);
      setRowHeight(dashboard.layout.rowHeight);
      setCacheTtl(dashboard.cache.ttlSeconds);
      setCrossFilterEnabled(dashboard.crossFilter.enabled);
      setCrossFilterResolution(dashboard.crossFilter.resolution);
      setConfirmDelete(false);
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
        cache: { ttlSeconds: cacheTtl },
        crossFilter: {
          enabled: crossFilterEnabled,
          resolution: crossFilterResolution,
        },
      } as any);
    useDashboardStore.setState(state => {
      if (dashboardId && state.openDashboards[dashboardId]) {
        Object.assign(state.openDashboards[dashboardId], {
          title,
          description,
          access,
          layout: { columns: gridColumns, rowHeight },
          cache: {
            ...state.openDashboards[dashboardId].cache,
            ttlSeconds: cacheTtl,
          },
          crossFilter: {
            enabled: crossFilterEnabled,
            resolution: crossFilterResolution,
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
        />
        <TextField
          label="Description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          fullWidth
          multiline
          minRows={2}
          size="small"
        />
        <FormControl size="small" fullWidth>
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
          />
          <TextField
            label="Row height"
            type="number"
            value={rowHeight}
            onChange={e => setRowHeight(Number(e.target.value))}
            size="small"
            fullWidth
            slotProps={{ htmlInput: { min: 20 } }}
          />
        </Box>

        <FormControl size="small" fullWidth>
          <InputLabel>Cache TTL</InputLabel>
          <Select
            value={cacheTtl}
            label="Cache TTL"
            onChange={e => setCacheTtl(Number(e.target.value))}
          >
            {CACHE_TTL_OPTIONS.map(opt => (
              <MenuItem key={opt.value} value={opt.value}>
                {opt.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <FormControlLabel
          control={
            <Switch
              checked={crossFilterEnabled}
              onChange={e => setCrossFilterEnabled(e.target.checked)}
            />
          }
          label="Cross-filtering enabled"
        />

        {crossFilterEnabled && (
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
            <Button
              variant="outlined"
              color="error"
              size="small"
              startIcon={<Trash2 size={16} />}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          </Box>
          {confirmDelete && (
            <Alert
              severity="error"
              action={
                <Button color="error" size="small" onClick={handleDelete}>
                  Confirm
                </Button>
              }
            >
              This dashboard will be permanently deleted.
            </Alert>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
