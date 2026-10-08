/**
 * Workflows explorer — the workspace's workflows, and the files under
 * `workflows/` (the same two-section shape as the Transforms explorer).
 *
 * A workflow opens its runs; a file opens read-only. Both are the one
 * `workflow` tab kind, told apart by `metadata.path`. When the last merge did
 * not build, the shell's error slot says so: the previous version stays live.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Chip,
  Divider,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  FileCode as FileIcon,
  RefreshCw as RefreshIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { EXPLORER_ICONS } from "../lib/entity-icons";
import { useConsoleStore } from "../store/consoleStore";
import { useWorkflowsStore } from "../store/workflowsStore";
import ExplorerShell from "./ExplorerShell";

const WorkflowIcon = EXPLORER_ICONS.workflows;
const POLL_INTERVAL_MS = 8_000;
// A workflow tab has no unsaved state, so the store sees it as replaceable;
// opening a file must not close the runs next to it.
const KEEP_OTHER_TABS = { replacePristine: false };

const ROW_SX = {
  display: "flex",
  alignItems: "center",
  gap: 0.75,
  px: 1.5,
  py: 0.5,
  cursor: "pointer",
  fontSize: 13,
  "&:hover": { bgcolor: "action.hover" },
} as const;

function SectionHeader({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.5,
        px: 1,
        py: 0.5,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      {open ? (
        <ChevronDownIcon size={14} strokeWidth={2} />
      ) : (
        <ChevronRightIcon size={14} strokeWidth={2} />
      )}
      <Typography
        variant="caption"
        sx={{
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: "text.secondary",
          fontSize: "0.68rem",
        }}
      >
        {label}
      </Typography>
    </Box>
  );
}

const short = (sha: string | null | undefined) => (sha ?? "").slice(0, 7);

export function WorkflowsExplorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const overview = useWorkflowsStore(s =>
    workspaceId ? s.overviewByWorkspace[workspaceId] : undefined,
  );
  const files = useWorkflowsStore(s =>
    workspaceId ? s.filesByWorkspace[workspaceId] : undefined,
  );
  const fetchOverview = useWorkflowsStore(s => s.fetchOverview);
  const fetchFiles = useWorkflowsStore(s => s.fetchFiles);

  const focusOrOpenTab = useConsoleStore(s => s.focusOrOpenTab);
  const activeMeta = useConsoleStore(s => {
    const tab = s.activeTabId ? s.tabs[s.activeTabId] : undefined;
    return tab?.kind === "workflow" ? tab.metadata : undefined;
  });

  const [workflowsOpen, setWorkflowsOpen] = useState(true);
  const [filesOpen, setFilesOpen] = useState(true);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    if (!workspaceId) return;
    void fetchOverview(workspaceId);
    void fetchFiles(workspaceId);
  }, [workspaceId, fetchOverview, fetchFiles]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // One row per workflow. A workflow that exists only on the previewed branch
  // is marked: it is not live yet.
  const workflows = useMemo(() => {
    const live = new Set<string>();
    const all = new Set<string>();
    for (const w of overview?.workflows ?? []) {
      all.add(w.workflowId);
      if (!w.preview) live.add(w.workflowId);
    }
    return [...all].sort().map(id => ({ id, previewOnly: !live.has(id) }));
  }, [overview?.workflows]);

  // `workflows/` is two levels deep: a folder per workflow, and shared files.
  const tree = useMemo(() => {
    const folders = new Map<string, string[]>();
    const rootFiles: string[] = [];
    for (const path of [...(files ?? [])].sort()) {
      const slash = path.indexOf("/");
      if (slash < 0) rootFiles.push(path);
      else {
        const folder = path.slice(0, slash);
        folders.set(folder, [...(folders.get(folder) ?? []), path]);
      }
    }
    return { folders: [...folders.entries()], rootFiles };
  }, [files]);

  const openWorkflow = (workflowId: string) =>
    focusOrOpenTab(
      { kind: "workflow", metadata: { workflowId } },
      () => ({
        title: workflowId,
        content: "",
        kind: "workflow",
        metadata: { workflowId },
      }),
      KEEP_OTHER_TABS,
    );

  const openFile = (path: string) =>
    focusOrOpenTab(
      { kind: "workflow", metadata: { path } },
      () => ({
        title: path.split("/").pop() ?? path,
        content: "",
        kind: "workflow",
        metadata: { path },
      }),
      KEEP_OTHER_TABS,
    );

  const deployment = overview?.deployment;
  const buildError = deployment?.buildError
    ? `Build failed at ${short(deployment.targetSha)}. ${
        deployment.liveSha
          ? `Version ${short(deployment.liveSha)} stays live.`
          : "Nothing is live yet."
      }\n${deployment.buildError}`
    : null;

  const fileRow = (path: string, indent: number) => (
    <Box
      key={path}
      role="button"
      tabIndex={0}
      onClick={() => openFile(path)}
      onKeyDown={e => e.key === "Enter" && openFile(path)}
      sx={{
        ...ROW_SX,
        pl: indent,
        bgcolor: activeMeta?.path === path ? "action.selected" : "transparent",
      }}
    >
      <FileIcon size={16} strokeWidth={1.5} />
      <Box component="span">{path.split("/").pop()}</Box>
    </Box>
  );

  return (
    <ExplorerShell
      title="Workflows"
      error={buildError}
      loading={!overview}
      actions={
        <Tooltip title="Refresh">
          <IconButton size="small" onClick={refresh}>
            <RefreshIcon size={20} strokeWidth={2} />
          </IconButton>
        </Tooltip>
      }
    >
      {() => (
        <Box sx={{ whiteSpace: "pre-wrap" }}>
          <SectionHeader
            label="Workflows"
            open={workflowsOpen}
            onToggle={() => setWorkflowsOpen(o => !o)}
          />
          {workflowsOpen && (
            <Box sx={{ pb: 1 }}>
              {workflows.length === 0 ? (
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    px: 1.5,
                    py: 0.5,
                    color: "text.secondary",
                  }}
                >
                  No workflows yet.
                </Typography>
              ) : (
                workflows.map(w => (
                  <Box
                    key={w.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openWorkflow(w.id)}
                    onKeyDown={e => e.key === "Enter" && openWorkflow(w.id)}
                    sx={{
                      ...ROW_SX,
                      bgcolor:
                        activeMeta?.workflowId === w.id
                          ? "action.selected"
                          : "transparent",
                    }}
                  >
                    <WorkflowIcon size={16} strokeWidth={1.5} />
                    <Box component="span">{w.id}</Box>
                    {w.previewOnly && (
                      <Chip
                        label="preview"
                        size="small"
                        variant="outlined"
                        color="info"
                        sx={{
                          height: 16,
                          fontSize: "0.62rem",
                          "& .MuiChip-label": { px: 0.5 },
                        }}
                      />
                    )}
                  </Box>
                ))
              )}
            </Box>
          )}

          <Divider />

          <SectionHeader
            label="Files"
            open={filesOpen}
            onToggle={() => setFilesOpen(o => !o)}
          />
          {filesOpen && (
            <Box sx={{ pb: 1 }}>
              {(files ?? []).length === 0 ? (
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    px: 1.5,
                    py: 0.5,
                    color: "text.secondary",
                  }}
                >
                  No files yet.
                </Typography>
              ) : (
                <>
                  {tree.folders.map(([folder, paths]) => {
                    const open = !!openFolders[folder];
                    return (
                      <Box key={folder}>
                        <Box
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setOpenFolders(f => ({ ...f, [folder]: !open }))
                          }
                          onKeyDown={e =>
                            e.key === "Enter" &&
                            setOpenFolders(f => ({ ...f, [folder]: !open }))
                          }
                          sx={ROW_SX}
                        >
                          {open ? (
                            <ChevronDownIcon size={14} strokeWidth={2} />
                          ) : (
                            <ChevronRightIcon size={14} strokeWidth={2} />
                          )}
                          <Box component="span">{folder}</Box>
                        </Box>
                        {open && paths.map(path => fileRow(path, 4.25))}
                      </Box>
                    );
                  })}
                  {tree.rootFiles.map(path => fileRow(path, 1.75))}
                </>
              )}
            </Box>
          )}
        </Box>
      )}
    </ExplorerShell>
  );
}
