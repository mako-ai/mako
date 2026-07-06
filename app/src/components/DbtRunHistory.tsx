/**
 * DbtRunHistory — shared run-history list + live-log detail panel.
 *
 * Extracted from DbtJobView so the same UI backs both the job-scoped run
 * history and the project-wide Runs view (DbtRunsView), which also surfaces
 * ad-hoc agent/editor runs that have no jobId. Selection is controlled by the
 * parent so callers can focus a specific run (e.g. from the chat card or after
 * triggering a run). This component owns run-detail polling, log auto-scroll,
 * and the retry action.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  InputAdornment,
  MenuItem,
  Select,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  FileCode as ModelIcon,
  RotateCcw as RetryIcon,
  Download as DownloadIcon,
  Search as SearchIcon,
  Square as StopIcon,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  ArrowUp as ArrowUpIcon,
  ArrowDown as ArrowDownIcon,
  ArrowLeft as BackIcon,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  useDbtStore,
  type DbtRunItem,
  type DbtArtifactKind,
  type DbtStepResult,
} from "../store/dbtStore";
import { useSchemaStore } from "../store/schemaStore";
import { focusDbtFileTab } from "../dbt-runtime/shell";
import { envBadgeColor } from "../lib/dbt-env";
import { useIsMobile } from "../hooks/useIsMobile";

const ARTIFACT_LABELS: Record<DbtArtifactKind, string> = {
  manifest: "manifest.json",
  catalog: "catalog.json",
  runResults: "run_results.json",
  sources: "sources.json",
};
const ARTIFACT_ORDER: DbtArtifactKind[] = [
  "manifest",
  "runResults",
  "catalog",
  "sources",
];

// Stop polling only after sustained fetch failures (~20s) so a transient blip
// doesn't permanently freeze the detail panel on a non-terminal status.
const MAX_POLL_ERRORS = 10;

function statusColor(status: DbtRunItem["status"]): string {
  switch (status) {
    case "running":
    case "queued":
      return "primary.main";
    case "success":
      return "success.main";
    case "error":
      return "error.main";
    case "cancelled":
      return "warning.main";
    default:
      return "text.secondary";
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function relativeTime(iso?: string): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function absoluteTime(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function commandSummary(run: DbtRunItem): string {
  return run.commands.map(command => `dbt ${command}`).join(" → ");
}

/** Short, human label for a run row in the project-wide view. */
function runSourceLabel(
  run: DbtRunItem,
  jobNameById?: Record<string, string>,
): string {
  if (run.jobId && jobNameById?.[run.jobId]) return jobNameById[run.jobId];
  return commandSummary(run);
}

/**
 * Git provenance chip: which source tree the run built. Working-tree runs
 * (editor / chat ad-hoc) include the caller's uncommitted drafts; everything
 * else builds a committed branch (jobs, deploys, CI).
 */
function runTreeChip(
  run: Pick<DbtRunItem, "sourceBranch" | "workingTreeUserId" | "ci">,
): { label: string; tooltip: string; draft: boolean } | null {
  if (!run.sourceBranch) return null;
  if (run.workingTreeUserId) {
    return {
      label: `${run.sourceBranch} · draft`,
      tooltip:
        `Built a working tree: branch "${run.sourceBranch}" plus the ` +
        "runner's uncommitted drafts at run time.",
      draft: true,
    };
  }
  return {
    label: run.sourceBranch,
    tooltip: `Built the committed "${run.sourceBranch}" branch${
      run.ci ? ` (PR #${run.ci.prNumber} head)` : ""
    }.`,
    draft: false,
  };
}

/** Sortable columns of the node-results table. */
type NodeSortKey =
  | "name"
  | "resourceType"
  | "status"
  | "executionTimeMs"
  | "rowsAffected";
type SortDir = "asc" | "desc";

const NODE_COLUMNS: { key: NodeSortKey; label: string }[] = [
  { key: "name", label: "Node" },
  { key: "resourceType", label: "Type" },
  { key: "status", label: "Status" },
  { key: "executionTimeMs", label: "Time" },
  { key: "rowsAffected", label: "Rows" },
];

// Numeric columns default to descending (largest first); text columns ascending.
const NUMERIC_SORT_KEYS = new Set<NodeSortKey>([
  "executionTimeMs",
  "rowsAffected",
]);

function compareSteps(
  a: DbtStepResult,
  b: DbtStepResult,
  key: NodeSortKey,
): number {
  switch (key) {
    case "executionTimeMs":
      return a.executionTimeMs - b.executionTimeMs;
    case "rowsAffected":
      return (a.rowsAffected ?? -1) - (b.rowsAffected ?? -1);
    default:
      return String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
  }
}

export interface DbtRunHistoryProps {
  workspaceId: string | undefined;
  projectId: string;
  runs: DbtRunItem[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  /** Project-wide Runs view: surface the source (job name / command) per row. */
  showSource?: boolean;
  /** jobId → name, used to label job runs in the project-wide view. */
  jobNameById?: Record<string, string>;
  /** Message shown when there are no runs. */
  emptyHint?: string;
}

export default function DbtRunHistory({
  workspaceId,
  projectId,
  runs,
  selectedRunId,
  onSelectRun,
  showSource = false,
  jobNameById,
  emptyHint = "No runs yet.",
}: DbtRunHistoryProps) {
  const runDetails = useDbtStore(s => s.runDetails);
  const fetchRunDetails = useDbtStore(s => s.fetchRunDetails);
  const retryRun = useDbtStore(s => s.retryRun);
  const cancelRun = useDbtStore(s => s.cancelRun);
  const downloadRunArtifact = useDbtStore(s => s.downloadRunArtifact);
  const project = useDbtStore(s => s.projects.find(p => p._id === projectId));
  const connections = useSchemaStore(s =>
    workspaceId ? s.connections[workspaceId] : undefined,
  );

  // Tooltip resolving what an environment actually targets (connection +
  // schema). Falls back to the bare env name for envs removed from the project
  // config after the run happened.
  const envTooltip = useCallback(
    (envName: string): string => {
      const env = project?.environments.find(e => e.name === envName);
      if (!env) return `Environment: ${envName}`;
      const connectionName = connections?.find(
        c => c.id === env.connectionId,
      )?.name;
      return `Environment: ${envName} · ${connectionName ?? "connection"} · schema ${env.targetSchema}`;
    },
    [project?.environments, connections],
  );

  const isMobile = useIsMobile();
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [logQuery, setLogQuery] = useState("");
  const [cancelling, setCancelling] = useState(false);
  // Nodes table: default sort by execution time, slowest first.
  const [sortKey, setSortKey] = useState<NodeSortKey>("executionTimeMs");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [nodesCollapsed, setNodesCollapsed] = useState(false);
  // Mobile master/detail: land on the run list (full screen) and only show the
  // detail once a run is tapped, with a "Runs" back button to return. Start on
  // detail only when a run is already focused at mount (e.g. a chat deep-link).
  const [mobileView, setMobileView] = useState<"list" | "detail">(
    selectedRunId ? "detail" : "list",
  );

  const selectedRun = selectedRunId ? runDetails[selectedRunId] : undefined;
  const selectedRunListItem = runs.find(run => run._id === selectedRunId);
  const selectedStatus = selectedRun?.status ?? selectedRunListItem?.status;
  const selectedDetail = selectedRun ?? selectedRunListItem;
  const isActiveSelection =
    selectedStatus === "running" || selectedStatus === "queued";

  // Reset filters, sort + cancel state when switching runs.
  useEffect(() => {
    setStatusFilter("all");
    setLogQuery("");
    setCancelling(false);
    setSortKey("executionTimeMs");
    setSortDir("desc");
    setNodesCollapsed(false);
  }, [selectedRunId]);

  const handleSort = useCallback((key: NodeSortKey) => {
    setSortKey(prevKey => {
      if (prevKey === key) {
        setSortDir(prevDir => (prevDir === "asc" ? "desc" : "asc"));
        return prevKey;
      }
      setSortDir(NUMERIC_SORT_KEYS.has(key) ? "desc" : "asc");
      return key;
    });
  }, []);

  const stepResults = useMemo(
    () => selectedRun?.stepResults ?? [],
    [selectedRun?.stepResults],
  );
  const stepStatuses = useMemo(
    () => Array.from(new Set(stepResults.map(s => s.status))).sort(),
    [stepResults],
  );
  const filteredSteps = useMemo(
    () =>
      statusFilter === "all"
        ? stepResults
        : stepResults.filter(s => s.status === statusFilter),
    [stepResults, statusFilter],
  );
  const sortedSteps = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filteredSteps].sort((a, b) => {
      const primary = compareSteps(a, b, sortKey);
      // Stable tie-break by node name so equal values keep a deterministic order.
      const cmp = primary !== 0 ? primary : a.name.localeCompare(b.name);
      return cmp * dir;
    });
  }, [filteredSteps, sortKey, sortDir]);
  const visibleLogs = useMemo(() => {
    const logs = selectedRun?.logs ?? [];
    const query = logQuery.trim().toLowerCase();
    if (!query) return logs;
    return logs.filter(log => log.line.toLowerCase().includes(query));
  }, [selectedRun?.logs, logQuery]);

  // Fetch details when selection changes; poll every 2s while running/queued.
  useEffect(() => {
    if (!workspaceId || !selectedRunId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveErrors = 0;

    const poll = async () => {
      const details = await fetchRunDetails(
        workspaceId,
        projectId,
        selectedRunId,
      );
      if (stopped) return;
      const status = details?.status;
      // Stop only on a confirmed terminal status. A transient fetch failure
      // returns null — keep polling (bounded) rather than freezing on "running".
      if (
        status === "success" ||
        status === "error" ||
        status === "cancelled"
      ) {
        return;
      }
      if (!details && ++consecutiveErrors >= MAX_POLL_ERRORS) return;
      if (details) consecutiveErrors = 0;
      timer = setTimeout(() => void poll(), 2000);
    };
    void poll();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, projectId, selectedRunId, fetchRunDetails]);

  // Auto-scroll logs while running.
  useEffect(() => {
    if (
      (selectedStatus === "running" || selectedStatus === "queued") &&
      logScrollRef.current
    ) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [selectedRun?.logs.length, selectedStatus]);

  const handleRetry = useCallback(async () => {
    if (!workspaceId || !selectedRunId) return;
    const runId = await retryRun(
      workspaceId,
      projectId,
      selectedRunId,
      selectedRunListItem?.jobId,
    );
    if (runId) onSelectRun(runId);
  }, [
    workspaceId,
    projectId,
    selectedRunId,
    selectedRunListItem?.jobId,
    retryRun,
    onSelectRun,
  ]);

  const handleCancel = useCallback(async () => {
    if (!workspaceId || !selectedRunId || cancelling) return;
    // Optimistically flip to "Cancelling…"; the poll/refetch reconciles it to
    // "Cancelled" once the runner finalizes.
    setCancelling(true);
    await cancelRun(workspaceId, projectId, selectedRunId);
    await fetchRunDetails(workspaceId, projectId, selectedRunId);
  }, [
    workspaceId,
    projectId,
    selectedRunId,
    cancelling,
    cancelRun,
    fetchRunDetails,
  ]);

  // Clear the optimistic "Cancelling…" label once the run reaches a terminal
  // status (cancelled/success/error) — the poll keeps fetching until then.
  useEffect(() => {
    if (cancelling && selectedStatus && !isActiveSelection) {
      setCancelling(false);
    }
  }, [cancelling, selectedStatus, isActiveSelection]);

  const cancelChipLabel =
    cancelling && isActiveSelection
      ? "Cancelling…"
      : (selectedStatus ?? "queued");

  const listContent = (
    <Box sx={{ height: "100%", overflow: "auto" }}>
      {runs.length === 0 ? (
        <Box sx={{ p: 2 }}>
          <Typography variant="caption" color="text.secondary">
            {emptyHint}
          </Typography>
        </Box>
      ) : (
        runs.map(run => {
          const isSelected = run._id === selectedRunId;
          const isActive = run.status === "running" || run.status === "queued";
          const select = () => {
            onSelectRun(run._id);
            setMobileView("detail");
          };
          return (
            <Box
              key={run._id}
              role="button"
              tabIndex={0}
              onClick={select}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  select();
                }
              }}
              title={absoluteTime(run.createdAt)}
              sx={{
                px: 1.5,
                py: 0.75,
                cursor: "pointer",
                borderBottom: "1px solid",
                borderColor: "divider",
                backgroundColor: isSelected ? "action.selected" : "transparent",
                "&:hover": { backgroundColor: "action.hover" },
                "&:focus-visible": {
                  outline: "2px solid",
                  outlineColor: "primary.main",
                  outlineOffset: "-2px",
                },
              }}
            >
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.75,
                }}
              >
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor: statusColor(run.status),
                    flexShrink: 0,
                  }}
                />
                <Typography
                  variant="caption"
                  sx={{
                    flex: 1,
                    fontWeight: 600,
                    color: statusColor(run.status),
                    textTransform: "capitalize",
                    display: "flex",
                    alignItems: "center",
                    gap: 0.5,
                  }}
                >
                  {run.status}
                  {isActive && <CircularProgress size={9} />}
                </Typography>
                {run.environment && (
                  <Tooltip title={envTooltip(run.environment)}>
                    <Chip
                      label={run.environment}
                      size="small"
                      variant="outlined"
                      color={envBadgeColor(
                        run.environment,
                        project?.defaultEnvironment,
                      )}
                      sx={{
                        height: 16,
                        fontSize: "0.62rem",
                        flexShrink: 0,
                        "& .MuiChip-label": { px: 0.5 },
                      }}
                    />
                  </Tooltip>
                )}
                {(() => {
                  const tree = runTreeChip(run);
                  if (!tree) return null;
                  return (
                    <Tooltip title={tree.tooltip}>
                      <Chip
                        label={tree.label}
                        size="small"
                        variant="outlined"
                        color={tree.draft ? "info" : "default"}
                        sx={{
                          height: 16,
                          fontSize: "0.62rem",
                          flexShrink: 0,
                          fontFamily: "monospace",
                          "& .MuiChip-label": { px: 0.5 },
                        }}
                      />
                    </Tooltip>
                  );
                })()}
                {run.durationMs !== undefined && (
                  <Typography variant="caption" color="text.secondary">
                    {formatDuration(run.durationMs)}
                  </Typography>
                )}
              </Box>
              {showSource && (
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    mt: 0.25,
                    fontFamily: "monospace",
                    fontSize: "0.68rem",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: "text.primary",
                  }}
                  title={runSourceLabel(run, jobNameById)}
                >
                  {runSourceLabel(run, jobNameById)}
                </Typography>
              )}
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.5,
                  mt: 0.25,
                }}
              >
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ flex: 1 }}
                >
                  {relativeTime(run.createdAt)}
                </Typography>
                {run.ci ? (
                  <Typography
                    variant="caption"
                    sx={{ fontSize: "0.65rem", color: "primary.main" }}
                  >
                    CI · PR #{run.ci.prNumber}
                  </Typography>
                ) : (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ fontSize: "0.65rem" }}
                  >
                    {run.trigger}
                  </Typography>
                )}
              </Box>
            </Box>
          );
        })
      )}
    </Box>
  );

  const detailContent =
    !selectedRun && !selectedRunListItem ? (
      <Box sx={{ p: 2 }}>
        <Typography variant="caption" color="text.secondary">
          Select a run to see details.
        </Typography>
      </Box>
    ) : (
      <Box
        sx={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Mobile: return to the (full-screen) run list. */}
        {isMobile && (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              px: 0.5,
              py: 0.25,
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
            <Button
              size="small"
              startIcon={<BackIcon size={16} />}
              onClick={() => setMobileView("list")}
            >
              Runs
            </Button>
          </Box>
        )}
        {/* Summary strip */}
        <Box
          sx={{
            display: "flex",
            gap: 2,
            alignItems: "center",
            px: 1.5,
            py: 0.75,
            borderBottom: "1px solid",
            borderColor: "divider",
            flexWrap: "wrap",
          }}
        >
          <Chip
            size="small"
            variant="outlined"
            icon={
              isActiveSelection ? <CircularProgress size={10} /> : undefined
            }
            label={cancelChipLabel}
            sx={{
              height: 20,
              textTransform: "capitalize",
              fontWeight: 600,
              color: statusColor(
                (selectedStatus ?? "queued") as DbtRunItem["status"],
              ),
              borderColor: statusColor(
                (selectedStatus ?? "queued") as DbtRunItem["status"],
              ),
            }}
          />
          {selectedDetail?.environment && (
            <Tooltip title={envTooltip(selectedDetail.environment)}>
              <Chip
                label={selectedDetail.environment}
                size="small"
                variant="outlined"
                color={envBadgeColor(
                  selectedDetail.environment,
                  project?.defaultEnvironment,
                )}
                sx={{ height: 20 }}
              />
            </Tooltip>
          )}
          {(() => {
            const tree = selectedDetail ? runTreeChip(selectedDetail) : null;
            if (!tree) return null;
            return (
              <Tooltip title={tree.tooltip}>
                <Chip
                  label={tree.label}
                  size="small"
                  variant="outlined"
                  color={tree.draft ? "info" : "default"}
                  sx={{ height: 20, fontFamily: "monospace" }}
                />
              </Tooltip>
            );
          })()}
          <Typography
            variant="caption"
            color="text.secondary"
            title={absoluteTime(
              (selectedRun ?? selectedRunListItem)?.createdAt,
            )}
          >
            {relativeTime((selectedRun ?? selectedRunListItem)?.createdAt)}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              fontFamily: "monospace",
              maxWidth: 360,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={(selectedRun ?? selectedRunListItem)?.commands
              .map(command => `dbt ${command}`)
              .join(" → ")}
          >
            {(selectedRun ?? selectedRunListItem)?.commands
              .map(command => `dbt ${command}`)
              .join(" → ")}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {formatDuration((selectedRun ?? selectedRunListItem)?.durationMs)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {(selectedRun ?? selectedRunListItem)?.trigger} ·{" "}
            {(selectedRun ?? selectedRunListItem)?.triggeredBy}
          </Typography>
          {selectedStatus === "cancelled" && selectedDetail?.cancelledBy && (
            <Typography
              variant="caption"
              sx={{ color: "warning.main" }}
              title={absoluteTime(selectedDetail.cancelledAt)}
            >
              cancelled by {selectedDetail.cancelledBy}
              {selectedDetail.cancelledAt
                ? ` · ${relativeTime(selectedDetail.cancelledAt)}`
                : ""}
            </Typography>
          )}
          {(selectedRun ?? selectedRunListItem)?.error && (
            <Typography variant="caption" color="error">
              {(selectedRun ?? selectedRunListItem)?.error}
            </Typography>
          )}
          {isActiveSelection && (
            <Tooltip title="Stop this run (terminates the dbt process)">
              <span style={{ marginLeft: "auto" }}>
                <Button
                  size="small"
                  color="warning"
                  variant="outlined"
                  startIcon={<StopIcon size={14} />}
                  onClick={handleCancel}
                  disabled={cancelling}
                >
                  {cancelling ? "Cancelling…" : "Cancel"}
                </Button>
              </span>
            </Tooltip>
          )}
          {selectedStatus === "error" && (
            <Tooltip title="Re-run only the failed/skipped nodes">
              <Button
                size="small"
                variant="outlined"
                startIcon={<RetryIcon size={14} />}
                onClick={handleRetry}
                sx={{ ml: "auto" }}
              >
                Retry from failure
              </Button>
            </Tooltip>
          )}
        </Box>

        {/* Artifacts (manifest/run_results/catalog/sources). Screenshot 45. */}
        {(() => {
          const available = ARTIFACT_ORDER.filter(
            kind => selectedRun?.artifactKeys?.[kind],
          );
          if (available.length === 0) return null;
          return (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                px: 1.5,
                py: 0.5,
                borderBottom: "1px solid",
                borderColor: "divider",
                flexWrap: "wrap",
              }}
            >
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontWeight: 600 }}
              >
                Artifacts
              </Typography>
              {available.map(kind => (
                <Button
                  key={kind}
                  size="small"
                  variant="outlined"
                  startIcon={<DownloadIcon size={12} />}
                  onClick={() => {
                    if (workspaceId && selectedRunId) {
                      void downloadRunArtifact(
                        workspaceId,
                        projectId,
                        selectedRunId,
                        kind,
                      );
                    }
                  }}
                  sx={{
                    py: 0,
                    minHeight: 22,
                    fontSize: "0.68rem",
                    textTransform: "none",
                  }}
                >
                  {ARTIFACT_LABELS[kind]}
                </Button>
              ))}
            </Box>
          );
        })()}

        {/* Node results table + status filter (screenshot 46). Sortable
                  headers (default: slowest first) and a collapse toggle so the
                  table can be tucked away to give the logs more room. */}
        {stepResults.length > 0 && (
          <Box
            sx={{
              maxHeight: nodesCollapsed ? "none" : "45%",
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                px: 1.5,
                py: 0.5,
              }}
            >
              <Tooltip
                title={nodesCollapsed ? "Expand nodes" : "Collapse nodes"}
              >
                <IconButton
                  size="small"
                  onClick={() => setNodesCollapsed(prev => !prev)}
                  aria-label={
                    nodesCollapsed ? "Expand nodes" : "Collapse nodes"
                  }
                  aria-expanded={!nodesCollapsed}
                >
                  {nodesCollapsed ? (
                    <ChevronRightIcon size={14} />
                  ) : (
                    <ChevronDownIcon size={14} />
                  )}
                </IconButton>
              </Tooltip>
              <Select
                size="small"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                sx={{ fontSize: "0.72rem", minHeight: 28 }}
              >
                <MenuItem value="all">All ({stepResults.length})</MenuItem>
                {stepStatuses.map(status => (
                  <MenuItem
                    key={status}
                    value={status}
                    sx={{ textTransform: "capitalize" }}
                  >
                    {status} (
                    {stepResults.filter(s => s.status === status).length})
                  </MenuItem>
                ))}
              </Select>
              <Typography variant="caption" color="text.secondary">
                {filteredSteps.length} node
                {filteredSteps.length === 1 ? "" : "s"}
              </Typography>
            </Box>
            {!nodesCollapsed && (
              <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                <Box
                  component="table"
                  sx={{
                    width: "100%",
                    fontSize: "0.75rem",
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
                      {NODE_COLUMNS.map(col => {
                        const active = sortKey === col.key;
                        return (
                          <Box
                            component="th"
                            key={col.key}
                            onClick={() => handleSort(col.key)}
                            role="button"
                            aria-sort={
                              active
                                ? sortDir === "asc"
                                  ? "ascending"
                                  : "descending"
                                : "none"
                            }
                            sx={{
                              cursor: "pointer",
                              userSelect: "none",
                              whiteSpace: "nowrap",
                              fontWeight: active ? 700 : 600,
                              color: active ? "text.primary" : "text.secondary",
                              "&:hover": { color: "text.primary" },
                            }}
                          >
                            <Box
                              sx={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 0.25,
                              }}
                            >
                              {col.label}
                              {active &&
                                (sortDir === "asc" ? (
                                  <ArrowUpIcon size={11} />
                                ) : (
                                  <ArrowDownIcon size={11} />
                                ))}
                            </Box>
                          </Box>
                        );
                      })}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedSteps.map(step => (
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
                            step.status === "warn" ||
                            step.resourceType === "source")
                            ? ` — ${step.message}`
                            : ""}
                        </td>
                        <td>{(step.executionTimeMs / 1000).toFixed(2)}s</td>
                        <td>{step.rowsAffected ?? ""}</td>
                        <td>
                          {step.resourceType === "model" && (
                            <Tooltip title="Open model">
                              <IconButton
                                size="small"
                                onClick={() =>
                                  focusDbtFileTab(
                                    projectId,
                                    `models/${step.name}.sql`,
                                  )
                                }
                              >
                                <ModelIcon size={12} />
                              </IconButton>
                            </Tooltip>
                          )}
                        </td>
                      </Box>
                    ))}
                  </tbody>
                </Box>
              </Box>
            )}
          </Box>
        )}

        {/* Logs + search */}
        {(selectedRun?.logs ?? []).length > 0 && (
          <Box
            sx={{
              px: 1.5,
              py: 0.5,
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
            <TextField
              size="small"
              fullWidth
              placeholder="Search logs…"
              value={logQuery}
              onChange={e => setLogQuery(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon size={14} />
                  </InputAdornment>
                ),
              }}
              sx={{ "& .MuiInputBase-input": { fontSize: "0.72rem" } }}
            />
          </Box>
        )}
        <Box
          ref={logScrollRef}
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            fontFamily: "monospace",
            fontSize: "0.72rem",
            p: 1,
            whiteSpace: "pre-wrap",
          }}
        >
          {(selectedRun?.logs ?? []).length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              {selectedStatus === "queued" ? "Run queued…" : "No logs."}
            </Typography>
          ) : visibleLogs.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              No log lines match “{logQuery}”.
            </Typography>
          ) : (
            visibleLogs.map((log, index) => (
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
            ))
          )}
        </Box>
      </Box>
    );

  // Mobile: full-screen master/detail so neither pane is squeezed into a
  // sliver. Land on the run list; tapping a run opens the detail (which has a
  // "Runs" back button). Desktop keeps the side-by-side resizable split.
  if (isMobile) {
    return (
      <Box sx={{ height: "100%", minHeight: 0 }}>
        {mobileView === "detail" && (selectedRun || selectedRunListItem)
          ? detailContent
          : listContent}
      </Box>
    );
  }

  return (
    <Box sx={{ height: "100%", minHeight: 0 }}>
      <PanelGroup direction="horizontal">
        {/* Run history list */}
        <Panel defaultSize={showSource ? 32 : 25} minSize={15}>
          <Box
            sx={{
              height: "100%",
              borderRight: "1px solid",
              borderColor: "divider",
            }}
          >
            {listContent}
          </Box>
        </Panel>
        <PanelResizeHandle
          style={{ width: 4, background: "var(--mui-palette-divider)" }}
        />
        {/* Run details */}
        <Panel defaultSize={showSource ? 68 : 75} minSize={30}>
          {detailContent}
        </Panel>
      </PanelGroup>
    </Box>
  );
}
