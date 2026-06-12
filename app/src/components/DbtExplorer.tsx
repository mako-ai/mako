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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  Button,
  Select,
  FormControl,
  InputLabel,
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
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useExplorerStore } from "../store/explorerStore";
import { useSchemaStore, type Connection } from "../store/schemaStore";
import {
  useDbtStore,
  type DbtJobItem,
  type DbtProjectItem,
} from "../store/dbtStore";
import { focusDbtFileTab, focusDbtJobTab } from "../dbt-runtime/shell";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import ExplorerShell from "./ExplorerShell";

// Node id encoding (flat ResourceTree ids stay unique and parseable):
// Project node: "<projectId>"
// Folder node:  "<projectId>::dir::<dirPath>"
// File node:    "<projectId>::file::<filePath>"
// Job node:     "<projectId>::job::<jobId>"
const FILE_SEP = "::file::";
const DIR_SEP = "::dir::";
const JOB_SEP = "::job::";
const JOBS_DIR = "__jobs";

const DBT_COMPATIBLE_TYPES = new Set([
  "postgresql",
  "cloudsql-postgres",
  "redshift",
  "bigquery",
  "clickhouse",
  "mysql",
  "mssql",
]);

function dirname(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

interface ParsedNode {
  kind: "project" | "dir" | "file" | "job";
  projectId: string;
  path: string;
}

function parseNodeId(id: string): ParsedNode {
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

export function DbtExplorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const projects = useDbtStore(s => s.projects);
  const projectsLoaded = useDbtStore(s => s.projectsLoaded);
  const filePathsByProject = useDbtStore(s => s.filePathsByProject);
  const jobsByProject = useDbtStore(s => s.jobsByProject);
  const loading = useDbtStore(s => !!s.loading.projects);
  const error = useDbtStore(s => s.error.projects ?? null);
  const fetchProjects = useDbtStore(s => s.fetchProjects);
  const fetchFiles = useDbtStore(s => s.fetchFiles);
  const fetchJobs = useDbtStore(s => s.fetchJobs);
  const createProject = useDbtStore(s => s.createProject);
  const deleteProject = useDbtStore(s => s.deleteProject);
  const createFile = useDbtStore(s => s.createFile);
  const deleteFile = useDbtStore(s => s.deleteFile);
  const renameFile = useDbtStore(s => s.renameFile);
  const deleteJob = useDbtStore(s => s.deleteJob);

  const connections = useSchemaStore(s => s.connections);
  const ensureConnections = useSchemaStore(s => s.ensureConnections);

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
    return null;
  }, [activeTab]);

  const expandedFolders = useExplorerStore(s => s.dbt.expandedFolders);
  const toggleDbtFolder = useExplorerStore(s => s.toggleDbtFolder);
  const expandDbtFolder = useExplorerStore(s => s.expandDbtFolder);

  const [loadingProjects, setLoadingProjects] = useState<
    Record<string, boolean>
  >({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createConnectionId, setCreateConnectionId] = useState("");
  const [createDevSchema, setCreateDevSchema] = useState("dbt_dev");
  const [createProdSchema, setCreateProdSchema] = useState("analytics");
  const [creating, setCreating] = useState(false);
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

  useEffect(() => {
    if (workspaceId) void fetchProjects(workspaceId);
  }, [workspaceId, fetchProjects]);

  useEffect(() => {
    if (createOpen && workspaceId) void ensureConnections(workspaceId);
  }, [createOpen, workspaceId, ensureConnections]);

  const dbtConnections: Connection[] = useMemo(() => {
    const all = workspaceId ? (connections[workspaceId] ?? []) : [];
    return all.filter(conn => DBT_COMPATIBLE_TYPES.has(conn.type));
  }, [workspaceId, connections]);

  const buildProjectNodes = useCallback(
    (items: DbtProjectItem[]): ResourceTreeNode[] =>
      items.map(project => {
        const paths = filePathsByProject[project._id];
        const jobs = jobsByProject[project._id];
        let children: ResourceTreeNode[] | undefined;
        if (paths) {
          children = buildFileNodes(project._id, paths);
          children.push({
            id: `${project._id}${DIR_SEP}${JOBS_DIR}`,
            name: "Jobs",
            path: JOBS_DIR,
            isDirectory: true,
            children: (jobs ?? []).map(job => ({
              id: `${project._id}${JOB_SEP}${job._id}`,
              name: `${job.name} (${scheduleSummary(job)})`,
              path: `job/${job._id}`,
              isDirectory: false,
            })),
          });
        }
        return {
          id: project._id,
          name: `${project.name} (${project.defaultEnvironment})`,
          path: project._id,
          isDirectory: true,
          children,
        };
      }),
    [filePathsByProject, jobsByProject],
  );

  const sections = useMemo(
    () => [
      {
        key: "projects",
        label: "Projects",
        icon: <ProjectIcon size={16} strokeWidth={1.5} />,
        nodes: buildProjectNodes(projects),
      },
    ],
    [projects, buildProjectNodes],
  );

  const handleRefresh = useCallback(() => {
    if (workspaceId) void fetchProjects(workspaceId);
  }, [workspaceId, fetchProjects]);

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
      }
    },
    [jobsByProject],
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
    [handleItemClick],
  );

  const handleCreateProject = useCallback(async () => {
    if (!workspaceId || !createName.trim() || !createConnectionId) return;
    setCreating(true);
    const created = await createProject(workspaceId, {
      name: createName.trim(),
      environments: [
        {
          name: "dev",
          connectionId: createConnectionId,
          targetSchema: createDevSchema.trim() || "dbt_dev",
          threads: 4,
        },
        {
          name: "prod",
          connectionId: createConnectionId,
          targetSchema: createProdSchema.trim() || "analytics",
          threads: 4,
        },
      ],
      defaultEnvironment: "dev",
    });
    setCreating(false);
    if (created) {
      setCreateOpen(false);
      setCreateName("");
      await Promise.all([
        fetchFiles(workspaceId, created._id),
        fetchJobs(workspaceId, created._id),
      ]);
      expandDbtFolder(created._id);
      focusDbtFileTab(created._id, "dbt_project.yml");
    }
  }, [
    workspaceId,
    createName,
    createConnectionId,
    createDevSchema,
    createProdSchema,
    createProject,
    fetchFiles,
    fetchJobs,
    expandDbtFolder,
  ]);

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

  const actions = (
    <>
      <Tooltip title="New dbt project">
        <IconButton size="small" onClick={() => setCreateOpen(true)}>
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
        searchPlaceholder="Search dbt projects..."
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
                onClick={() => setCreateOpen(true)}
              >
                New dbt project
              </Button>
            </Box>
          ) : (
            <ResourceTree
              sections={sections}
              mode="sidebar"
              searchQuery={searchQuery}
              activeItemId={activeItemId}
              getItemIcon={getItemIcon}
              getContextMenuItems={getContextMenuItems}
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
          )
        }
      </ExplorerShell>

      {/* New project dialog */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>New dbt project</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Project name"
            value={createName}
            onChange={e => setCreateName(e.target.value)}
            sx={{ mt: 1, mb: 2 }}
          />
          <FormControl fullWidth size="small" sx={{ mb: 2 }}>
            <InputLabel id="dbt-target-connection">
              Target connection
            </InputLabel>
            <Select
              labelId="dbt-target-connection"
              label="Target connection"
              value={createConnectionId}
              onChange={e => setCreateConnectionId(e.target.value)}
            >
              {dbtConnections.map(conn => (
                <MenuItem key={conn.id} value={conn.id}>
                  {conn.name} ({conn.type})
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {dbtConnections.length === 0 && (
            <Typography variant="caption" color="text.secondary">
              No dbt-compatible connections found. Add a Postgres, BigQuery,
              ClickHouse, MySQL, Redshift or SQL Server connection first.
            </Typography>
          )}
          <TextField
            fullWidth
            size="small"
            label="Dev schema"
            value={createDevSchema}
            onChange={e => setCreateDevSchema(e.target.value)}
            sx={{ mb: 2 }}
          />
          <TextField
            fullWidth
            size="small"
            label="Prod schema"
            value={createProdSchema}
            onChange={e => setCreateProdSchema(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            onClick={handleCreateProject}
            disabled={creating || !createName.trim() || !createConnectionId}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

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

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>Delete {deleteKindLabel}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete &quot;{deleteTarget?.name}&quot;?
            {deleteTarget?.parsed.kind === "project"
              ? " This deletes all files, jobs and run history."
              : ""}{" "}
            This action cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button onClick={handleDeleteConfirm} color="error">
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export default DbtExplorer;
