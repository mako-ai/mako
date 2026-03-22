import { useEffect, useState, useRef, useCallback } from "react";
import {
  Box,
  Button,
  Typography,
  Alert,
  LinearProgress,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Checkbox,
  FormControlLabel,
  IconButton,
  Tooltip,
} from "@mui/material";
import {
  CloudDownload as BackfillIcon,
  Cancel as CancelIcon,
  Pause as PauseIcon,
  PlayArrow as ResumeIcon,
  RestartAlt as ResyncIcon,
  Healing as RecoverIcon,
  ContentCopy as CopyIcon,
  Edit as EditIcon,
  ExpandMore as ExpandIcon,
  ExpandLess as CollapseIcon,
} from "@mui/icons-material";
import { useFlowStore } from "../store/flowStore";

interface BackfillPanelProps {
  workspaceId: string;
  flowId: string;
  onEdit?: () => void;
}

type CdcState =
  | "idle"
  | "backfill"
  | "catchup"
  | "live"
  | "paused"
  | "degraded";

function formatLag(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function camelToSnake(v: string): string {
  return v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function entityLabel(entity: string): string {
  if (!entity.includes(":")) return entity;
  const [parent, sub] = entity.split(":");
  return parent && sub ? `${camelToSnake(sub)}_${parent}` : entity;
}

function streamStatus(state: CdcState): {
  label: string;
  color: "success" | "info" | "error" | "warning" | "default";
} {
  switch (state) {
    case "live":
      return { label: "Live", color: "success" };
    case "catchup":
      return { label: "Catching up", color: "info" };
    case "backfill":
      return { label: "Backfilling", color: "info" };
    case "paused":
      return { label: "Paused", color: "warning" };
    case "degraded":
      return { label: "Degraded", color: "error" };
    default:
      return { label: "Idle", color: "default" };
  }
}

function backfillStatus(
  state: CdcState,
  backlogCount: number,
  totalProcessed: number,
): { label: string; color: "success" | "info" | "warning" | "default" } {
  if (state === "backfill") return { label: "Running", color: "info" };
  if (state === "idle") return { label: "Not started", color: "default" };
  if (backlogCount > 0) return { label: "Catching up", color: "warning" };
  if (totalProcessed === 0) return { label: "Not started", color: "default" };
  return { label: "Complete", color: "success" };
}

function entityStreamChip(e: {
  backlogCount: number;
  lastMaterializedSeq: number;
  lastMaterializedAt: string | null;
}): { label: string; color: "success" | "info" | "default" | "warning" } {
  if (e.backlogCount > 0) return { label: "Syncing", color: "info" };
  if (e.lastMaterializedAt) return { label: "Live", color: "success" };
  return { label: "Pending", color: "default" };
}

function entityBackfillChip(e: {
  backlogCount: number;
  lastMaterializedSeq: number;
  lastMaterializedAt: string | null;
}): { label: string; color: "success" | "info" | "default" } {
  if (!e.lastMaterializedAt && e.lastMaterializedSeq === 0) {
    return { label: "Not started", color: "default" };
  }
  if (e.backlogCount > 0) return { label: "In progress", color: "info" };
  return { label: "Done", color: "success" };
}

// ---------------------------------------------------------------------------

export function BackfillPanel({
  workspaceId,
  flowId,
  onEdit,
}: BackfillPanelProps) {
  const {
    flows: flowsMap,
    startCdcBackfill,
    fetchCdcStatus,
    pauseCdcFlow,
    resumeCdcFlow,
    resyncCdcFlow,
    recoverCdcFlow,
  } = useFlowStore();

  const [cdc, setCdc] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTransitions, setShowTransitions] = useState(false);
  const [resyncOpen, setResyncOpen] = useState(false);
  const [resyncConfirm, setResyncConfirm] = useState("");
  const [resyncOpts, setResyncOpts] = useState({
    deleteDestination: false,
    clearWebhookEvents: false,
  });
  const [webhookCopied, setWebhookCopied] = useState(false);

  const cdcPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flow = (flowsMap[workspaceId] || []).find(f => f._id === flowId);
  const state: CdcState = cdc?.syncState || "idle";

  const poll = useCallback(async () => {
    const status = await fetchCdcStatus(workspaceId, flowId);
    if (status) setCdc(status);
  }, [fetchCdcStatus, workspaceId, flowId]);

  useEffect(() => {
    poll();
    cdcPollRef.current = setInterval(poll, 5000);
    return () => {
      if (cdcPollRef.current) clearInterval(cdcPollRef.current);
    };
  }, [poll]);

  const withBusy = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStartBackfill = () =>
    withBusy(async () => {
      const ok = await startCdcBackfill(workspaceId, flowId);
      if (!ok) throw new Error("Failed to start backfill");
    });

  const handleStop = () =>
    withBusy(async () => {
      const ok = await pauseCdcFlow(workspaceId, flowId);
      if (!ok) throw new Error("Failed to pause flow");
    });

  const handlePauseResume = () =>
    withBusy(async () => {
      const ok =
        state === "paused"
          ? await resumeCdcFlow(workspaceId, flowId)
          : await pauseCdcFlow(workspaceId, flowId);
      if (!ok) throw new Error("Failed to update flow state");
    });

  const handleRecover = () =>
    withBusy(async () => {
      const ok = await recoverCdcFlow(workspaceId, flowId, {
        retryFailedMaterialization: true,
        resumeBackfill: true,
      });
      if (!ok) throw new Error("Failed to recover flow");
    });

  const handleResync = async () => {
    if (resyncConfirm !== "RESET") return;
    setBusy(true);
    const ok = await resyncCdcFlow(workspaceId, flowId, resyncOpts);
    setBusy(false);
    if (!ok) {
      setError("Failed to reset sync");
      return;
    }
    setResyncOpen(false);
    setResyncConfirm("");
    setResyncOpts({ deleteDestination: false, clearWebhookEvents: false });
    await poll();
  };

  const webhookUrl = flow?.webhookConfig?.endpoint;
  const copyWebhook = async () => {
    if (!webhookUrl) return;
    await navigator.clipboard.writeText(webhookUrl);
    setWebhookCopied(true);
    setTimeout(() => setWebhookCopied(false), 1500);
  };

  const connectorName =
    typeof flow?.dataSourceId === "object"
      ? (flow.dataSourceId as any).name
      : undefined;
  const destName =
    typeof flow?.destinationDatabaseId === "object"
      ? (flow.destinationDatabaseId as any).name
      : undefined;
  const dataset = flow?.tableDestination?.schema;

  const entities: any[] = cdc?.entities || [];
  const transitions: any[] = cdc?.transitions || [];
  const totalProcessed = entities.reduce(
    (sum: number, e: any) => sum + (e.lastMaterializedSeq || 0),
    0,
  );
  const ss = streamStatus(state);
  const bs = backfillStatus(state, cdc?.backlogCount ?? 0, totalProcessed);

  const kpi = {
    borderRadius: 1.5,
    p: 1.5,
    bgcolor: "background.paper",
    border: 1,
    borderColor: "divider",
    minWidth: 0,
  };
  const kpiLabel = {
    fontSize: "0.68rem",
    letterSpacing: 0.3,
    color: "text.secondary",
    mb: 0.25,
  };
  const kpiValue = { fontWeight: 700, fontSize: "1rem", lineHeight: 1.3 };

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
    >
      {/* Top bar — edit + reset only, actions live in KPI cards */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          px: 1.5,
          py: 0.5,
          borderBottom: 1,
          borderColor: "divider",
          gap: 0.5,
          minHeight: 36,
        }}
      >
        {/* Flow info chips */}
        {connectorName && (
          <Typography variant="caption" color="text.secondary">
            {connectorName}
          </Typography>
        )}
        {connectorName && destName && (
          <Typography variant="caption" color="text.secondary">
            →
          </Typography>
        )}
        {destName && (
          <Typography variant="caption" color="text.secondary">
            {destName}
            {dataset ? ` / ${dataset}` : ""}
          </Typography>
        )}
        {webhookUrl && (
          <Tooltip title={webhookCopied ? "Copied!" : webhookUrl}>
            <IconButton size="small" onClick={copyWebhook} sx={{ ml: 0.5 }}>
              <CopyIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          color="error"
          startIcon={<ResyncIcon sx={{ fontSize: 16 }} />}
          onClick={() => setResyncOpen(true)}
          sx={{ textTransform: "none", fontSize: "0.75rem" }}
        >
          Reset
        </Button>
        {onEdit && (
          <Button
            size="small"
            startIcon={<EditIcon sx={{ fontSize: 16 }} />}
            onClick={onEdit}
            sx={{ textTransform: "none", fontSize: "0.75rem" }}
          >
            Edit
          </Button>
        )}
      </Box>

      <Box sx={{ px: 2, py: 2, display: "grid", gap: 2 }}>
        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {busy && <LinearProgress />}

        {cdc ? (
          <>
            {/* KPI cards */}
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 1.5,
              }}
            >
              {/* Stream Status */}
              <Box sx={kpi}>
                <Typography sx={kpiLabel}>Stream</Typography>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    mb: 0.75,
                  }}
                >
                  <Chip
                    label={ss.label}
                    color={ss.color}
                    size="small"
                    sx={{ fontWeight: 600, fontSize: "0.75rem" }}
                  />
                  {cdc.lagSeconds !== null && cdc.lagSeconds > 0 && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontSize: "0.72rem" }}
                    >
                      {formatLag(cdc.lagSeconds)} lag
                    </Typography>
                  )}
                </Box>
                <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                  {(state === "catchup" || state === "live") && (
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<PauseIcon sx={{ fontSize: 14 }} />}
                      onClick={handlePauseResume}
                      disabled={busy}
                      sx={{ textTransform: "none", fontSize: "0.72rem" }}
                    >
                      Pause
                    </Button>
                  )}
                  {state === "paused" && (
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<ResumeIcon sx={{ fontSize: 14 }} />}
                      onClick={handlePauseResume}
                      disabled={busy}
                      sx={{ textTransform: "none", fontSize: "0.72rem" }}
                    >
                      Resume
                    </Button>
                  )}
                  {state === "degraded" && (
                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      startIcon={<RecoverIcon sx={{ fontSize: 14 }} />}
                      onClick={handleRecover}
                      disabled={busy}
                      sx={{ textTransform: "none", fontSize: "0.72rem" }}
                    >
                      Recover
                    </Button>
                  )}
                </Box>
              </Box>

              {/* Backfill Status */}
              <Box sx={kpi}>
                <Typography sx={kpiLabel}>Backfill</Typography>
                <Box sx={{ mb: 0.75 }}>
                  <Chip
                    label={bs.label}
                    color={bs.color}
                    size="small"
                    sx={{ fontWeight: 600, fontSize: "0.75rem" }}
                  />
                </Box>
                <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                  {state !== "backfill" && (
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<BackfillIcon sx={{ fontSize: 14 }} />}
                      onClick={handleStartBackfill}
                      disabled={busy}
                      sx={{ textTransform: "none", fontSize: "0.72rem" }}
                    >
                      Start
                    </Button>
                  )}
                  {state === "backfill" && (
                    <Button
                      size="small"
                      variant="outlined"
                      color="error"
                      startIcon={<CancelIcon sx={{ fontSize: 14 }} />}
                      onClick={handleStop}
                      disabled={busy}
                      sx={{ textTransform: "none", fontSize: "0.72rem" }}
                    >
                      Stop
                    </Button>
                  )}
                  {cdc.backlogCount > 0 && state !== "backfill" && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ alignSelf: "center", fontSize: "0.72rem" }}
                    >
                      {cdc.backlogCount.toLocaleString()} pending
                    </Typography>
                  )}
                </Box>
              </Box>

              {/* Events Processed */}
              <Box sx={kpi}>
                <Typography sx={kpiLabel}>Events processed</Typography>
                <Typography sx={kpiValue}>
                  {totalProcessed.toLocaleString()}
                </Typography>
                {cdc.lastMaterializedAt && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: "block", mt: 0.25, fontSize: "0.68rem" }}
                  >
                    Last {new Date(cdc.lastMaterializedAt).toLocaleString()}
                  </Typography>
                )}
              </Box>
            </Box>

            {/* Entity table */}
            {entities.length === 0 && (
              <Typography
                variant="body2"
                color="text.secondary"
                textAlign="center"
                py={2}
              >
                No entities synced yet — start a backfill to begin.
              </Typography>
            )}
            {entities.length > 0 && (
              <TableContainer
                sx={{ borderRadius: 1, border: 1, borderColor: "divider" }}
              >
                <Table size="small">
                  <TableHead>
                    <TableRow
                      sx={{
                        "& th": {
                          fontSize: "0.72rem",
                          color: "text.secondary",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: 0.3,
                        },
                      }}
                    >
                      <TableCell>Entity</TableCell>
                      <TableCell>Stream</TableCell>
                      <TableCell>Backfill</TableCell>
                      <TableCell align="right">Processed</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {entities.map((e: any) => {
                      const sc = entityStreamChip(e);
                      const bc = entityBackfillChip(e);
                      return (
                        <TableRow
                          key={e.entity}
                          sx={{ "&:last-child td": { borderBottom: 0 } }}
                        >
                          <TableCell
                            sx={{
                              fontFamily: "monospace",
                              fontSize: "0.78rem",
                              fontWeight: 500,
                            }}
                          >
                            {entityLabel(e.entity)}
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={sc.label}
                              color={sc.color}
                              size="small"
                              variant="outlined"
                              sx={{
                                height: 22,
                                fontSize: "0.68rem",
                                fontWeight: 500,
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <Chip
                              label={bc.label}
                              color={bc.color}
                              size="small"
                              variant="outlined"
                              sx={{
                                height: 22,
                                fontSize: "0.68rem",
                                fontWeight: 500,
                              }}
                            />
                          </TableCell>
                          <TableCell align="right">
                            <Typography
                              fontSize="0.8rem"
                              fontWeight={e.lastMaterializedSeq > 0 ? 600 : 400}
                            >
                              {(e.lastMaterializedSeq || 0).toLocaleString()}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}

            {/* Transition history */}
            {transitions.length > 0 && (
              <Box>
                <Button
                  size="small"
                  onClick={() => setShowTransitions(v => !v)}
                  endIcon={showTransitions ? <CollapseIcon /> : <ExpandIcon />}
                  sx={{
                    textTransform: "none",
                    fontSize: "0.75rem",
                    color: "text.secondary",
                  }}
                >
                  {transitions.length} state transitions
                </Button>
                {showTransitions && (
                  <Box
                    sx={{
                      mt: 0.5,
                      maxHeight: 180,
                      overflow: "auto",
                      borderRadius: 1,
                      bgcolor: "action.hover",
                      p: 1,
                      display: "grid",
                      gap: 0.25,
                    }}
                  >
                    {transitions.map((t: any, i: number) => (
                      <Typography
                        key={`${t.at}-${i}`}
                        variant="caption"
                        sx={{ fontFamily: "monospace", fontSize: "0.72rem" }}
                      >
                        <Typography
                          component="span"
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: "monospace", fontSize: "0.72rem" }}
                        >
                          {new Date(t.at).toLocaleString()}
                        </Typography>
                        {"  "}
                        {t.fromState} → <strong>{t.toState}</strong>
                        {"  "}
                        <Typography
                          component="span"
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: "monospace", fontSize: "0.68rem" }}
                        >
                          ({t.event}
                          {t.reason ? `: ${t.reason}` : ""})
                        </Typography>
                      </Typography>
                    ))}
                  </Box>
                )}
              </Box>
            )}
          </>
        ) : (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              py: 4,
              justifyContent: "center",
            }}
          >
            <LinearProgress sx={{ width: 24 }} />
            <Typography variant="body2" color="text.secondary">
              Loading…
            </Typography>
          </Box>
        )}
      </Box>

      {/* Reset dialog */}
      <Dialog open={resyncOpen} onClose={() => setResyncOpen(false)}>
        <DialogTitle>Reset sync</DialogTitle>
        <DialogContent sx={{ display: "grid", gap: 1, minWidth: 400 }}>
          <Typography variant="body2">
            This will clear all CDC state and restart a full backfill.
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                checked={resyncOpts.deleteDestination}
                onChange={e =>
                  setResyncOpts(o => ({
                    ...o,
                    deleteDestination: e.target.checked,
                  }))
                }
              />
            }
            label="Delete destination tables"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={resyncOpts.clearWebhookEvents}
                onChange={e =>
                  setResyncOpts(o => ({
                    ...o,
                    clearWebhookEvents: e.target.checked,
                  }))
                }
              />
            }
            label="Clear stored webhook events"
          />
          <TextField
            label="Type RESET to confirm"
            value={resyncConfirm}
            onChange={e => setResyncConfirm(e.target.value)}
            size="small"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setResyncOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            disabled={resyncConfirm !== "RESET" || busy}
            onClick={handleResync}
          >
            {busy ? "Resetting…" : "Reset sync"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
