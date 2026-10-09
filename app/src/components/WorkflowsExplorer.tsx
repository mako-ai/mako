/**
 * Workflows explorer: one tree, like Apps. A workflow is a row that opens its
 * runs; its chevron shows its files, which open read-only. Shared folders and
 * files under `workflows/` follow. When the last merge did not build, the
 * shell's error slot says so: the previous version stays live.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Box, Button, IconButton, Tooltip, Typography } from "@mui/material";
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  ExternalLink as DashboardIcon,
  FileCode as FileIcon,
  Folder as FolderIcon,
  Github as LinkIcon,
  RefreshCw as RefreshIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { EXPLORER_ICONS } from "../lib/entity-icons";
import { openSettingsSection } from "../lib/command-palette/commands";
import { useConsoleStore } from "../store/consoleStore";
import { useWorkflowsStore } from "../store/workflowsStore";
import ExplorerShell from "./ExplorerShell";
import { VersionChip } from "./WorkflowView";

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

function Empty({ children }: { children: string }) {
  return (
    <Typography
      variant="caption"
      sx={{ display: "block", px: 1.5, py: 0.5, color: "text.secondary" }}
    >
      {children}
    </Typography>
  );
}

function Prompt({
  text,
  action,
  icon,
  onClick,
}: {
  text: string;
  action: string;
  icon?: ReactNode;
  onClick: () => void;
}) {
  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="body2" color="text.secondary" gutterBottom>
        {text}
      </Typography>
      <Button
        variant="contained"
        size="small"
        startIcon={icon}
        sx={{ mt: 1 }}
        onClick={onClick}
      >
        {action}
      </Button>
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
  const enable = useWorkflowsStore(s => s.enable);

  const focusOrOpenTab = useConsoleStore(s => s.focusOrOpenTab);
  const activeMeta = useConsoleStore(s => {
    const tab = s.activeTabId ? s.tabs[s.activeTabId] : undefined;
    return tab?.kind === "workflow" ? tab.metadata : undefined;
  });

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

  // One row per folder under `workflows/` and per registered workflow, with
  // the folder's files. A workflow only on the previewed branch is marked.
  const tree = useMemo(() => {
    const live = new Set<string>();
    const registered = new Set<string>();
    for (const w of overview?.workflows ?? []) {
      registered.add(w.workflowId);
      if (!w.preview) live.add(w.workflowId);
    }
    const folders = new Map<string, string[]>();
    const rootFiles: string[] = [];
    for (const id of registered) folders.set(id, []);
    for (const path of [...(files ?? [])].sort()) {
      const slash = path.indexOf("/");
      if (slash < 0) rootFiles.push(path);
      else {
        const folder = path.slice(0, slash);
        folders.set(folder, [...(folders.get(folder) ?? []), path]);
      }
    }
    const rows = [...folders.entries()]
      .map(([name, paths]) => ({
        name,
        paths,
        isWorkflow:
          registered.has(name) || paths.includes(`${name}/workflow.ts`),
        previewOnly: registered.has(name) && !live.has(name),
      }))
      // Workflows first, then shared folders such as `lib`.
      .sort(
        (a, b) =>
          Number(b.isWorkflow) - Number(a.isWorkflow) ||
          a.name.localeCompare(b.name),
      );
    return { rows, rootFiles };
  }, [overview?.workflows, files]);

  const openTab = (metadata: Record<string, string>, title: string) =>
    focusOrOpenTab(
      { kind: "workflow", metadata },
      () => ({ title, content: "", kind: "workflow", metadata }),
      KEEP_OTHER_TABS,
    );
  const openWorkflow = (workflowId: string) =>
    openTab({ workflowId }, workflowId);
  const openFile = (path: string) =>
    openTab({ path }, path.split("/").pop() ?? path);

  const deployment = overview?.deployment;
  const buildError = deployment?.buildError
    ? `Build failed at ${short(deployment.targetSha)}. ${
        deployment.liveSha
          ? `Version ${short(deployment.liveSha)} stays live.`
          : "Nothing is live yet."
      }\n${deployment.buildError}`
    : null;

  const fileRow = (path: string, indent: number, label = path) => (
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
      <Box component="span">{label}</Box>
    </Box>
  );

  return (
    <ExplorerShell
      title="Workflows"
      error={buildError}
      loading={!overview}
      actions={
        <>
          {overview?.dashboardUrl && (
            <Tooltip title="Open the Hatchet dashboard">
              <IconButton
                size="small"
                component="a"
                href={overview.dashboardUrl}
                target="_blank"
                rel="noreferrer"
              >
                <DashboardIcon size={20} strokeWidth={2} />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Refresh">
            <IconButton size="small" onClick={refresh}>
              <RefreshIcon size={20} strokeWidth={2} />
            </IconButton>
          </Tooltip>
        </>
      }
    >
      {() =>
        overview?.enabled === false ? (
          // Only staff get this far: the rail hides Workflows until it is on.
          <Prompt
            text="Workflows are off for this workspace."
            action="Turn on workflows"
            onClick={() =>
              workspaceId && void enable(workspaceId).then(refresh)
            }
          />
        ) : overview?.repoLinked === false ? (
          <Prompt
            text="Workflows live in a GitHub repository. Link one to get started — each workflow is a folder in the repo, and merging to the default branch puts it live."
            action="Link a GitHub repo"
            icon={<LinkIcon size={16} />}
            onClick={() => openSettingsSection("github")}
          />
        ) : (
          <Box sx={{ py: 0.5 }}>
            {tree.rows.length + tree.rootFiles.length === 0 && (
              <Empty>No workflows yet.</Empty>
            )}
            {tree.rows.map(row => {
              const open = !!openFolders[row.name];
              const toggle = () =>
                setOpenFolders(f => ({ ...f, [row.name]: !open }));
              // A workflow opens its runs; a shared folder only unfolds.
              const activate = row.isWorkflow
                ? () => openWorkflow(row.name)
                : toggle;
              const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
              return (
                <Box key={row.name}>
                  <Box
                    role="button"
                    tabIndex={0}
                    onClick={activate}
                    onKeyDown={e => e.key === "Enter" && activate()}
                    sx={{
                      ...ROW_SX,
                      bgcolor:
                        row.isWorkflow && activeMeta?.workflowId === row.name
                          ? "action.selected"
                          : "transparent",
                    }}
                  >
                    <Chevron
                      size={14}
                      strokeWidth={2}
                      onClick={e => {
                        e.stopPropagation();
                        toggle();
                      }}
                    />
                    {row.isWorkflow ? (
                      <WorkflowIcon size={16} strokeWidth={1.5} />
                    ) : (
                      <FolderIcon size={16} strokeWidth={1.5} />
                    )}
                    <Box component="span">{row.name}</Box>
                    {row.previewOnly && <VersionChip preview small />}
                  </Box>
                  {open &&
                    row.paths.map(path =>
                      fileRow(path, 5.25, path.slice(row.name.length + 1)),
                    )}
                </Box>
              );
            })}
            {tree.rootFiles.map(path => fileRow(path, 3.75))}
          </Box>
        )
      }
    </ExplorerShell>
  );
}
