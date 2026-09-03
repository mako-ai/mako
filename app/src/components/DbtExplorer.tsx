/**
 * DbtExplorer — left-pane tree for dbt projects (pattern: AppsExplorer).
 *
 * Per project:
 *   Files — folder tree of dbt_files (click → dbt-file tab)
 *   Jobs  — one row per dbt job (click → dbt-job tab)
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  IconButton,
  Tooltip,
  Typography,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  Button,
  Menu,
  Chip,
  CircularProgress,
  Divider,
} from "@mui/material";
import {
  Plus as AddIcon,
  RefreshCw as RefreshIcon,
  GitBranch as ProjectIcon,
  FileCode as FileIcon,
  CalendarClock as JobIcon,
  Pencil as RenameIcon,
  Trash2 as DeleteIcon,
  ExternalLink as OpenIcon,
  FilePlus as NewFileIcon,
  Settings as EditProjectIcon,
  MoreVertical as KebabIcon,
  Terminal as ConsoleIcon,
  History as RunsIcon,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Check as CheckIcon,
  Box as ProjectBoxIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useExplorerStore } from "../store/explorerStore";
import { useDbtStore, type DbtJobItem } from "../store/dbtStore";
import {
  focusDbtConsoleTab,
  focusDbtFileTab,
  focusDbtJobTab,
  focusDbtRunsTab,
} from "../dbt-runtime/shell";
import { envBadgeColor } from "../lib/dbt-env";
import {
  useExplorerRevealStore,
  selectRevealFor,
} from "../store/explorerRevealStore";
import {
  DBT_FILE_SEP,
  DBT_DIR_SEP,
  DBT_JOB_SEP,
  DBT_RUNS_SEP,
} from "../lib/explorer-reveal";
import { ConfirmDialog } from "./ConfirmDialog";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import ExplorerShell from "./ExplorerShell";
import { dirname } from "../utils/path";

// Node id encoding (flat ResourceTree ids stay unique and parseable):
// Project node: "<projectId>"
// Folder node:  "<projectId>::dir::<dirPath>"
// File node:    "<projectId>::file::<filePath>"
// Job node:     "<projectId>::job::<jobId>"
// Separators are sourced from explorer-reveal.ts so reveal ids never drift
// from the ids this explorer builds (see 71-tab-entities rule).
const FILE_SEP = DBT_FILE_SEP;
const DIR_SEP = DBT_DIR_SEP;
const JOB_SEP = DBT_JOB_SEP;
const RUNS_SEP = DBT_RUNS_SEP;
const JOBS_DIR = "__jobs";

interface ParsedNode {
  kind: "project" | "dir" | "file" | "job" | "runs";
  projectId: string;
  path: string;
}

function parseNodeId(id: string): ParsedNode {
  if (id.includes(RUNS_SEP)) {
    const [projectId] = id.split(RUNS_SEP);
    return { kind: "runs", projectId, path: "" };
  }
  if (id.includes(JOB_SEP)) {
    const [projectId, path] = id.split(JOB_SEP);
    return { kind: "job", projectId, path };
  }
  if (id.includes(FILE_SEP)) {
    const [projectId, path] = id.split(FILE_SEP);
    return { kind: "file", projectId, path };
  }
  if (id.includes(DIR_SEP)) {
    const [projectId, path] = id.split(DIR_SEP);
    return { kind: "dir", projectId, path };
  }
  return { kind: "project", projectId: id, path: "" };
}

/** Build nested folder/file nodes for one project's file paths. */
function buildFileNodes(
  projectId: string,
  paths: string[],
): ResourceTreeNode[] {
  const root: ResourceTreeNode = {
    id: `${projectId}${DIR_SEP}`,
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };
  for (const filePath of paths) {
    // .gitkeep files exist only to materialize empty scaffold dirs.
    if (filePath.endsWith(".gitkeep")) {
      const dir = dirname(filePath);
      if (dir) {
        // Ensure the directory chain exists even with no visible files.
        const segments = dir.split("/").filter(Boolean);
        let cursor = root;
        segments.forEach((segment, index) => {
          const path = segments.slice(0, index + 1).join("/");
          const id = `${projectId}${DIR_SEP}${path}`;
          let child = cursor.children?.find(c => c.id === id);
          if (!child) {
            child = {
              id,
              name: segment,
              path,
              isDirectory: true,
              children: [],
            };
            cursor.children?.push(child);
          }
          cursor = child;
        });
      }
      continue;
    }
    const segments = filePath.split("/").filter(Boolean);
    let cursor = root;
    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      const path = segments.slice(0, index + 1).join("/");
      const id = isLeaf
        ? `${projectId}${FILE_SEP}${path}`
        : `${projectId}${DIR_SEP}${path}`;
      let child = cursor.children?.find(c => c.id === id);
      if (!child) {
        child = {
          id,
          name: segment,
          path,
          isDirectory: !isLeaf,
          children: isLeaf ? undefined : [],
        };
        cursor.children?.push(child);
      }
      cursor = child;
    });
  }
  const sort = (nodes: ResourceTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach(n => n.children && sort(n.children));
  };
  sort(root.children || []);
  return root.children || [];
}

function scheduleSummary(job: DbtJobItem): string {
  if (!job.schedule?.cron) return "manual";
  return `${job.schedule.cron} ${job.schedule.timezone ?? "UTC"}`;
}

/** Collapsible section header (dbt Studio "File explorer" / "Jobs & runs"). */
function SectionHeader({
  label,
  open,
  onToggle,
  actions,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.5,
        px: 1,
        py: 0.5,
        cursor: "pointer",
        userSelect: "none",
        "&:hover .dbt-section-actions": { opacity: 1 },
      }}
      onClick={onToggle}
    >
      {open ? (
        <ChevronDownIcon size={14} strokeWidth={2} />
      ) : (
        <ChevronRightIcon size={14} strokeWidth={2} />
      )}
      <Typography
        variant="caption"
        sx={{
          flex: 1,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: "text.secondary",
          fontSize: "0.68rem",
        }}
      >
        {label}
      </Typography>
      {actions && (
        <Box
          className="dbt-section-actions"
          sx={{
            display: "flex",
            gap: 0,
            opacity: 0,
            transition: "opacity .1s",
          }}
          onClick={e => e.stopPropagation()}
        >
          {actions}
        </Box>
      )}
    </Box>
  );
}

export function DbtExplorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const projects = useDbtStore(s => s.projects);
  const projectsLoaded = useDbtStore(s => s.projectsLoaded);
  const activeProjectId = useDbtStore(s => s.activeProjectId);
  const setActiveProject = useDbtStore(s => s.setActiveProject);
  const filePathsByProject = useDbtStore(s => s.filePathsByProject);
  const jobsByProject = useDbtStore(s => s.jobsByProject);
  const loading = useDbtStore(s => !!s.loading.projects);
  const error = useDbtStore(s => s.error.projects ?? null);
  const fetchProjects = useDbtStore(s => s.fetchProjects);
  const fetchFiles = useDbtStore(s => s.fetchFiles);
  const fetchJobs = useDbtStore(s => s.fetchJobs);
  const deleteProject = useDbtStore(s => s.deleteProject);
  const createFile = useDbtStore(s => s.createFile);
  const deleteFile = useDbtStore(s => s.deleteFile);
  const renameFile = useDbtStore(s => s.renameFile);
  const deleteJob = useDbtStore(s => s.deleteJob);
  const saveJob = useDbtStore(s => s.saveJob);
  const openProjectSettings = useDbtStore(s => s.openProjectSettings);
  const openCreateProject = useDbtStore(s => s.openCreateProject);

  const activeTabId = useConsoleStore(s => s.activeTabId);
  const tabs = useConsoleStore(s => s.tabs);
  const activeTab = activeTabId ? tabs[activeTabId] : undefined;
  const activeItemId = useMemo(() => {
    if (activeTab?.kind === "dbt-file") {
      return `${activeTab.metadata?.projectId}${FILE_SEP}${activeTab.metadata?.path}`;
    }
    if (activeTab?.kind === "dbt-job") {
      return `${activeTab.metadata?.projectId}${JOB_SEP}${activeTab.metadata?.jobId}`;
    }
    if (activeTab?.kind === "dbt-runs") {
      return `${activeTab.metadata?.projectId}${RUNS_SEP}`;
    }
    return null;
  }, [activeTab]);

  const reveal = useExplorerRevealStore(selectRevealFor("dbt"));

  const expandedFolders = useExplorerStore(s => s.dbt.expandedFolders);
  const toggleDbtFolder = useExplorerStore(s => s.toggleDbtFolder);
  const expandDbtFolder = useExplorerStore(s => s.expandDbtFolder);

  const [loadingProjects, setLoadingProjects] = useState<
    Record<string, boolean>
  >({});
  const [newFileTarget, setNewFileTarget] = useState<{
    projectId: string;
    dir: string;
  } | null>(null);
  const [newFileName, setNewFileName] = useState("");
  const [renameTarget, setRenameTarget] = useState<{
    parsed: ParsedNode;
    name: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{
    parsed: ParsedNode;
    name: string;
  } | null>(null);

  // Hover kebab menu (reuses getContextMenuItems for the same actions).
  const [kebabMenu, setKebabMenu] = useState<{
    anchorEl: HTMLElement;
    node: ResourceTreeNode;
  } | null>(null);

  // dbt Studio-style chrome: project switcher + collapsible sections + the
  // project actions overflow menu.
  const [projectMenuAnchor, setProjectMenuAnchor] =
    useState<HTMLElement | null>(null);
  const [projectActionsAnchor, setProjectActionsAnchor] =
    useState<HTMLElement | null>(null);
  const [filesOpen, setFilesOpen] = useState(true);
  const [orchOpen, setOrchOpen] = useState(true);

  const activeProject = useMemo(
    () => projects.find(p => p._id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  useEffect(() => {
    if (workspaceId) void fetchProjects(workspaceId);
  }, [workspaceId, fetchProjects]);

  // Eagerly load the active project's files + jobs (the explorer now shows one
  // project at a time rather than lazily expanding project roots).
  useEffect(() => {
    if (!workspaceId || !activeProjectId) return;
    if (!filePathsByProject[activeProjectId]) {
      void fetchFiles(workspaceId, activeProjectId);
    }
    if (!jobsByProject[activeProjectId]) {
      void fetchJobs(workspaceId, activeProjectId);
    }
  }, [
    workspaceId,
    activeProjectId,
    filePathsByProject,
    jobsByProject,
    fetchFiles,
    fetchJobs,
  ]);

  // File tree for the active project only (no project-root wrapper). Jobs and
  // Runs live in their own "Jobs & runs" section, not the file tree.
  const sections = useMemo(() => {
    if (!activeProject) return [];
    const projectId = activeProject._id;
    const paths = filePathsByProject[projectId];
    const nodes: ResourceTreeNode[] = paths
      ? buildFileNodes(projectId, paths)
      : [];
    return [{ key: "files", label: "Files", hideSectionHeader: true, nodes }];
  }, [activeProject, filePathsByProject]);

  const activeJobs = useMemo(
    () => (activeProjectId ? (jobsByProject[activeProjectId] ?? []) : []),
    [activeProjectId, jobsByProject],
  );
  const runsNodeId = activeProjectId ? `${activeProjectId}${RUNS_SEP}` : "";

  const handleRefresh = useCallback(() => {
    if (!workspaceId) return;
    void fetchProjects(workspaceId);
    // Refresh the active project's file tree so agent-added/removed files show.
    if (activeProjectId) void fetchFiles(workspaceId, activeProjectId);
  }, [workspaceId, activeProjectId, fetchProjects, fetchFiles]);

  const handleLoadChildren = useCallback(
    async (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (
        parsed.kind !== "project" ||
        !workspaceId ||
        filePathsByProject[parsed.projectId]
      ) {
        return;
      }
      setLoadingProjects(prev => ({ ...prev, [parsed.projectId]: true }));
      await Promise.all([
        fetchFiles(workspaceId, parsed.projectId),
        fetchJobs(workspaceId, parsed.projectId),
      ]);
      setLoadingProjects(prev => ({ ...prev, [parsed.projectId]: false }));
    },
    [workspaceId, filePathsByProject, fetchFiles, fetchJobs],
  );

  const handleItemClick = useCallback(
    (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      if (parsed.kind === "file") {
        focusDbtFileTab(parsed.projectId, parsed.path);
      } else if (parsed.kind === "job") {
        const job = (jobsByProject[parsed.projectId] ?? []).find(
          j => j._id === parsed.path,
        );
        focusDbtJobTab(parsed.projectId, parsed.path, job?.name ?? node.name);
      } else if (parsed.kind === "runs") {
        focusDbtRunsTab(parsed.projectId, "Runs");
      }
    },
    [jobsByProject],
  );

  const openProjectSettingsFromMenu = useCallback(
    (projectId: string) => {
      openProjectSettings(projectId);
    },
    [openProjectSettings],
  );

  const handleNewJob = useCallback(
    async (projectId: string) => {
      if (!workspaceId) return;
      const project = projects.find(p => p._id === projectId);
      if (!project) return;
      const created = await saveJob(workspaceId, projectId, {
        name: "New job",
        environment: project.defaultEnvironment,
        commands: ["build"],
        schedule: null,
        enabled: true,
        deferToProduction: false,
      });
      if (created) {
        focusDbtJobTab(projectId, created._id, created.name, true);
      }
    },
    [workspaceId, projects, saveJob],
  );

  const getItemIcon = useCallback((node: ResourceTreeNode) => {
    const parsed = parseNodeId(node.id);
    if (parsed.kind === "project") {
      return <ProjectIcon size={16} strokeWidth={1.5} />;
    }
    if (parsed.kind === "file") {
      return <FileIcon size={16} strokeWidth={1.5} />;
    }
    if (parsed.kind === "job") {
      return <JobIcon size={16} strokeWidth={1.5} />;
    }
    if (parsed.kind === "runs") {
      return <RunsIcon size={16} strokeWidth={1.5} />;
    }
    return undefined;
  }, []);

  const getContextMenuItems = useCallback(
    (node: ResourceTreeNode, helpers: { closeMenu: () => void }) => {
      const parsed = parseNodeId(node.id);
      const items = [];

      if (parsed.kind === "file" || parsed.kind === "job") {
        items.push(
          <MenuItem
            key="open"
            onClick={() => {
              handleItemClick(node);
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              <OpenIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            Open
          </MenuItem>,
        );
      }

      if (
        parsed.kind === "project" ||
        (parsed.kind === "dir" && parsed.path !== JOBS_DIR)
      ) {
        items.push(
          <MenuItem
            key="new-file"
            onClick={() => {
              setNewFileTarget({
                projectId: parsed.projectId,
                dir: parsed.kind === "dir" ? parsed.path : "",
              });
              setNewFileName("");
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              <NewFileIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            New file
          </MenuItem>,
        );
      }

      if (parsed.kind === "dir" && parsed.path === JOBS_DIR) {
        items.push(
          <MenuItem
            key="new-job"
            onClick={() => {
              void handleNewJob(parsed.projectId);
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              <JobIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            New job
          </MenuItem>,
        );
      }

      if (parsed.kind === "project") {
        const project = projects.find(p => p._id === parsed.projectId);
        items.push(
          <MenuItem
            key="open-console"
            onClick={() => {
              focusDbtConsoleTab(
                parsed.projectId,
                `${project?.name ?? "dbt"} console`,
              );
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              <ConsoleIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            Open console
          </MenuItem>,
          <MenuItem
            key="new-job"
            onClick={() => {
              void handleNewJob(parsed.projectId);
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              <JobIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            New job
          </MenuItem>,
        );
        items.push(
          <MenuItem
            key="edit-project"
            onClick={() => {
              openProjectSettingsFromMenu(parsed.projectId);
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              <EditProjectIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            Project settings
          </MenuItem>,
        );
      }

      if (parsed.kind === "file") {
        items.push(
          <MenuItem
            key="rename"
            onClick={() => {
              setRenameTarget({ parsed, name: node.name });
              setRenameValue(node.name);
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              <RenameIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            Rename
          </MenuItem>,
        );
      }

      if (
        parsed.kind === "file" ||
        parsed.kind === "job" ||
        parsed.kind === "project"
      ) {
        items.push(
          <MenuItem
            key="delete"
            onClick={() => {
              setDeleteTarget({ parsed, name: node.name });
              helpers.closeMenu();
            }}
          >
            <ListItemIcon>
              <DeleteIcon size={16} strokeWidth={1.5} />
            </ListItemIcon>
            Delete
          </MenuItem>,
        );
      }
      return items;
    },
    [handleItemClick, openProjectSettingsFromMenu, projects, handleNewJob],
  );

  // Hover kebab: same actions as the right-click menu, but discoverable.
  const getRightAdornment = useCallback((node: ResourceTreeNode) => {
    const parsed = parseNodeId(node.id);
    // The Jobs folder gets a kebab (→ "New job"); other dirs/runs do not.
    if (parsed.kind === "runs") return null;
    if (parsed.kind === "dir" && parsed.path !== JOBS_DIR) return null;

    if (parsed.kind === "file") return null;

    return (
      <IconButton
        size="small"
        aria-label="Actions"
        className="dbt-row-kebab"
        onClick={event => {
          event.stopPropagation();
          setKebabMenu({ anchorEl: event.currentTarget, node });
        }}
        sx={{
          p: 0.25,
          opacity: 0,
          transition: "opacity 0.1s",
          ".MuiListItemButton-root:hover &": { opacity: 1 },
          "&:focus-visible, &[aria-expanded='true']": { opacity: 1 },
        }}
      >
        <KebabIcon size={15} strokeWidth={1.5} />
      </IconButton>
    );
  }, []);

  const handleNewFileConfirm = useCallback(async () => {
    if (!workspaceId || !newFileTarget) return;
    const name = newFileName.trim();
    if (!name) return;
    const path = newFileTarget.dir ? `${newFileTarget.dir}/${name}` : name;
    const ok = await createFile(workspaceId, newFileTarget.projectId, path);
    if (ok) focusDbtFileTab(newFileTarget.projectId, path);
    setNewFileTarget(null);
  }, [workspaceId, newFileTarget, newFileName, createFile]);

  const handleRenameConfirm = useCallback(async () => {
    if (!renameTarget || !workspaceId) return;
    const next = renameValue.trim();
    const { parsed } = renameTarget;
    if (next && next !== renameTarget.name && parsed.kind === "file") {
      const dir = dirname(parsed.path);
      const newPath = dir ? `${dir}/${next}` : next;
      await renameFile(workspaceId, parsed.projectId, parsed.path, newPath);
    }
    setRenameTarget(null);
  }, [renameTarget, renameValue, workspaceId, renameFile]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget || !workspaceId) return;
    const { parsed } = deleteTarget;
    if (parsed.kind === "project") {
      await deleteProject(workspaceId, parsed.projectId);
    } else if (parsed.kind === "file") {
      await deleteFile(workspaceId, parsed.projectId, parsed.path);
    } else if (parsed.kind === "job") {
      await deleteJob(workspaceId, parsed.projectId, parsed.path);
    }
    setDeleteTarget(null);
  }, [deleteTarget, workspaceId, deleteProject, deleteFile, deleteJob]);

  // Project-level actions (the kebab next to the project switcher).
  const projectMenuItems = useCallback(
    (projectId: string, close: () => void) => {
      const project = projects.find(p => p._id === projectId);
      return [
        <MenuItem
          key="open-console"
          onClick={() => {
            focusDbtConsoleTab(projectId, `${project?.name ?? "dbt"} console`);
            close();
          }}
        >
          <ListItemIcon>
            <ConsoleIcon size={16} strokeWidth={1.5} />
          </ListItemIcon>
          Open console
        </MenuItem>,
        <MenuItem
          key="runs"
          onClick={() => {
            focusDbtRunsTab(projectId, "Runs");
            close();
          }}
        >
          <ListItemIcon>
            <RunsIcon size={16} strokeWidth={1.5} />
          </ListItemIcon>
          Run history
        </MenuItem>,
        <MenuItem
          key="new-job"
          onClick={() => {
            void handleNewJob(projectId);
            close();
          }}
        >
          <ListItemIcon>
            <JobIcon size={16} strokeWidth={1.5} />
          </ListItemIcon>
          New job
        </MenuItem>,
        <Divider key="div" />,
        <MenuItem
          key="settings"
          onClick={() => {
            openProjectSettingsFromMenu(projectId);
            close();
          }}
        >
          <ListItemIcon>
            <EditProjectIcon size={16} strokeWidth={1.5} />
          </ListItemIcon>
          Project settings
        </MenuItem>,
        <MenuItem
          key="delete"
          onClick={() => {
            setDeleteTarget({
              parsed: { kind: "project", projectId, path: "" },
              name: project?.name ?? "project",
            });
            close();
          }}
        >
          <ListItemIcon>
            <DeleteIcon size={16} strokeWidth={1.5} />
          </ListItemIcon>
          Delete project
        </MenuItem>,
      ];
    },
    [projects, handleNewJob, openProjectSettingsFromMenu],
  );

  const projectSelector = (
    <Box sx={{ display: "flex", alignItems: "center", minWidth: 0 }}>
      <Button
        onClick={e => setProjectMenuAnchor(e.currentTarget)}
        endIcon={<ChevronDownIcon size={15} strokeWidth={2} />}
        sx={{
          minWidth: 0,
          textTransform: "none",
          color: "text.primary",
          px: 0.75,
          py: 0.25,
          fontSize: "0.95rem",
          fontWeight: 600,
        }}
        startIcon={<ProjectBoxIcon size={16} strokeWidth={1.75} />}
      >
        <Box
          component="span"
          sx={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {activeProject?.name ?? "Select project"}
        </Box>
      </Button>
    </Box>
  );

  const actions = (
    <>
      <Tooltip title="New dbt project">
        <IconButton size="small" onClick={() => openCreateProject()}>
          <AddIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Refresh">
        <IconButton size="small" onClick={handleRefresh} disabled={loading}>
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  // Project switcher row, rendered just below the "Transforms" title.
  const projectSelectorRow = activeProject ? (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.5,
        px: 1,
        py: 0.5,
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      {projectSelector}
      <Box sx={{ flex: 1 }} />
      <Tooltip title="Project actions">
        <IconButton
          size="small"
          onClick={e => setProjectActionsAnchor(e.currentTarget)}
        >
          <KebabIcon size={16} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </Box>
  ) : null;

  const deleteKindLabel =
    deleteTarget?.parsed.kind === "project"
      ? "Project"
      : deleteTarget?.parsed.kind === "job"
        ? "Job"
        : "File";

  return (
    <>
      <ExplorerShell
        title="Transforms"
        actions={actions}
        searchPlaceholder="Search files..."
        error={error}
        onErrorClose={() => {
          useDbtStore.setState(state => {
            state.error.projects = null;
          });
        }}
        loading={loading && !projectsLoaded}
        skeleton={
          <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
            <Typography variant="body2">Loading...</Typography>
          </Box>
        }
      >
        {({ searchQuery }) =>
          projects.length === 0 && projectsLoaded ? (
            <Box sx={{ p: 3, textAlign: "center", color: "text.secondary" }}>
              <Typography variant="body2" sx={{ mb: 1 }}>
                No dbt projects yet.
              </Typography>
              <Button
                size="small"
                variant="outlined"
                onClick={() => openCreateProject()}
              >
                New dbt project
              </Button>
            </Box>
          ) : !activeProject ? null : (
            <Box sx={{ display: "flex", flexDirection: "column" }}>
              {projectSelectorRow}
              {/* File explorer */}
              <SectionHeader
                label="File explorer"
                open={filesOpen}
                onToggle={() => setFilesOpen(o => !o)}
                actions={
                  <Tooltip title="New file">
                    <IconButton
                      size="small"
                      onClick={() => {
                        setNewFileTarget({
                          projectId: activeProject._id,
                          dir: "",
                        });
                        setNewFileName("");
                      }}
                    >
                      <NewFileIcon size={15} strokeWidth={1.75} />
                    </IconButton>
                  </Tooltip>
                }
              />
              {filesOpen &&
                (sections[0]?.nodes.length ||
                filePathsByProject[activeProject._id] ? (
                  <ResourceTree
                    sections={sections}
                    mode="sidebar"
                    searchQuery={searchQuery}
                    activeItemId={activeItemId}
                    revealNodeId={reveal?.nodeId}
                    revealNonce={reveal?.nonce}
                    getItemIcon={getItemIcon}
                    getContextMenuItems={getContextMenuItems}
                    getRightAdornment={getRightAdornment}
                    hideFolderIcon
                    onItemClick={handleItemClick}
                    onLoadChildren={handleLoadChildren}
                    isLoadingChildren={node => {
                      const parsed = parseNodeId(node.id);
                      return (
                        parsed.kind === "project" &&
                        !!loadingProjects[parsed.projectId]
                      );
                    }}
                    enableDragDrop={false}
                    enableRename={false}
                    enableDelete={false}
                    enableNewFolder={false}
                    isFolderExpanded={key => !!expandedFolders[key]}
                    onToggleFolder={toggleDbtFolder}
                    onExpandFolder={expandDbtFolder}
                    getFolderExpansionKey={node => node.id}
                  />
                ) : (
                  <Box sx={{ px: 2, py: 2, color: "text.secondary" }}>
                    <CircularProgress size={16} />
                  </Box>
                ))}

              <Divider />

              {/* Jobs & runs (orchestration) */}
              <SectionHeader
                label="Jobs & runs"
                open={orchOpen}
                onToggle={() => setOrchOpen(o => !o)}
                actions={
                  <Tooltip title="New job">
                    <IconButton
                      size="small"
                      onClick={() => void handleNewJob(activeProject._id)}
                    >
                      <AddIcon size={15} strokeWidth={2} />
                    </IconButton>
                  </Tooltip>
                }
              />
              {orchOpen && (
                <Box sx={{ pb: 1 }}>
                  {/* Run history */}
                  <Box
                    role="button"
                    tabIndex={0}
                    onClick={() => focusDbtRunsTab(activeProject._id, "Runs")}
                    onKeyDown={e => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        focusDbtRunsTab(activeProject._id, "Runs");
                      }
                    }}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 0.75,
                      px: 1.5,
                      py: 0.5,
                      cursor: "pointer",
                      fontSize: 13,
                      bgcolor:
                        activeItemId === runsNodeId
                          ? "action.selected"
                          : "transparent",
                      "&:hover": { bgcolor: "action.hover" },
                    }}
                  >
                    <RunsIcon size={16} strokeWidth={1.5} />
                    <Box component="span">Run history</Box>
                  </Box>

                  {/* Jobs */}
                  {activeJobs.length === 0 ? (
                    <Typography
                      variant="caption"
                      sx={{
                        display: "block",
                        px: 1.5,
                        py: 0.5,
                        color: "text.secondary",
                      }}
                    >
                      No jobs yet.
                    </Typography>
                  ) : (
                    activeJobs.map(job => {
                      const jobNodeId = `${activeProject._id}${JOB_SEP}${job._id}`;
                      const jobNode: ResourceTreeNode = {
                        id: jobNodeId,
                        name: job.name,
                        path: `job/${job._id}`,
                        isDirectory: false,
                      };
                      return (
                        <Box
                          key={job._id}
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            focusDbtJobTab(activeProject._id, job._id, job.name)
                          }
                          onKeyDown={e => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              focusDbtJobTab(
                                activeProject._id,
                                job._id,
                                job.name,
                              );
                            }
                          }}
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            gap: 0.75,
                            px: 1.5,
                            py: 0.5,
                            cursor: "pointer",
                            fontSize: 13,
                            bgcolor:
                              activeItemId === jobNodeId
                                ? "action.selected"
                                : "transparent",
                            "&:hover": {
                              bgcolor: "action.hover",
                              ".dbt-job-kebab": { opacity: 1 },
                            },
                          }}
                        >
                          <JobIcon size={16} strokeWidth={1.5} />
                          <Box
                            sx={{
                              flex: 1,
                              minWidth: 0,
                              overflow: "hidden",
                            }}
                          >
                            <Box
                              component="span"
                              sx={{
                                display: "block",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {job.name || job.slug || job._id}
                            </Box>
                            <Box
                              component="span"
                              sx={{
                                display: "block",
                                fontSize: 11,
                                color: "text.secondary",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {scheduleSummary(job)}
                            </Box>
                          </Box>
                          {job.definitionInvalid && (
                            <Tooltip
                              title={`Job file is invalid (${job.definitionInvalid.reason}). Fix ${job.definitionInvalid.path} in git.`}
                            >
                              <Chip
                                label="invalid"
                                size="small"
                                variant="outlined"
                                color="warning"
                                sx={{
                                  flexShrink: 0,
                                  height: 18,
                                  fontSize: 10,
                                  fontWeight: 600,
                                  textTransform: "uppercase",
                                  "& .MuiChip-label": { px: 0.625 },
                                }}
                              />
                            </Tooltip>
                          )}
                          {job.environment && (
                            <Tooltip title={`Environment: ${job.environment}`}>
                              <Chip
                                label={job.environment}
                                size="small"
                                variant="outlined"
                                color={envBadgeColor(
                                  job.environment,
                                  activeProject.defaultEnvironment,
                                )}
                                sx={{
                                  flexShrink: 0,
                                  height: 18,
                                  maxWidth: 90,
                                  fontSize: 10,
                                  fontWeight: 600,
                                  textTransform: "uppercase",
                                  "& .MuiChip-label": { px: 0.625 },
                                }}
                              />
                            </Tooltip>
                          )}
                          <IconButton
                            size="small"
                            aria-label="Job actions"
                            className="dbt-job-kebab"
                            onClick={e => {
                              e.stopPropagation();
                              setKebabMenu({
                                anchorEl: e.currentTarget,
                                node: jobNode,
                              });
                            }}
                            sx={{
                              p: 0.25,
                              opacity: 0,
                              transition: "opacity 0.1s",
                            }}
                          >
                            <KebabIcon size={15} strokeWidth={1.5} />
                          </IconButton>
                        </Box>
                      );
                    })
                  )}
                </Box>
              )}
            </Box>
          )
        }
      </ExplorerShell>

      {/* Project switcher menu */}
      <Menu
        open={!!projectMenuAnchor}
        anchorEl={projectMenuAnchor}
        onClose={() => setProjectMenuAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{ paper: { sx: { minWidth: 240 } } }}
      >
        {projects.map(project => (
          <MenuItem
            key={project._id}
            selected={project._id === activeProjectId}
            onClick={() => {
              setActiveProject(project._id);
              setProjectMenuAnchor(null);
            }}
          >
            <ListItemIcon>
              {project._id === activeProjectId ? (
                <CheckIcon size={16} strokeWidth={2} />
              ) : (
                <ProjectIcon size={16} strokeWidth={1.5} />
              )}
            </ListItemIcon>
            <ListItemText
              primary={project.name}
              secondary={project.defaultEnvironment}
            />
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          onClick={() => {
            openCreateProject();
            setProjectMenuAnchor(null);
          }}
        >
          <ListItemIcon>
            <AddIcon size={16} strokeWidth={2} />
          </ListItemIcon>
          New dbt project
        </MenuItem>
      </Menu>

      {/* Project actions menu */}
      <Menu
        open={!!projectActionsAnchor}
        anchorEl={projectActionsAnchor}
        onClose={() => setProjectActionsAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {activeProjectId
          ? projectMenuItems(activeProjectId, () =>
              setProjectActionsAnchor(null),
            )
          : null}
      </Menu>

      {/* New file dialog */}
      <Dialog
        open={!!newFileTarget}
        onClose={() => setNewFileTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>New file</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 1 }}>
            {newFileTarget?.dir
              ? `In ${newFileTarget.dir}/`
              : "In project root"}
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            size="small"
            placeholder="stg_orders.sql"
            value={newFileName}
            onChange={e => setNewFileName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") void handleNewFileConfirm();
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewFileTarget(null)}>Cancel</Button>
          <Button onClick={handleNewFileConfirm}>Create</Button>
        </DialogActions>
      </Dialog>

      {/* Rename dialog */}
      <Dialog
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Rename file</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") void handleRenameConfirm();
            }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenameTarget(null)}>Cancel</Button>
          <Button onClick={handleRenameConfirm}>Rename</Button>
        </DialogActions>
      </Dialog>

      {/* Hover kebab menu — reuses the right-click action items */}
      <Menu
        open={!!kebabMenu}
        anchorEl={kebabMenu?.anchorEl ?? null}
        onClose={() => setKebabMenu(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {kebabMenu
          ? getContextMenuItems(kebabMenu.node, {
              closeMenu: () => setKebabMenu(null),
            })
          : null}
      </Menu>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={`Delete ${deleteKindLabel}`}
        body={`Are you sure you want to delete "${deleteTarget?.name}"?${
          deleteTarget?.parsed.kind === "project"
            ? " This deletes all files, jobs and run history."
            : ""
        } This action cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

export default DbtExplorer;
