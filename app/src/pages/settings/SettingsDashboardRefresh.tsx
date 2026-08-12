import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Snackbar,
  TextField,
  Typography,
} from "@mui/material";
import { Save as SaveIcon } from "@mui/icons-material";
import SettingsLayout from "./SettingsLayout";
import { useWorkspace } from "../../contexts/workspace-context";

type RefreshSettingsResponse = {
  success: boolean;
  dashboardRefreshConcurrency?: number;
  max?: number;
  default?: number;
  error?: string;
};

export default function SettingsDashboardRefresh() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const [value, setValue] = useState<number>(2);
  const [savedValue, setSavedValue] = useState<number>(2);
  const [max, setMax] = useState(10);
  const [defaultValue, setDefaultValue] = useState(2);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/settings/dashboard-refresh`,
        );
        const data = (await res.json()) as RefreshSettingsResponse;
        if (!res.ok || !data.success) {
          throw new Error(data.error || "Failed to load settings");
        }
        if (cancelled) return;
        const n = data.dashboardRefreshConcurrency ?? 2;
        setValue(n);
        setSavedValue(n);
        setMax(data.max ?? 10);
        setDefaultValue(data.default ?? 2);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const modified = value !== savedValue;

  const handleSave = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/settings/dashboard-refresh`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dashboardRefreshConcurrency: value }),
        },
      );
      const data = (await res.json()) as RefreshSettingsResponse;
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save");
      }
      const n = data.dashboardRefreshConcurrency ?? value;
      setValue(n);
      setSavedValue(n);
      setMax(data.max ?? max);
      setSnackbar("Dashboard refresh concurrency saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsLayout
      title="Dashboard refresh"
      description="Limit how many dashboards in this workspace can rematerialize at the same time. Lower values protect shared warehouse capacity when many scheduled funnels fire together."
    >
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <TextField
        label="Max concurrent dashboard refreshes"
        type="number"
        value={value}
        onChange={e => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isFinite(n)) {
            setValue(defaultValue);
            return;
          }
          setValue(Math.min(max, Math.max(1, n)));
        }}
        inputProps={{ min: 1, max }}
        disabled={loading || saving || !workspaceId}
        sx={{ mb: 1, maxWidth: 360 }}
        helperText={`Allowed range: 1–${max}. Default: ${defaultValue}.`}
      />

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Applies to scheduled and manual dashboard materialization for this
        workspace. Extra refreshes wait and retry instead of all hitting the
        warehouse at once.
      </Typography>

      <Box sx={{ display: "flex", gap: 1 }}>
        <Button
          variant="contained"
          disableElevation
          startIcon={<SaveIcon />}
          onClick={handleSave}
          disabled={!modified || loading || saving || !workspaceId}
        >
          Save
        </Button>
      </Box>

      <Snackbar
        open={snackbar !== null}
        autoHideDuration={3000}
        onClose={() => setSnackbar(null)}
        message={snackbar}
      />
    </SettingsLayout>
  );
}
