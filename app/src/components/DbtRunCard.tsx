/**
 * DbtRunCard — live dbt run widget rendered inline in chat for the agent's
 * `dbt_run_model` tool result.
 *
 * The build runs asynchronously in the runner (Inngest), so this card is
 * fully decoupled from the agent turn / chat SSE: it self-polls
 * `GET /runs/:runId` every 2s while the run is queued/running (same pattern as
 * DbtJobView), keeps updating after the turn ends, and resumes on chat reload
 * because the runId is persisted in the tool part. Cancel hits the existing
 * `/runs/:runId/cancel` endpoint.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Box,
  Chip,
  CircularProgress,
  IconButton,
  Tooltip,
} from "@mui/material";
import {
  Square as StopIcon,
  ChevronRight as ChevronRightIcon,
  ChevronDown as ChevronDownIcon,
  ExternalLink as OpenIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useDbtStore, type DbtRunItem } from "../store/dbtStore";
import { focusDbtRunsTab } from "../dbt-runtime/shell";

interface DbtRunCardProps {
  runId: string;
  projectId: string;
  /** Selector/model label from the tool input (e.g. "stg_orders+"). */
  label?: string;
}

const ACTIVE_POLL_INTERVAL_MS = 2_000;
// Give up polling only after sustained fetch failures (~20s of transient
// errors) so a brief network blip doesn't permanently freeze a live card.
const MAX_POLL_ERRORS = 10;
const MAX_VISIBLE_LOGS = 200;

function statusColor(status: DbtRunItem["status"] | undefined): string {
  switch (status) {
    case "running":
    case "queued":
      return "primary.main";
    case "success":
      return "success.main";
    case "error":
      return "error.main";
    case "cancelled":
      return "text.secondary";
    default:
      return "text.secondary";
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function DbtRunCard({ runId, projectId, label }: DbtRunCardProps) {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const run = useDbtStore(s => s.runDetails[runId]);
  const fetchRunDetails = useDbtStore(s => s.fetchRunDetails);
  const cancelRun = useDbtStore(s => s.cancelRun);

  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const logScrollRef = useRef<HTMLDivElement | null>(null);

  const status = run?.status;
  const isActive = status === "running" || status === "queued";

  // Self-poll while active — decoupled from the agent turn. Mirrors the
  // run-detail poll in DbtJobView. Runs once for already-terminal runs
  // (e.g. on chat reload) and then stops.
  useEffect(() => {
    if (!workspaceId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveErrors = 0;

    const poll = async () => {
      const details = await fetchRunDetails(workspaceId, projectId, runId);
      if (stopped) return;
      const status = details?.status;
      // Stop only on a confirmed terminal status. A transient fetch failure
      // returns null — keep polling (bounded) instead of freezing on "running".
      if (
        status === "success" ||
        status === "error" ||
        status === "cancelled"
      ) {
        return;
      }
      if (!details && ++consecutiveErrors >= MAX_POLL_ERRORS) return;
      if (details) consecutiveErrors = 0;
      timer = setTimeout(() => void poll(), ACTIVE_POLL_INTERVAL_MS);
    };
    void poll();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, projectId, runId, fetchRunDetails]);

  // Auto-scroll logs while expanded + running.
  useEffect(() => {
    if (expanded && isActive && logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [run?.logs, expanded, isActive]);

  const handleCancel = useCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!workspaceId || cancelling) return;
      setCancelling(true);
      await cancelRun(workspaceId, projectId, runId);
      await fetchRunDetails(workspaceId, projectId, runId);
      setCancelling(false);
    },
    [workspaceId, projectId, runId, cancelling, cancelRun, fetchRunDetails],
  );

  const steps = run?.stepResults ?? [];
  const logs = run?.logs ?? [];
  const visibleLogs = logs.slice(-MAX_VISIBLE_LOGS);
  const hasBody = steps.length > 0 || logs.length > 0;

  const command = run?.commands?.[0];
  const title = label
    ? `Build ${label}`
    : command
      ? `dbt ${command}`
      : "dbt build";

  const statusLabel =
    cancelling && isActive ? "Cancelling…" : (status ?? "queued");

  return (
    <Box
      sx={{
        my: 0.75,
        borderRadius: 1.5,
        border: 1,
        borderColor: isActive
          ? "primary.main"
          : status === "error"
            ? "error.main"
            : "divider",
        overflow: "hidden",
        transition: "border-color 0.3s",
        backgroundColor: theme =>
          theme.palette.mode === "dark"
            ? "rgba(255,255,255,0.02)"
            : "rgba(0,0,0,0.015)",
      }}
    >
      {/* Header */}
      <Box
        onClick={() => hasBody && setExpanded(prev => !prev)}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.25,
          py: 0.75,
          cursor: hasBody ? "pointer" : "default",
          "&:hover": hasBody ? { backgroundColor: "action.hover" } : undefined,
        }}
      >
        {hasBody ? (
          expanded ? (
            <ChevronDownIcon size={14} />
          ) : (
            <ChevronRightIcon size={14} />
          )
        ) : (
          <Box sx={{ width: 14 }} />
        )}
        <Box
          component="span"
          sx={{
            fontFamily: "monospace",
            fontSize: "0.8rem",
            fontWeight: 600,
            flex: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={title}
        >
          {title}
        </Box>
        {run?.durationMs !== undefined && (
          <Box
            component="span"
            sx={{ fontSize: "0.72rem", color: "text.secondary" }}
          >
            {formatDuration(run.durationMs)}
          </Box>
        )}
        <Tooltip title="Open in Transforms → Runs">
          <IconButton
            size="small"
            onClick={event => {
              event.stopPropagation();
              focusDbtRunsTab(projectId, "Runs", runId);
            }}
          >
            <OpenIcon size={13} />
          </IconButton>
        </Tooltip>
        <Chip
          size="small"
          variant="outlined"
          icon={isActive ? <CircularProgress size={10} /> : undefined}
          label={statusLabel}
          sx={{
            height: 20,
            textTransform: "capitalize",
            fontWeight: 600,
            color: statusColor(status),
            borderColor: statusColor(status),
          }}
        />
        {isActive && (
          <Tooltip title="Cancel build">
            <span>
              <IconButton
                size="small"
                onClick={handleCancel}
                disabled={cancelling}
              >
                <StopIcon size={13} />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Box>

      {/* Error summary (always visible when failed) */}
      {status === "error" && run?.error && (
        <Box
          sx={{
            px: 1.25,
            py: 0.5,
            fontSize: "0.72rem",
            color: "error.main",
            borderTop: "1px solid",
            borderColor: "divider",
          }}
        >
          {run.error}
        </Box>
      )}

      {/* Expandable body: step results + logs */}
      {expanded && hasBody && (
        <Box sx={{ borderTop: "1px solid", borderColor: "divider" }}>
          {steps.length > 0 && (
            <Box
              component="table"
              sx={{
                width: "100%",
                fontSize: "0.72rem",
                borderCollapse: "collapse",
                "& td, & th": {
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  p: 0.5,
                  textAlign: "left",
                },
              }}
            >
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Time</th>
                  <th>Rows</th>
                </tr>
              </thead>
              <tbody>
                {steps.map(step => (
                  <Box
                    component="tr"
                    key={step.uniqueId}
                    sx={{
                      color:
                        step.status === "error" || step.status === "fail"
                          ? "error.main"
                          : step.status === "warn"
                            ? "warning.main"
                            : "inherit",
                    }}
                  >
                    <td>{step.name}</td>
                    <td>{step.resourceType}</td>
                    <td>
                      {step.status}
                      {step.message &&
                      (step.status === "error" ||
                        step.status === "fail" ||
                        step.status === "warn")
                        ? ` — ${step.message}`
                        : ""}
                    </td>
                    <td>{(step.executionTimeMs / 1000).toFixed(2)}s</td>
                    <td>{step.rowsAffected ?? ""}</td>
                  </Box>
                ))}
              </tbody>
            </Box>
          )}

          {logs.length > 0 && (
            <Box
              ref={logScrollRef}
              sx={{
                maxHeight: 220,
                overflow: "auto",
                fontFamily: "monospace",
                fontSize: "0.7rem",
                p: 1,
                whiteSpace: "pre-wrap",
              }}
            >
              {visibleLogs.map((log, index) => (
                <Box
                  key={index}
                  component="div"
                  sx={{
                    color:
                      log.level === "error"
                        ? "error.main"
                        : log.level === "warn"
                          ? "warning.main"
                          : "text.primary",
                  }}
                >
                  <Box component="span" sx={{ color: "text.secondary", mr: 1 }}>
                    {new Date(log.ts).toLocaleTimeString()}
                  </Box>
                  {log.line}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
