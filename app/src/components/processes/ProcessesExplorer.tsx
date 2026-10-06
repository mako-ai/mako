/**
 * The Processes explorer: the approval inbox, then every process with the
 * state of its last run and its success rate. A flat list — processes are
 * code (api/src/processes/library), so there are no folders to manage here.
 */
import { useEffect, useMemo } from "react";
import { Badge, Box, IconButton, Tooltip, Typography } from "@mui/material";
import { Inbox, RotateCw as RefreshIcon, Workflow } from "lucide-react";
import ExplorerShell from "../ExplorerShell";
import { useWorkspace } from "../../contexts/workspace-context";
import { useConsoleStore } from "../../store/consoleStore";
import { useProcessStore, type ProcessSummary } from "../../store/processStore";
import {
  focusProcessInboxTab,
  focusProcessTab,
} from "../../process-runtime/shell";
import { timeAgo, waitingLabel } from "../../process-runtime/format";

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "success.main";
    case "failed":
      return "error.main";
    case "waiting":
      return "warning.main";
    case "running":
      return "info.main";
    default:
      return "text.secondary";
  }
}

const POLL_MS = 15_000;
const EMPTY: ProcessSummary[] = [];

function Row({
  active,
  onClick,
  icon,
  title,
  subtitle,
  trailing,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => {
        if (e.key === "Enter") onClick();
      }}
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: 1,
        px: 1.5,
        py: 0.75,
        cursor: "pointer",
        bgcolor: active ? "action.selected" : "transparent",
        "&:hover": { bgcolor: active ? "action.selected" : "action.hover" },
      }}
    >
      <Box sx={{ mt: 0.25, color: "text.secondary", display: "flex" }}>
        {icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
          {title}
        </Typography>
        {subtitle && (
          <Typography
            variant="caption"
            color="text.secondary"
            component="div"
            noWrap
          >
            {subtitle}
          </Typography>
        )}
      </Box>
      {trailing}
    </Box>
  );
}

export default function ProcessesExplorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const processes = useProcessStore(s =>
    workspaceId ? (s.processes[workspaceId] ?? EMPTY) : EMPTY,
  );
  const pending = useProcessStore(s =>
    workspaceId ? (s.pendingCount[workspaceId] ?? 0) : 0,
  );
  const loading = useProcessStore(s =>
    workspaceId ? Boolean(s.loading[`list:${workspaceId}`]) : false,
  );
  const error = useProcessStore(s => s.error);
  const fetchProcesses = useProcessStore(s => s.fetchProcesses);
  const clearError = useProcessStore(s => s.clearError);

  const activeTab = useConsoleStore(s =>
    s.activeTabId ? s.tabs[s.activeTabId] : undefined,
  );
  const activeProcessId =
    activeTab?.kind === "process" || activeTab?.kind === "process-run"
      ? (activeTab.metadata?.processId as string | undefined)
      : undefined;
  const inboxActive = activeTab?.kind === "process-inbox";

  useEffect(() => {
    if (!workspaceId) return;
    void fetchProcesses(workspaceId);
    const timer = setInterval(() => void fetchProcesses(workspaceId), POLL_MS);
    return () => clearInterval(timer);
  }, [workspaceId, fetchProcesses]);

  const sorted = useMemo(
    () => [...processes].sort((a, b) => a.name.localeCompare(b.name)),
    [processes],
  );

  return (
    <ExplorerShell
      title="Processes"
      searchPlaceholder="Filter processes"
      loading={loading && processes.length === 0}
      error={error}
      onErrorClose={clearError}
      actions={
        <Tooltip title="Refresh">
          <IconButton
            size="small"
            onClick={() => workspaceId && void fetchProcesses(workspaceId)}
          >
            <RefreshIcon size={16} />
          </IconButton>
        </Tooltip>
      }
    >
      {({ searchQuery }) => {
        const q = searchQuery.trim().toLowerCase();
        const visible = q
          ? sorted.filter(
              p =>
                p.name.toLowerCase().includes(q) ||
                p.id.includes(q) ||
                (p.category ?? "").includes(q),
            )
          : sorted;
        return (
          <Box sx={{ py: 0.5 }}>
            <Row
              active={inboxActive}
              onClick={() => focusProcessInboxTab()}
              icon={
                <Badge color="warning" badgeContent={pending} max={99}>
                  <Inbox size={16} />
                </Badge>
              }
              title="Inbox"
              subtitle={
                pending ? `${pending} waiting for you` : "No pending approvals"
              }
            />
            <Box sx={{ borderTop: 1, borderColor: "divider", my: 0.5 }} />
            {visible.map(p => (
              <Row
                key={p.id}
                active={activeProcessId === p.id}
                onClick={() => focusProcessTab(p.id, p.name)}
                icon={<Workflow size={16} />}
                title={p.name}
                subtitle={
                  <>
                    {p.lastRun && (
                      <Box
                        component="span"
                        sx={{ color: statusColor(p.lastRun.status) }}
                      >
                        {p.lastRun.status === "waiting"
                          ? waitingLabel(p.lastRun.waitingOn).toLowerCase()
                          : p.lastRun.status}
                        {" · "}
                      </Box>
                    )}
                    {p.lastRun
                      ? `#${p.lastRun.number} ${timeAgo(p.lastRun.createdAt)}`
                      : "No runs yet"}
                    {p.runs.successRate !== null &&
                      ` · ${Math.round(p.runs.successRate * 100)}% ok`}
                    {p.enabled ? "" : " · disabled"}
                  </>
                }
              />
            ))}
            {visible.length === 0 && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ px: 1.5 }}
              >
                No processes match.
              </Typography>
            )}
          </Box>
        );
      }}
    </ExplorerShell>
  );
}
