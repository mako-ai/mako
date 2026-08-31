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

type LimitsSettingsResponse = {
  success: boolean;
  dashboardRefreshConcurrency?: number;
  dashboardRefreshConcurrencyMax?: number;
  dashboardRefreshConcurrencyDefault?: number;
  error?: string;
};

export default function SettingsLimits() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const [dashboardConcurrency, setDashboardConcurrency] = useState(2);
  const [savedDashboard, setSavedDashboard] = useState(2);
  const [dashboardMax, setDashboardMax] = useState(10);
  const [dashboardDefault, setDashboardDefault] = useState(2);
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
          `/api/workspaces/${workspaceId}/settings/limits`,
        );
        const data = (await res.json()) as LimitsSettingsResponse;
        if (!res.ok || !data.success) {
          throw new Error(data.error || "Failed to load settings");
        }
        if (cancelled) return;
        const dash = data.dashboardRefreshConcurrency ?? 2;
        setDashboardConcurrency(dash);
        setSavedDashboard(dash);
        setDashboardMax(data.dashboardRefreshConcurrencyMax ?? 10);
        setDashboardDefault(data.dashboardRefreshConcurrencyDefault ?? 2);
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

  const modified = dashboardConcurrency !== savedDashboard;

  const clamp = (n: number, max: number, fallback: number) => {
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(1, n));
  };

  const handleSave = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/settings/limits`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dashboardRefreshConcurrency: dashboardConcurrency,
          }),
        },
      );
      const data = (await res.json()) as LimitsSettingsResponse;
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save");
      }
      const dash = data.dashboardRefreshConcurrency ?? dashboardConcurrency;
      setDashboardConcurrency(dash);
      setSavedDashboard(dash);
      setDashboardMax(data.dashboardRefreshConcurrencyMax ?? dashboardMax);
      setSnackbar("Limits saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsLayout
      title="Limits"
      description="Cap how much warehouse work this workspace can run at once. Extra dashboard refreshes wait and retry instead of stampeding shared capacity."
    >
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
        Dashboards
      </Typography>
      <TextField
        label="Max concurrent dashboard refreshes"
        type="number"
        value={dashboardConcurrency}
        onChange={e =>
          setDashboardConcurrency(
            clamp(parseInt(e.target.value, 10), dashboardMax, dashboardDefault),
          )
        }
        inputProps={{ min: 1, max: dashboardMax }}
        disabled={loading || saving || !workspaceId}
        sx={{ mb: 1, maxWidth: 420 }}
        helperText={`Range 1–${dashboardMax}. Default ${dashboardDefault}. One dashboard may still rematerialize multiple sources.`}
      />

      <Typography variant="body2" color="text.secondary" sx={{ mt: 2, mb: 2 }}>
        Applies to scheduled and manual materialization. Owners and admins can
        change these values.
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
