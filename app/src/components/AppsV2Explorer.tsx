import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  TextField,
  Tooltip,
} from "@mui/material";
import { Plus, RefreshCw } from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import ExplorerShell from "./ExplorerShell";
import ResourceTree, {
  type ResourceTreeNode,
  type ResourceTreeSection,
} from "./ResourceTree";
import {
  useAppV2Store,
  type AppV2Project,
  type AppV2TreeEntry,
} from "../store/appV2Store";
import { useConsoleStore } from "../store/consoleStore";
import { APP_V2_FILE_SEP, APP_V2_DIR_SEP } from "../lib/explorer-reveal";
import {
  selectRevealFor,
  useExplorerRevealStore,
} from "../store/explorerRevealStore";
import {
  focusAppV2FileTab,
  focusAppV2ProjectTab,
} from "../apps-v2-runtime/shell";
import {
  appV2ProjectIdFromFileNodeId,
  appV2ProjectIdFromRevealNodeId,
  buildAppV2FileNodes,
  prepareAppV2Reveal,
} from "../apps-v2-runtime/tree";
import { TAB_KIND_ICONS } from "../lib/entity-icons";
import { useAppV2Status } from "../hooks/useAppV2Status";

const EMPTY_PROJECTS: AppV2Project[] = [];
const AppV2ProjectIcon = TAB_KIND_ICONS["app-v2"];
const AppV2FileIcon = TAB_KIND_ICONS["app-v2-file"];

function nodeIcon(node: ResourceTreeNode) {
  if (node.entityType === "app-v2-project") {
    return <AppV2ProjectIcon size={16} strokeWidth={1.5} />;
  }
  return <AppV2FileIcon size={16} strokeWidth={1.5} />;
}

function projectNodes(
  projects: AppV2Project[],
  trees: Record<string, AppV2TreeEntry[]>,
): ResourceTreeNode[] {
  return projects.map(project => ({
    id: project.id,
    name: project.title,
    path: project.id,
    isDirectory: true,
    entityType: "app-v2-project",
    access: project.access,
    owner_id: project.ownerId,
    children: trees[project.id]
      ? buildAppV2FileNodes(project.id, trees[project.id])
      : undefined,
  }));
}

export default function AppsV2Explorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const { loaded: statusLoaded, storageDurability } = useAppV2Status();
  const projects = useAppV2Store(state =>
    workspaceId
      ? (state.projectsByWorkspace[workspaceId] ?? EMPTY_PROJECTS)
      : EMPTY_PROJECTS,
  );
  const trees = useAppV2Store(state => state.treesByProject);
  const loadingByKey = useAppV2Store(state => state.loadingByKey);
  const loading = useAppV2Store(state =>
    workspaceId ? Boolean(state.loadingByKey[`list:${workspaceId}`]) : false,
  );
  const error = useAppV2Store(state =>
    workspaceId ? state.errorsByKey[`list:${workspaceId}`] : null,
  );
  const listProjects = useAppV2Store(state => state.listProjects);
  const createProject = useAppV2Store(state => state.createProject);
  const getOrCreateWorktree = useAppV2Store(state => state.getOrCreateWorktree);
  const loadTree = useAppV2Store(state => state.loadTree);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [access, setAccess] = useState<"private" | "workspace">("private");
  const [creating, setCreating] = useState(false);
  const [preparedRevealNonce, setPreparedRevealNonce] = useState<number | null>(
    null,
  );
  const reveal = useExplorerRevealStore(selectRevealFor("apps-v2"));

  const activeTab = useConsoleStore(state =>
    state.activeTabId ? state.tabs[state.activeTabId] : undefined,
  );
  const activeItemId = useMemo(() => {
    if (activeTab?.kind === "app-v2") {
      return activeTab.metadata?.projectId as string;
    }
    if (activeTab?.kind === "app-v2-file") {
      return `${activeTab.metadata?.projectId}${APP_V2_FILE_SEP}${activeTab.metadata?.path}`;
    }
    return null;
  }, [activeTab]);

  useEffect(() => {
    if (workspaceId) void listProjects(workspaceId);
  }, [listProjects, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !reveal) return;
    const projectId = appV2ProjectIdFromRevealNodeId(reveal.nodeId);
    if (!projectId) return;
    let cancelled = false;
    setExpanded(current => new Set(current).add(projectId));
    void prepareAppV2Reveal(reveal.nodeId, {
      ensureProject: async id => {
        if (!useAppV2Store.getState().projectsById[id]) {
          await listProjects(workspaceId);
        }
      },
      getOrCreateWorktree: id => getOrCreateWorktree(workspaceId, id),
      loadTree: id => loadTree(workspaceId, id),
    }).then(preparedProjectId => {
      if (!cancelled && preparedProjectId) {
        setPreparedRevealNonce(reveal.nonce);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [getOrCreateWorktree, listProjects, loadTree, reveal, workspaceId]);

  const revealIsReady =
    !reveal ||
    appV2ProjectIdFromRevealNodeId(reveal.nodeId) === null ||
    preparedRevealNonce === reveal.nonce;

  const sections = useMemo<ResourceTreeSection[]>(() => {
    const privateProjects = projects.filter(
      project => project.access === "private",
    );
    const workspaceProjects = projects.filter(
      project => project.access === "workspace",
    );
    return [
      {
        key: "private",
        label: "Private",
        nodes: projectNodes(privateProjects, trees),
      },
      {
        key: "workspace",
        label: "Workspace",
        nodes: projectNodes(workspaceProjects, trees),
      },
    ];
  }, [projects, trees]);

  const handleLoadChildren = useCallback(
    async (node: ResourceTreeNode) => {
      if (!workspaceId || node.entityType !== "app-v2-project") return;
      const worktree = await getOrCreateWorktree(workspaceId, node.id);
      if (worktree) await loadTree(workspaceId, node.id);
    },
    [getOrCreateWorktree, loadTree, workspaceId],
  );

  const handleItemClick = useCallback((node: ResourceTreeNode) => {
    if (node.entityType === "app-v2-project") {
      focusAppV2ProjectTab(node.id, node.name);
      return;
    }
    if (node.id.includes(APP_V2_FILE_SEP)) {
      const projectId = appV2ProjectIdFromFileNodeId(node.id);
      if (projectId) focusAppV2FileTab(projectId, node.path);
    }
  }, []);

  const handleCreate = useCallback(async () => {
    if (!workspaceId || !title.trim()) return;
    setCreating(true);
    const project = await createProject(workspaceId, {
      title: title.trim(),
      access,
    });
    setCreating(false);
    if (!project) return;
    setDialogOpen(false);
    setTitle("");
    setAccess("private");
    focusAppV2ProjectTab(project.id, project.title);
  }, [access, createProject, title, workspaceId]);

  return (
    <>
      <ExplorerShell
        title="App Projects"
        loading={loading}
        error={error}
        actions={
          <>
            <Tooltip title="New App Project">
              <IconButton
                size="small"
                aria-label="New App Project"
                onClick={() => setDialogOpen(true)}
              >
                <Plus size={20} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Refresh App Projects">
              <IconButton
                size="small"
                aria-label="Refresh App Projects"
                onClick={() => {
                  if (workspaceId) void listProjects(workspaceId);
                }}
              >
                <RefreshCw size={18} />
              </IconButton>
            </Tooltip>
          </>
        }
      >
        {({ searchQuery }) => (
          <>
            {statusLoaded && storageDurability === "ephemeral" && (
              <Alert severity="warning">
                Testing storage: App Project Git data can disappear after a
                deploy, restart, or instance replacement.
              </Alert>
            )}
            <ResourceTree
              sections={sections}
              searchQuery={searchQuery}
              activeItemId={activeItemId}
              revealNodeId={revealIsReady ? reveal?.nodeId : undefined}
              revealNonce={revealIsReady ? reveal?.nonce : undefined}
              getItemIcon={nodeIcon}
              onLoadChildren={node => void handleLoadChildren(node)}
              isLoadingChildren={node =>
                Boolean(
                  loadingByKey[`tree:${node.id}`] ||
                    loadingByKey[`worktree:${node.id}`],
                )
              }
              onItemClick={handleItemClick}
              shouldFolderClickActivate={node =>
                node.entityType === "app-v2-project"
              }
              isFolderExpanded={key => expanded.has(key)}
              onToggleFolder={key =>
                setExpanded(current => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
              onExpandFolder={key =>
                setExpanded(current => new Set(current).add(key))
              }
              getFolderExpansionKey={node =>
                node.entityType === "app-v2-project"
                  ? node.id
                  : node.id.includes(APP_V2_DIR_SEP)
                    ? node.id
                    : node.path
              }
              enableDragDrop={false}
              enableRename={false}
              enableDelete={false}
              enableNewFolder={false}
            />
          </>
        )}
      </ExplorerShell>

      <Dialog
        open={dialogOpen}
        onClose={() => {
          if (!creating) setDialogOpen(false);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>New App Project</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="Project name"
            value={title}
            onChange={event => setTitle(event.target.value)}
            sx={{ mt: 1 }}
          />
          <TextField
            select
            fullWidth
            label="Visibility"
            value={access}
            onChange={event =>
              setAccess(event.target.value as "private" | "workspace")
            }
            sx={{ mt: 2 }}
          >
            <MenuItem value="private">Private</MenuItem>
            <MenuItem value="workspace">Workspace</MenuItem>
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={creating}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleCreate()}
            disabled={creating || !title.trim()}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
