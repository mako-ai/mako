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
  Sync as SyncIcon,
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
import { useFlowStore, type FlowExecutionHistory } from "../store/flowStore";

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

function stateChipColor(
  state: CdcState,
): "success" | "info" | "error" | "default" {
  switch (state) {
    case "live":
      return "success";
    case "backfill":
    case "catchup":
      return "info";
    case "degraded":
      return "error";
    default:
      return "default";
  }
}

function camelToSnake(v: string): string {
  return v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function entityLabel(entity: string): string {
  if (!entity.includes(":")) return entity;
  const [parent, sub] = entity.split(":");
  return parent && sub ? `${camelToSnake(sub)}_${parent}` : entity;
}

export function BackfillPanel({
  workspaceId,
  flowId,
  onEdit,
}: BackfillPanelProps) {
  const {
    flows: flowsMap,
    backfillFlow,
    startCdcBackfill,
    fetchFlowHistory,
    cancelFlowExecution,
    fetchCdcStatus,
    pauseCdcFlow,
    resumeCdcFlow,
    resyncCdcFlow,
    recoverCdcFlow,
  } = useFlowStore();

  const [cdc, setCdc] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<FlowExecutionHistory[]>([]);
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
  const isCdc = flow?.syncEngine === "cdc";
  const state: CdcState = cdc?.syncState || "idle";

  const poll = useCallback(async () => {
    const status = await fetchCdcStatus(workspaceId, flowId);
    if (status) setCdc(status);
  }, [fetchCdcStatus, workspaceId, flowId]);

  useEffect(() => {
    if (!isCdc) return;
    poll();
    cdcPollRef.current = setInterval(poll, 5000);
    return () => {
      if (cdcPollRef.current) clearInterval(cdcPollRef.current);
    };
  }, [isCdc, poll]);

  useEffect(() => {
    if (isCdc) return;
    fetchFlowHistory(workspaceId, flowId, 10).then(runs => {
      if (runs) setHistory(runs);
    });
  }, [isCdc, workspaceId, flowId, fetchFlowHistory]);

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
      if (isCdc) {
        const ok = await startCdcBackfill(workspaceId, flowId);
        if (!ok) throw new Error("Failed to start backfill");
      } else {
        await backfillFlow(workspaceId, flowId);
      }
    });

  const handleCancel = () =>
    withBusy(async () => {
      if (isCdc) {
        const ok = await pauseCdcFlow(workspaceId, flowId);
        if (!ok) throw new Error("Failed to pause flow");
      } else {
        await cancelFlowExecution(workspaceId, flowId, null);
      }
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

  // --- Non-CDC legacy path (simple backfill trigger + history) ---
  if (!isCdc) {
    return (
      <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2,
            py: 1,
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <Button
            size="small"
            variant="contained"
            startIcon={<SyncIcon />}
            onClick={handleStartBackfill}
            disabled={busy}
          >
            {busy ? "Running…" : "Run Backfill"}
          </Button>
        </Box>
        <Box sx={{ flex: 1, overflow: "auto", p: 2 }}>
          {error && (
            <Alert
              severity="error"
              sx={{ mb: 2 }}
              onClose={() => setError(null)}
            >
              {error}
            </Alert>
          )}
          {history.length > 0 ? (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Date</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right">Duration</TableCell>
                    <TableCell align="right">Records</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {history.map(run => (
                    <TableRow key={run.executionId}>
                      <TableCell>
                        {new Date(
                          run.startedAt || run.executedAt,
                        ).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={run.status}
                          size="small"
                          color={
                            run.status === "completed"
                              ? "success"
                              : run.status === "running"
                                ? "info"
                                : "error"
                          }
                          variant="outlined"
                        />
                      </TableCell>
                      <TableCell align="right">
                        {run.duration
                          ? `${Math.round(run.duration / 1000)}s`
                          : "—"}
                      </TableCell>
                      <TableCell align="right">
                        {(
                          run.stats as any
                        )?.recordsProcessed?.toLocaleString() || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Typography color="text.secondary" textAlign="center" py={4}>
              No backfill runs yet
            </Typography>
          )}
        </Box>
      </Box>
    );
  }

  // --- CDC flow path ---
  const entities: any[] = cdc?.entities || [];
  const transitions: any[] = cdc?.transitions || [];

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
      }}
    >
      {/* Action bar */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          px: 1.5,
          py: 0.75,
          borderBottom: 1,
          borderColor: "divider",
          gap: 0.5,
          minHeight: 40,
        }}
      >
        {(state === "idle" || state === "paused" || state === "degraded") && (
          <Button
            size="small"
            startIcon={<SyncIcon />}
            onClick={handleStartBackfill}
            disabled={busy}
          >
            Start backfill
          </Button>
        )}
        {state === "backfill" && (
          <>
            <Chip label="Backfilling…" size="small" color="info" />
            <Button
              size="small"
              color="error"
              startIcon={<CancelIcon />}
              onClick={handleCancel}
              disabled={busy}
            >
              Stop
            </Button>
          </>
        )}
        {(state === "catchup" || state === "live") && (
          <Button
            size="small"
            startIcon={<PauseIcon />}
            onClick={handlePauseResume}
            disabled={busy}
          >
            Pause
          </Button>
        )}
        {state === "paused" && (
          <Button
            size="small"
            startIcon={<ResumeIcon />}
            onClick={handlePauseResume}
            disabled={busy}
          >
            Resume
          </Button>
        )}
        {state === "degraded" && (
          <Button
            size="small"
            startIcon={<RecoverIcon />}
            onClick={handleRecover}
            disabled={busy}
          >
            Recover
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          color="error"
          startIcon={<ResyncIcon />}
          onClick={() => setResyncOpen(true)}
        >
          Reset
        </Button>
        {onEdit && (
          <Button size="small" startIcon={<EditIcon />} onClick={onEdit}>
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

        {/* Status header */}
        {cdc ? (
          <>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                flexWrap: "wrap",
              }}
            >
              <Chip
                label={state.charAt(0).toUpperCase() + state.slice(1)}
                color={stateChipColor(state)}
                size="small"
              />
              {cdc.backlogCount > 0 && (
                <Typography variant="body2" color="text.secondary">
                  {cdc.backlogCount.toLocaleString()} pending
                </Typography>
              )}
              {cdc.lagSeconds !== null && cdc.lagSeconds > 0 && (
                <Typography variant="body2" color="text.secondary">
                  Lag {formatLag(cdc.lagSeconds)}
                </Typography>
              )}
              {cdc.lastMaterializedAt && (
                <Typography variant="caption" color="text.secondary">
                  Last materialized{" "}
                  {new Date(cdc.lastMaterializedAt).toLocaleString()}
                </Typography>
              )}
            </Box>

            {/* Flow info */}
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "90px 1fr",
                rowGap: 0.25,
                columnGap: 1.5,
                fontSize: "0.78rem",
                "& .lbl": { color: "text.secondary" },
              }}
            >
              {connectorName && (
                <>
                  <Typography className="lbl" fontSize="inherit">
                    Source
                  </Typography>
                  <Typography fontSize="inherit" fontWeight={500}>
                    {connectorName}
                  </Typography>
                </>
              )}
              {destName && (
                <>
                  <Typography className="lbl" fontSize="inherit">
                    Destination
                  </Typography>
                  <Typography fontSize="inherit" fontWeight={500}>
                    {destName}
                    {dataset ? ` / ${dataset}` : ""}
                  </Typography>
                </>
              )}
              {webhookUrl && (
                <>
                  <Typography className="lbl" fontSize="inherit">
                    Webhook
                  </Typography>
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 0.5,
                      minWidth: 0,
                    }}
                  >
                    <Typography
                      fontSize="inherit"
                      sx={{
                        fontFamily: "monospace",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {webhookUrl}
                    </Typography>
                    <Tooltip title={webhookCopied ? "Copied" : "Copy"}>
                      <IconButton size="small" onClick={copyWebhook}>
                        <CopyIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </>
              )}
            </Box>

            {/* Entity table */}
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
                        },
                      }}
                    >
                      <TableCell>Entity</TableCell>
                      <TableCell align="right">Queued</TableCell>
                      <TableCell align="right">Lag</TableCell>
                      <TableCell align="right">Last materialized</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {entities.map((e: any) => (
                      <TableRow
                        key={e.entity}
                        sx={{ "&:last-child td": { borderBottom: 0 } }}
                      >
                        <TableCell
                          sx={{ fontFamily: "monospace", fontSize: "0.78rem" }}
                        >
                          {entityLabel(e.entity)}
                        </TableCell>
                        <TableCell align="right">{e.backlogCount}</TableCell>
                        <TableCell align="right">
                          {formatLag(e.lagSeconds)}
                        </TableCell>
                        <TableCell align="right">
                          <Typography variant="caption" color="text.secondary">
                            {e.lastMaterializedAt
                              ? new Date(e.lastMaterializedAt).toLocaleString()
                              : "—"}
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}

            {/* Transition history (collapsible) */}
            {transitions.length > 0 && (
              <Box>
                <Button
                  size="small"
                  onClick={() => setShowTransitions(v => !v)}
                  endIcon={showTransitions ? <CollapseIcon /> : <ExpandIcon />}
                  sx={{
                    textTransform: "none",
                    fontSize: "0.78rem",
                    color: "text.secondary",
                  }}
                >
                  {transitions.length} transitions
                </Button>
                {showTransitions && (
                  <Box
                    sx={{
                      mt: 0.5,
                      maxHeight: 200,
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
            <SyncIcon
              sx={{
                fontSize: 16,
                animation: "spin 1s linear infinite",
                "@keyframes spin": {
                  from: { transform: "rotate(0deg)" },
                  to: { transform: "rotate(360deg)" },
                },
              }}
            />
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
