/**
 * DbtRunCard — live dbt run widget rendered inline in chat for the agent's
 * `dbt_run_model` tool result, styled as a Beautiful UI "Task Row": a
 * spinner-ring badge while the run is live, a green/red badge + tint pill
 * once it resolves, and expandable step/log details.
 *
 * The build runs asynchronously in the runner (Inngest), so this card is
 * fully decoupled from the agent turn / chat SSE: it self-polls
 * `GET /runs/:runId` every 2s while the run is queued/running (same pattern as
 * DbtJobView), keeps updating after the turn ends, and resumes on chat reload
 * because the runId is persisted in the tool part. Cancel hits the existing
 * `/runs/:runId/cancel` endpoint.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, IconButton, Tooltip } from "@mui/material";
import {
  Square as StopIcon,
  ChevronDown,
  ExternalLink as OpenIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useDbtStore, type DbtRunItem } from "../store/dbtStore";
import { focusDbtRunsTab } from "../dbt-runtime/shell";
import { formatRowsAffected, formatStepDuration } from "../lib/dbt-step-format";
import { BUI_MONO_FONT_FAMILY } from "./chat/bui-styles";
import {
  BUI_GHOST_ICON_BTN_SX,
  BUI_META_CHIP_SX,
  ResultBadge,
  SpinnerRingBadge,
  StatusPill,
  type BuiPillTone,
} from "./bui-status";
import { formatDuration } from "../utils/format";

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

const STATUS_PILL: Partial<
  Record<
    DbtRunItem["status"] | "cancelling",
    { label: string; tone: BuiPillTone }
  >
> = {
  queued: { label: "Queued", tone: "neutral" },
  cancelling: { label: "Cancelling…", tone: "neutral" },
  success: { label: "Completed", tone: "green" },
  error: { label: "Failed", tone: "red" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

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

  // Slowest nodes first — surfaces the bottlenecks at the top of the card.
  const steps = [...(run?.stepResults ?? [])].sort(
    (a, b) => b.executionTimeMs - a.executionTimeMs,
  );
  const logs = run?.logs ?? [];
  const visibleLogs = logs.slice(-MAX_VISIBLE_LOGS);
  const hasBody = steps.length > 0 || logs.length > 0;

  const command = run?.commands?.[0];
  const title = label
    ? `Build ${label}`
    : command
      ? `dbt ${command}`
      : "dbt build";

  const pill =
    cancelling && isActive
      ? STATUS_PILL.cancelling
      : status === "running"
        ? undefined // the spinner ring already reads as "running"
        : STATUS_PILL[status ?? "queued"];

  // Git provenance: which source tree the build ran (working tree = the
  // caller's checkout + uncommitted drafts; otherwise a committed branch).
  const treeChip = run?.sourceBranch
    ? {
        label: run.workingTreeUserId
          ? `${run.sourceBranch} · draft`
          : run.sourceBranch,
        tooltip: run.workingTreeUserId
          ? `Built your working tree: branch "${run.sourceBranch}" plus your uncommitted drafts.`
          : `Built the committed "${run.sourceBranch}" branch.`,
      }
    : null;

  return (
    <Box
      sx={{
        my: 0.75,
        maxWidth: 560,
        borderRadius: "14px",
        backgroundColor: "var(--bui-surface)",
        boxShadow: "var(--bui-shadow-card)",
        overflow: "hidden",
      }}
    >
      {/* Header: badge + title + status pill, then a meta row (env / branch /
          duration / actions) — two lines so the command stays readable in a
          narrow chat panel instead of being squeezed out by the chips. */}
      <Box
        onClick={() => hasBody && setExpanded(prev => !prev)}
        sx={{
          px: 1.25,
          py: 1,
          cursor: hasBody ? "pointer" : "default",
          transition: "background-color 0.1s",
          "&:hover": hasBody
            ? { backgroundColor: "var(--bui-hover)" }
            : undefined,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
          {isActive ? (
            <SpinnerRingBadge />
          ) : (
            <ResultBadge
              tone={
                status === "success"
                  ? "green"
                  : status === "error"
                    ? "red"
                    : "neutral"
              }
            />
          )}
          <Box
            component="span"
            sx={{
              fontFamily: BUI_MONO_FONT_FAMILY,
              fontSize: "12.5px",
              fontWeight: 600,
              color: "var(--bui-ink)",
              flex: 1,
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={title}
          >
            {title}
          </Box>
          {pill && (
            <StatusPill tone={pill.tone} animateIn>
              {pill.label}
            </StatusPill>
          )}
          {hasBody && (
            <ChevronDown
              size={14}
              style={{
                flexShrink: 0,
                color: "var(--bui-ink-3)",
                transition: "transform 0.2s",
                transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
              }}
            />
          )}
        </Box>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            mt: 0.5,
            ml: "34px",
            flexWrap: "wrap",
          }}
        >
          {run?.environment && (
            <Box component="span" sx={BUI_META_CHIP_SX}>
              {run.environment}
            </Box>
          )}
          {treeChip && (
            <Tooltip title={treeChip.tooltip}>
              <Box component="span" sx={BUI_META_CHIP_SX}>
                {treeChip.label}
              </Box>
            </Tooltip>
          )}
          {run?.durationMs !== undefined && (
            <Box
              component="span"
              sx={{
                fontSize: "0.7rem",
                color: "var(--bui-ink-3)",
                fontFamily: BUI_MONO_FONT_FAMILY,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {formatDuration(run.durationMs)}
            </Box>
          )}
          <Box sx={{ flex: 1 }} />
          {isActive && (
            <Tooltip title="Cancel build">
              <span>
                <IconButton
                  size="small"
                  sx={BUI_GHOST_ICON_BTN_SX}
                  onClick={handleCancel}
                  disabled={cancelling}
                >
                  <StopIcon size={13} />
                </IconButton>
              </span>
            </Tooltip>
          )}
          <Tooltip title="Open in Transforms → Runs">
            <IconButton
              size="small"
              sx={BUI_GHOST_ICON_BTN_SX}
              onClick={event => {
                event.stopPropagation();
                focusDbtRunsTab(projectId, "Runs", runId);
              }}
            >
              <OpenIcon size={13} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Error summary (always visible when failed) */}
      {status === "error" && run?.error && (
        <Box
          sx={{
            mx: 1,
            mb: 1,
            px: 1,
            py: 0.5,
            fontSize: "0.72rem",
            color: "var(--bui-red)",
            backgroundColor: "var(--bui-red-tint)",
            borderRadius: "8px",
          }}
        >
          {run.error}
        </Box>
      )}

      {/* Expandable body: step results + logs */}
      {expanded && hasBody && (
        <Box
          sx={{
            mx: 1,
            mb: 1,
            borderRadius: "8px",
            backgroundColor: "var(--bui-inset)",
            boxShadow: "var(--bui-shadow-hairline)",
            overflow: "hidden",
          }}
        >
          {steps.length > 0 && (
            <Box
              component="table"
              sx={{
                width: "100%",
                fontSize: "0.72rem",
                borderCollapse: "collapse",
                "& td, & th": {
                  borderBottom: "1px solid var(--bui-line)",
                  p: 0.5,
                  textAlign: "left",
                },
                "& th": {
                  color: "var(--bui-ink-3)",
                  fontWeight: 500,
                },
                "& td": { color: "var(--bui-ink-2)" },
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
                      ...(step.status === "error" || step.status === "fail"
                        ? { "& td": { color: "var(--bui-red)" } }
                        : step.status === "warn"
                          ? { "& td": { color: "var(--bui-orange)" } }
                          : {}),
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
                    <td>{formatStepDuration(step.executionTimeMs)}</td>
                    <td>{formatRowsAffected(step.rowsAffected)}</td>
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
                fontFamily: BUI_MONO_FONT_FAMILY,
                fontSize: "0.7rem",
                lineHeight: 1.7,
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
                        ? "var(--bui-red)"
                        : log.level === "warn"
                          ? "var(--bui-orange)"
                          : "var(--bui-ink-2)",
                  }}
                >
                  <Box
                    component="span"
                    sx={{ color: "var(--bui-ink-3)", mr: 1 }}
                  >
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
