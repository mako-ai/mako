/**
 * Settings › Sandbox — the workspace's E2B machine, made visible.
 *
 * One (workspace, user) has one sandbox; every terminal session, dev server
 * and agent shell lives inside it. This page answers the questions that
 * otherwise need a shell: which machine is it, how long has it been up, how
 * many sessions are on it, how loaded is it — and gives the one dangerous
 * action (kill & recycle) a deliberate home instead of a hidden incantation.
 * Stats come from a single exec in the box with a 1s CPU sample.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  Copy as CopyIcon,
  RefreshCw as RefreshIcon,
  Server as ServerIcon,
  Trash2 as RecycleIcon,
} from "lucide-react";
import { useWorkspace } from "../../contexts/workspace-context";
import { useAppsV2Store } from "../../store/appsV2Store";

interface SandboxStats {
  running: boolean;
  sandboxId?: string;
  startedAt?: string | null;
  uptimeSec?: number;
  cores?: number;
  load?: string;
  cpuPct?: number;
  memTotal?: number;
  memUsed?: number;
  diskTotal?: number;
  diskUsed?: number;
  sessions?: number;
  connectCommand?: string;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  return `${n} B`;
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function UsageBar({
  label,
  used,
  total,
  detail,
}: {
  label: string;
  used: number;
  total: number;
  detail: string;
}) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <Box sx={{ mb: 1.5 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
        <Typography variant="body2">{label}</Typography>
        <Typography variant="body2" color="text.secondary">
          {detail}
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={pct}
        color={pct > 85 ? "error" : pct > 65 ? "warning" : "primary"}
        sx={{ height: 6, borderRadius: 3 }}
      />
    </Box>
  );
}

export default function SettingsSandbox() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const apps = useAppsV2Store(s => s.apps);
  const fetchApps = useAppsV2Store(s => s.fetchApps);
  // Pushed box liveness/identity — makes this panel coherent across browsers
  // without a poll: a recycle elsewhere flips us to "no sandbox" instantly.
  const boxStatus = useAppsV2Store(s => s.boxStatus);
  const boxSandboxId = useAppsV2Store(s => s.boxSandboxId);
  const boxTerminals = useAppsV2Store(s => s.boxTerminals);
  const fetchSandboxStats = useAppsV2Store(s => s.fetchSandboxStats);
  const recycleSandbox = useAppsV2Store(s => s.recycleSandbox);
  // The sandbox belongs to the (workspace, user) pair; any app id reaches it.
  const appId = apps[0]?.id;

  const [stats, setStats] = useState<SandboxStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [recycling, setRecycling] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (workspaceId && apps.length === 0) void fetchApps(workspaceId);
  }, [workspaceId, apps.length, fetchApps]);

  const refresh = useCallback(async () => {
    if (!workspaceId || !appId) return;
    setLoading(true);
    setError(null);
    try {
      const body = (await fetchSandboxStats(
        workspaceId,
        appId,
      )) as SandboxStats | null;
      // The stats exec embeds a 1s CPU sample, so a response is ALWAYS at
      // least a second stale. If a recycle's offline push landed while this
      // was in flight, showing the dead machine as running — with a copyable
      // connect command — would stick until the next manual refresh.
      if (useAppsV2Store.getState().boxStatus === "offline") return;
      setStats(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the sandbox");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, appId, fetchSandboxStats]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // React to the pushed box state: recycled anywhere → show "no sandbox" at
  // once; a new box (new id) → pull fresh stats. boxStatus stays "online"
  // across heartbeats, so this only fires on real transitions.
  useEffect(() => {
    if (boxStatus === "offline") setStats({ running: false });
    else if (boxStatus === "online") void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxStatus, boxSandboxId]);

  const recycle = useCallback(async () => {
    if (!workspaceId || !appId) return;
    setRecycling(true);
    try {
      await recycleSandbox(workspaceId, appId);
      setConfirmOpen(false);
      setStats({ running: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recycle failed");
    } finally {
      setRecycling(false);
    }
  }, [workspaceId, appId, recycleSandbox]);

  const copyConnect = useCallback(() => {
    if (!stats?.connectCommand) return;
    void navigator.clipboard.writeText(stats.connectCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [stats?.connectCommand]);

  return (
    <Box sx={{ maxWidth: 640, p: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
        <ServerIcon size={20} />
        <Typography variant="h6">Sandbox</Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Refresh — stats include a 1s CPU sample">
          <span>
            <IconButton
              size="small"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {loading ? (
                <CircularProgress size={16} />
              ) : (
                <RefreshIcon size={16} />
              )}
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Your workspace&apos;s machine: every terminal, dev server and agent
        shell runs inside it. Committed work lives in the repository and
        survives anything; the machine itself is disposable.
      </Typography>

      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {!appId && (
        <Alert severity="info">
          The sandbox appears with the first Apps v2 app in this workspace.
        </Alert>
      )}

      {appId && stats && !stats.running && (
        <Alert severity="info" sx={{ mb: 2 }}>
          No sandbox is running. One boots automatically the next time you open
          a terminal or a dev session.
        </Alert>
      )}

      {stats?.running && (
        <>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              columnGap: 2,
              rowGap: 1,
              mb: 2,
              alignItems: "center",
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Sandbox ID
            </Typography>
            <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
              {stats.sandboxId}
            </Typography>

            <Typography variant="body2" color="text.secondary">
              Connect
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <Typography
                variant="body2"
                sx={{
                  fontFamily: "monospace",
                  bgcolor: "action.hover",
                  px: 1,
                  py: 0.25,
                  borderRadius: 1,
                }}
              >
                {stats.connectCommand}
              </Typography>
              <Tooltip title={copied ? "Copied!" : "Copy"}>
                <IconButton size="small" onClick={copyConnect}>
                  <CopyIcon size={14} />
                </IconButton>
              </Tooltip>
            </Box>

            <Typography variant="body2" color="text.secondary">
              Uptime
            </Typography>
            <Typography variant="body2">
              {formatUptime(stats.uptimeSec ?? 0)}
              {stats.startedAt
                ? ` — started ${new Date(stats.startedAt).toLocaleString()}`
                : ""}
            </Typography>

            <Typography variant="body2" color="text.secondary">
              Active sessions
            </Typography>
            <Box>
              <Tooltip
                title={boxTerminals.length > 0 ? boxTerminals.join(" · ") : ""}
              >
                {/* The pushed list is live (agent heartbeat); the exec'd
                    stat is a snapshot from the last refresh. Prefer live. */}
                <Chip
                  size="small"
                  label={
                    boxStatus === "online" && boxTerminals.length > 0
                      ? boxTerminals.length
                      : (stats.sessions ?? 0)
                  }
                />
              </Tooltip>
            </Box>

            <Typography variant="body2" color="text.secondary">
              Load average
            </Typography>
            <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
              {stats.load}
            </Typography>
          </Box>

          <UsageBar
            label={`CPU (${stats.cores} cores)`}
            used={stats.cpuPct ?? 0}
            total={100}
            detail={`${(stats.cpuPct ?? 0).toFixed(1)}%`}
          />
          <UsageBar
            label="Memory"
            used={stats.memUsed ?? 0}
            total={stats.memTotal ?? 1}
            detail={`${formatBytes(stats.memUsed ?? 0)} / ${formatBytes(stats.memTotal ?? 0)}`}
          />
          <UsageBar
            label="Disk"
            used={stats.diskUsed ?? 0}
            total={stats.diskTotal ?? 1}
            detail={`${formatBytes(stats.diskUsed ?? 0)} / ${formatBytes(stats.diskTotal ?? 0)}`}
          />

          <Box sx={{ mt: 3 }}>
            <Button
              color="error"
              variant="outlined"
              startIcon={<RecycleIcon size={16} />}
              onClick={() => setConfirmOpen(true)}
            >
              Kill &amp; recycle sandbox
            </Button>
          </Box>
        </>
      )}

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>Kill &amp; recycle the sandbox?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Running processes, terminal sessions and{" "}
            <strong>uncommitted working-copy changes</strong> die with the
            machine — the same contract as losing a laptop. Committed and pushed
            work is safe. A fresh sandbox boots on your next terminal or dev
            session.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={recycling}
            onClick={() => void recycle()}
            startIcon={recycling ? <CircularProgress size={14} /> : undefined}
          >
            {recycling ? "Recycling…" : "Kill it"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
