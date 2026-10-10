/**
 * Workflows explorer: the same tree component as Apps. A workflow is a row
 * that opens its runs; its caret shows its files, which open read-only.
 * Shared folders and files under `workflows/` follow. When the last merge did
 * not build, the shell's error slot says so: the previous version stays live.
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
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import { VersionChip } from "./WorkflowView";

const WorkflowIcon = EXPLORER_ICONS.workflows;
const POLL_INTERVAL_MS = 8_000;
// A workflow tab has no unsaved state, so the store sees it as replaceable;
// opening a file must not close the runs next to it.
const KEEP_OTHER_TABS = { replacePristine: false };

/** A tree node: a workflow, a shared folder, or a file. */
interface Node extends ResourceTreeNode {
  workflow?: { previewOnly: boolean };
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

// Stable props for the tree: a new function each render would restart its
// effects. The read-only tree manages nothing.
const getItemIcon = (node: ResourceTreeNode) =>
  (node as Node).workflow ? (
    <WorkflowIcon size={16} strokeWidth={1.5} />
  ) : node.isDirectory ? (
    <FolderIcon size={16} strokeWidth={1.5} />
  ) : (
    <FileIcon size={16} strokeWidth={1.5} />
  );
const getRightAdornment = (node: ResourceTreeNode) =>
  (node as Node).workflow?.previewOnly ? <VersionChip preview small /> : null;
const isWorkflow = (node: ResourceTreeNode) => Boolean((node as Node).workflow);
const nodeId = (node: ResourceTreeNode) => node.id;
const never = () => false;

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
  const activeItemId = useConsoleStore(s => {
    const tab = s.activeTabId ? s.tabs[s.activeTabId] : undefined;
    if (tab?.kind !== "workflow") return null;
    const { workflowId, path } = tab.metadata ?? {};
    return workflowId ? `workflow:${workflowId}` : path ? `file:${path}` : null;
  });

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isFolderExpanded = useCallback(
    (key: string) => expanded[key] ?? false,
    [expanded],
  );
  const onToggleFolder = useCallback(
    (key: string) => setExpanded(prev => ({ ...prev, [key]: !prev[key] })),
    [],
  );
  const onExpandFolder = useCallback(
    (key: string) => setExpanded(prev => ({ ...prev, [key]: true })),
    [],
  );

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

  // One node per folder under `workflows/` and per registered workflow, with
  // the folder's files under it; workflows first, then shared folders such as
  // `lib`, then shared files. A workflow only on the previewed branch is marked.
  const nodes = useMemo((): Node[] => {
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
    const file = (path: string, name = path): Node => ({
      id: `file:${path}`,
      name,
      path,
      isDirectory: false,
    });
    return [
      ...[...folders.entries()]
        .map(([name, paths]): Node => {
          const isWorkflow =
            registered.has(name) || paths.includes(`${name}/workflow.ts`);
          return {
            id: `${isWorkflow ? "workflow" : "folder"}:${name}`,
            name,
            path: name,
            isDirectory: true,
            workflow: isWorkflow
              ? { previewOnly: registered.has(name) && !live.has(name) }
              : undefined,
            children: paths.map(p => file(p, p.slice(name.length + 1))),
          };
        })
        .sort(
          (a, b) =>
            Number(!!b.workflow) - Number(!!a.workflow) ||
            a.name.localeCompare(b.name),
        ),
      ...rootFiles.map(p => file(p)),
    ];
  }, [overview?.workflows, files]);

  const sections = useMemo(
    () => [
      { key: "workflows", label: "Workflows", nodes, hideSectionHeader: true },
    ],
    [nodes],
  );

  // A workflow opens its runs; a file opens read-only; a shared folder only
  // unfolds (the tree handles that click itself).
  const onItemClick = useCallback(
    (node: ResourceTreeNode) => {
      const { workflow } = node as Node;
      const metadata = workflow
        ? { workflowId: node.name }
        : node.isDirectory
          ? null
          : { path: node.path };
      if (!metadata) return;
      focusOrOpenTab(
        { kind: "workflow", metadata },
        () => ({ title: node.name, content: "", kind: "workflow", metadata }),
        KEEP_OTHER_TABS,
      );
    },
    [focusOrOpenTab],
  );

  const deployment = overview?.deployment;
  const buildError = deployment?.buildError
    ? `Build failed at ${short(deployment.targetSha)}. ${
        deployment.liveSha
          ? `Version ${short(deployment.liveSha)} stays live.`
          : "Nothing is live yet."
      }\n${deployment.buildError}`
    : null;

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
      {({ searchQuery }) =>
        overview?.repoLinked === false ? (
          <Prompt
            text="Workflows live in a GitHub repository. Link one to get started — each workflow is a folder in the repo, and merging to the default branch puts it live."
            action="Link a GitHub repo"
            icon={<LinkIcon size={16} />}
            onClick={() => openSettingsSection("github")}
          />
        ) : nodes.length === 0 ? (
          <Typography
            variant="caption"
            sx={{ display: "block", px: 1.5, py: 1, color: "text.secondary" }}
          >
            No workflows yet.
          </Typography>
        ) : (
          <ResourceTree
            sections={sections}
            mode="sidebar"
            searchQuery={searchQuery}
            activeItemId={activeItemId}
            getItemIcon={getItemIcon}
            getRightAdornment={getRightAdornment}
            onItemClick={onItemClick}
            shouldFolderClickActivate={isWorkflow}
            isFolderExpanded={isFolderExpanded}
            onToggleFolder={onToggleFolder}
            onExpandFolder={onExpandFolder}
            getFolderExpansionKey={nodeId}
            canManageItem={never}
            enableDragDrop={false}
            enableRename={false}
            enableDelete={false}
            enableMove={false}
            enableInfo={false}
            enableNewFolder={false}
          />
        )
      }
    </ExplorerShell>
  );
}
