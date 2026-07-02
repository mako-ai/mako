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
  Select,
  FormControl,
  InputLabel,
  Menu,
  Chip,
  CircularProgress,
  Divider,
  Link,
  Snackbar,
  Alert,
  useTheme,
} from "@mui/material";
import { DiffEditor } from "@monaco-editor/react";
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
  Github as GithubIcon,
  DownloadCloud as SyncIcon,
  GitCommitHorizontal as CommitIcon,
  GitPullRequest as PullRequestIcon,
  GitPullRequestClosed as PullRequestClosedIcon,
  GitMerge as MergedIcon,
  GitBranchPlus as NewBranchIcon,
  ArrowLeftRight as SwitchBranchIcon,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Check as CheckIcon,
  Box as ProjectBoxIcon,
  Sparkles as GenerateIcon,
  Lock as LockIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useExplorerStore } from "../store/explorerStore";
import {
  useDbtStore,
  type DbtJobItem,
  type GitFileDiff,
  type PullRequestItem,
} from "../store/dbtStore";
import {
  focusDbtConsoleTab,
  focusDbtFileTab,
  focusDbtJobTab,
  focusDbtRunsTab,
} from "../dbt-runtime/shell";
import {
  DBT_JINJA_LANGUAGE_ID,
  registerDbtJinjaLanguage,
} from "../lib/dbt-monaco";
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

function dbtDiffLanguage(path: string): string {
  if (path.endsWith(".sql")) return DBT_JINJA_LANGUAGE_ID;
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import ExplorerShell from "./ExplorerShell";

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

function dirname(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

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

/**
 * MUI Chip color for a job's environment badge. Prod-like envs are flagged
 * `warning` so destructive/scheduled prod runs stand out; the project default
 * and dev-like envs get `info`, everything else stays neutral.
 */
function envBadgeColor(
  envName: string,
  defaultEnvironment?: string,
): "warning" | "info" | "default" {
  const lower = envName.trim().toLowerCase();
  if (lower === "prod" || lower === "production") return "warning";
  if (
    lower === "dev" ||
    lower === "development" ||
    (defaultEnvironment != null && envName === defaultEnvironment)
  ) {
    return "info";
  }
  return "default";
}

/** Collapsible section header (dbt Studio "Version control" / "File explorer"). */
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

const STATUS_META = {
  added: { letter: "A", color: "success.main" },
  deleted: { letter: "D", color: "error.main" },
  modified: { letter: "M", color: "warning.main" },
} as const;

export function DbtExplorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;
  const theme = useTheme();
  const monacoTheme = theme.palette.mode === "dark" ? "vs-dark" : "vs";

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
  const syncProjectFromGitHub = useDbtStore(s => s.syncProjectFromGitHub);
  const gitStatusByProject = useDbtStore(s => s.gitStatusByProject);
  const checkoutBranchByProject = useDbtStore(s => s.checkoutBranchByProject);
  const protectedBranchesByProject = useDbtStore(
    s => s.protectedBranchesByProject,
  );
  const fetchGitStatus = useDbtStore(s => s.fetchGitStatus);
  const fetchGitDiff = useDbtStore(s => s.fetchGitDiff);
  const commitAndPush = useDbtStore(s => s.commitAndPush);
  const commitToBranch = useDbtStore(s => s.commitToBranch);
  const generateCommitMessage = useDbtStore(s => s.generateCommitMessage);
  const listBranches = useDbtStore(s => s.listBranches);
  const createBranch = useDbtStore(s => s.createBranch);
  const switchBranch = useDbtStore(s => s.switchBranch);
  const openPullRequest = useDbtStore(s => s.openPullRequest);
  const listPullRequests = useDbtStore(s => s.listPullRequests);
  const updatePullRequest = useDbtStore(s => s.updatePullRequest);
  const closePullRequest = useDbtStore(s => s.closePullRequest);
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
  const [syncingProjectId, setSyncingProjectId] = useState<string | null>(null);

  // In-IDE git dialogs
  const [commitTarget, setCommitTarget] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  /** New branch name when committing from a protected (PR-only) checkout. */
  const [commitBranchName, setCommitBranchName] = useState("");
  const [generatingMessage, setGeneratingMessage] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitResult, setGitResult] = useState<string | null>(null);
  const [syncSnack, setSyncSnack] = useState<{
    severity: "success" | "info" | "warning" | "error";
    message: string;
    /** When set, the snackbar offers an "Overwrite local" re-pull action. */
    projectId?: string;
  } | null>(null);
  const [diffData, setDiffData] = useState<GitFileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [branchTarget, setBranchTarget] = useState<string | null>(null);
  const [branchName, setBranchName] = useState("");
  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const [switchBranches, setSwitchBranches] = useState<string[]>([]);
  const [switchValue, setSwitchValue] = useState("");
  const [prTarget, setPrTarget] = useState<string | null>(null);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  // Pull requests list dialog
  const [prListTarget, setPrListTarget] = useState<string | null>(null);
  const [prList, setPrList] = useState<PullRequestItem[] | null>(null);
  const [prListState, setPrListState] = useState<"open" | "all">("open");
  const [prEdit, setPrEdit] = useState<{
    number: number;
    title: string;
    body: string;
  } | null>(null);
  const [prCloseConfirm, setPrCloseConfirm] = useState<number | null>(null);
  const [prBusy, setPrBusy] = useState(false);
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
  // project actions / git actions overflow menus.
  const [projectMenuAnchor, setProjectMenuAnchor] =
    useState<HTMLElement | null>(null);
  const [projectActionsAnchor, setProjectActionsAnchor] =
    useState<HTMLElement | null>(null);
  const [gitMenuAnchor, setGitMenuAnchor] = useState<HTMLElement | null>(null);
  const [vcOpen, setVcOpen] = useState(true);
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

  // After returning from the GitHub App install flow, open the import drawer
  // in GitHub mode, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("transformGithub");
    if (!result) return;
    if (result === "connected") {
      openCreateProject("github");
    }
    params.delete("transformGithub");
    const query = params.toString();
    window.history.replaceState(
      {},
      "",
      window.location.pathname + (query ? `?${query}` : ""),
    );
  }, [openCreateProject]);

  // Working-tree git status for repo-bound projects (drives change badges).
  const repoProjectIds = useMemo(
    () =>
      projects
        .filter(p => p.repo)
        .map(p => p._id)
        .join(","),
    [projects],
  );
  useEffect(() => {
    if (!workspaceId || !repoProjectIds) return;
    for (const id of repoProjectIds.split(",")) {
      void fetchGitStatus(workspaceId, id);
    }
  }, [workspaceId, repoProjectIds, fetchGitStatus]);

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

  const activeStatus = activeProjectId
    ? gitStatusByProject[activeProjectId]
    : undefined;
  const activeChangeCount = activeStatus?.changes.length ?? 0;
  /** The current user's checked-out branch (per-user checkout). */
  const activeBranch = activeProjectId
    ? (checkoutBranchByProject[activeProjectId] ??
      activeStatus?.branch ??
      activeProject?.repo?.branch)
    : undefined;
  /** True when the user's checkout is a protected (PR-only) branch. */
  const activeBranchProtected = Boolean(
    activeProjectId &&
      activeBranch &&
      (
        protectedBranchesByProject[activeProjectId] ??
        activeProject?.protectedBranches ??
        []
      ).includes(activeBranch),
  );

  const handleRefresh = useCallback(() => {
    if (!workspaceId) return;
    void fetchProjects(workspaceId);
    // Re-pull working-tree git status so change badges reflect commits made
    // outside this view (e.g. the agent committing server-side) without
    // forcing a full page reload — the mount effect only runs once.
    for (const id of repoProjectIds ? repoProjectIds.split(",") : []) {
      void fetchGitStatus(workspaceId, id);
    }
    // Refresh the active project's file tree so agent-added/removed files show.
    if (activeProjectId) void fetchFiles(workspaceId, activeProjectId);
  }, [
    workspaceId,
    repoProjectIds,
    activeProjectId,
    fetchProjects,
    fetchGitStatus,
    fetchFiles,
  ]);

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

  const handleSyncProject = useCallback(
    async (projectId: string, discard = false) => {
      if (!workspaceId) return;
      setSyncingProjectId(projectId);
      const result = await syncProjectFromGitHub(workspaceId, projectId, {
        discard,
      });
      setSyncingProjectId(null);
      if (!result) {
        setSyncSnack({
          severity: "error",
          message:
            useDbtStore.getState().error.projects ?? "Pull from remote failed.",
        });
        return;
      }
      await fetchFiles(workspaceId, projectId);
      const status = await fetchGitStatus(workspaceId, projectId);

      const ref = result.branch ?? "remote";
      const changed = result.added + result.updated + result.deleted;
      const pending = status?.changes.length ?? 0;
      if (changed === 0) {
        setSyncSnack({
          severity: "info",
          message: `Already up to date with ${ref}.`,
        });
      } else {
        const parts = `+${result.added} ~${result.updated} −${result.deleted}`;
        setSyncSnack({
          severity: "success",
          message:
            `Pulled ${ref}: ${parts}` +
            (pending > 0
              ? ` · your ${pending} uncommitted change${pending === 1 ? "" : "s"} ` +
                "stay pending on top."
              : ""),
        });
      }
    },
    [workspaceId, syncProjectFromGitHub, fetchFiles, fetchGitStatus],
  );

  const openCommitDialog = useCallback(
    (projectId: string) => {
      setCommitTarget(projectId);
      setCommitMessage("");
      setCommitBranchName("");
      setGitResult(null);
      if (workspaceId) void fetchGitStatus(workspaceId, projectId);
    },
    [workspaceId, fetchGitStatus],
  );

  const handleOpenDiff = useCallback(
    async (projectId: string, path: string) => {
      if (!workspaceId) return;
      setDiffLoading(true);
      const diff = await fetchGitDiff(workspaceId, projectId, path);
      setDiffLoading(false);
      if (diff) setDiffData(diff);
    },
    [workspaceId, fetchGitDiff],
  );

  const commitTargetProtected = useMemo(() => {
    if (!commitTarget) return false;
    const branch =
      checkoutBranchByProject[commitTarget] ??
      gitStatusByProject[commitTarget]?.branch;
    if (!branch) return false;
    const protectedBranches =
      protectedBranchesByProject[commitTarget] ??
      projects.find(p => p._id === commitTarget)?.protectedBranches ??
      [];
    return protectedBranches.includes(branch);
  }, [
    commitTarget,
    checkoutBranchByProject,
    gitStatusByProject,
    protectedBranchesByProject,
    projects,
  ]);

  const handleCommit = useCallback(async () => {
    if (!workspaceId || !commitTarget || !commitMessage.trim()) return;
    // Protected checkout: direct commits are refused server-side — promote the
    // drafts onto a new branch instead (then open a PR to merge).
    if (commitTargetProtected && !commitBranchName.trim()) return;
    setGitBusy(true);
    const result = commitTargetProtected
      ? await commitToBranch(
          workspaceId,
          commitTarget,
          commitBranchName.trim(),
          commitMessage.trim(),
        )
      : await commitAndPush(workspaceId, commitTarget, commitMessage.trim());
    setGitBusy(false);
    if (result?.committed) {
      const { added, modified, deleted } = result.pushed;
      setGitResult(
        `Pushed to ${result.branch}: +${added} ~${modified} -${deleted}`,
      );
      setCommitMessage("");
      setCommitBranchName("");
      // Briefly show the confirmation, then close — the working tree is now
      // clean, so leaving the dialog open just shows a dead "0 changes" state.
      window.setTimeout(() => {
        setCommitTarget(null);
        setGitResult(null);
      }, 1500);
    } else if (result) {
      setGitResult("No changes to commit");
    } else {
      setGitResult(
        useDbtStore.getState().error.projects ?? "Commit failed — try again.",
      );
    }
  }, [
    workspaceId,
    commitTarget,
    commitMessage,
    commitBranchName,
    commitTargetProtected,
    commitAndPush,
    commitToBranch,
  ]);

  const handleGenerateMessage = useCallback(async () => {
    if (!workspaceId || !commitTarget) return;
    setGeneratingMessage(true);
    setGitResult(null);
    const message = await generateCommitMessage(workspaceId, commitTarget);
    setGeneratingMessage(false);
    if (message) {
      setCommitMessage(message);
    } else {
      setGitResult("Could not generate a message — write one manually.");
    }
  }, [workspaceId, commitTarget, generateCommitMessage]);

  const handleCreateBranch = useCallback(async () => {
    if (!workspaceId || !branchTarget || !branchName.trim()) return;
    setGitBusy(true);
    const updated = await createBranch(
      workspaceId,
      branchTarget,
      branchName.trim(),
    );
    setGitBusy(false);
    if (updated) {
      setBranchTarget(null);
      setBranchName("");
    }
  }, [workspaceId, branchTarget, branchName, createBranch]);

  const openSwitchDialog = useCallback(
    async (projectId: string) => {
      if (!workspaceId) return;
      setSwitchTarget(projectId);
      setSwitchBranches([]);
      const result = await listBranches(workspaceId, projectId);
      if (result) {
        setSwitchBranches(result.branches);
        setSwitchValue(result.current);
      }
    },
    [workspaceId, listBranches],
  );

  const handleSwitchBranch = useCallback(async () => {
    if (!workspaceId || !switchTarget || !switchValue) return;
    setGitBusy(true);
    const updated = await switchBranch(workspaceId, switchTarget, switchValue);
    setGitBusy(false);
    if (updated) {
      await fetchFiles(workspaceId, switchTarget);
      await fetchGitStatus(workspaceId, switchTarget);
      setSwitchTarget(null);
    }
  }, [
    workspaceId,
    switchTarget,
    switchValue,
    switchBranch,
    fetchFiles,
    fetchGitStatus,
  ]);

  const handleOpenPullRequest = useCallback(async () => {
    if (!workspaceId || !prTarget || !prTitle.trim()) return;
    setGitBusy(true);
    const result = await openPullRequest(workspaceId, prTarget, {
      title: prTitle.trim(),
      body: prBody.trim() || undefined,
    });
    setGitBusy(false);
    if (result) {
      window.open(result.htmlUrl, "_blank", "noopener");
      setPrTarget(null);
      setPrTitle("");
      setPrBody("");
    }
  }, [workspaceId, prTarget, prTitle, prBody, openPullRequest]);

  const refreshPrList = useCallback(
    async (projectId: string, state: "open" | "all") => {
      if (!workspaceId) return;
      setPrList(null);
      const result = await listPullRequests(workspaceId, projectId, state);
      setPrList(result ?? []);
    },
    [workspaceId, listPullRequests],
  );

  const openPrListDialog = useCallback(
    (projectId: string) => {
      setPrListTarget(projectId);
      setPrEdit(null);
      setPrCloseConfirm(null);
      setPrListState("open");
      void refreshPrList(projectId, "open");
    },
    [refreshPrList],
  );

  const handlePrStateFilterChange = useCallback(
    (state: "open" | "all") => {
      setPrListState(state);
      if (prListTarget) void refreshPrList(prListTarget, state);
    },
    [prListTarget, refreshPrList],
  );

  const handleUpdatePullRequest = useCallback(async () => {
    if (!workspaceId || !prListTarget || !prEdit || !prEdit.title.trim()) {
      return;
    }
    setPrBusy(true);
    const updated = await updatePullRequest(
      workspaceId,
      prListTarget,
      prEdit.number,
      { title: prEdit.title.trim(), body: prEdit.body },
    );
    setPrBusy(false);
    if (updated) {
      setPrEdit(null);
      setSyncSnack({
        severity: "success",
        message: `PR #${updated.number} updated`,
      });
      void refreshPrList(prListTarget, prListState);
    }
  }, [
    workspaceId,
    prListTarget,
    prEdit,
    prListState,
    updatePullRequest,
    refreshPrList,
  ]);

  const handleClosePullRequest = useCallback(
    async (prNumber: number) => {
      if (!workspaceId || !prListTarget) return;
      setPrBusy(true);
      const closed = await closePullRequest(
        workspaceId,
        prListTarget,
        prNumber,
      );
      setPrBusy(false);
      setPrCloseConfirm(null);
      if (closed) {
        setSyncSnack({
          severity: "success",
          message: `PR #${closed.number} closed without merging`,
        });
        void refreshPrList(prListTarget, prListState);
      }
    },
    [workspaceId, prListTarget, prListState, closePullRequest, refreshPrList],
  );

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
        if (project?.repo) {
          const status = gitStatusByProject[parsed.projectId];
          const changeCount = status?.changes.length ?? 0;
          items.push(
            <MenuItem
              key="git-commit"
              disabled={changeCount === 0}
              onClick={() => {
                openCommitDialog(parsed.projectId);
                helpers.closeMenu();
              }}
            >
              <ListItemIcon>
                <CommitIcon size={16} strokeWidth={1.5} />
              </ListItemIcon>
              {changeCount > 0
                ? `Commit & push (${changeCount})\u2026`
                : "Commit & push"}
            </MenuItem>,
            <MenuItem
              key="git-pull"
              disabled={syncingProjectId === parsed.projectId}
              onClick={() => {
                void handleSyncProject(parsed.projectId);
                helpers.closeMenu();
              }}
            >
              <ListItemIcon>
                <SyncIcon size={16} strokeWidth={1.5} />
              </ListItemIcon>
              {syncingProjectId === parsed.projectId
                ? "Pulling\u2026"
                : "Pull from remote"}
            </MenuItem>,
            <MenuItem
              key="git-branch"
              onClick={() => {
                setBranchTarget(parsed.projectId);
                setBranchName("");
                helpers.closeMenu();
              }}
            >
              <ListItemIcon>
                <NewBranchIcon size={16} strokeWidth={1.5} />
              </ListItemIcon>
              Create branch
            </MenuItem>,
            <MenuItem
              key="git-switch"
              onClick={() => {
                void openSwitchDialog(parsed.projectId);
                helpers.closeMenu();
              }}
            >
              <ListItemIcon>
                <SwitchBranchIcon size={16} strokeWidth={1.5} />
              </ListItemIcon>
              Switch branch
            </MenuItem>,
            <MenuItem
              key="git-pr"
              onClick={() => {
                setPrTarget(parsed.projectId);
                setPrTitle("");
                setPrBody("");
                helpers.closeMenu();
              }}
            >
              <ListItemIcon>
                <PullRequestIcon size={16} strokeWidth={1.5} />
              </ListItemIcon>
              Open pull request
            </MenuItem>,
            <MenuItem
              key="git-pr-list"
              onClick={() => {
                openPrListDialog(parsed.projectId);
                helpers.closeMenu();
              }}
            >
              <ListItemIcon>
                <PullRequestIcon size={16} strokeWidth={1.5} />
              </ListItemIcon>
              Pull requests
            </MenuItem>,
            <Divider key="git-divider" />,
          );
        }
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
    [
      handleItemClick,
      openProjectSettingsFromMenu,
      projects,
      handleSyncProject,
      syncingProjectId,
      gitStatusByProject,
      openCommitDialog,
      openSwitchDialog,
      openPrListDialog,
      handleNewJob,
    ],
  );

  // Hover kebab: same actions as the right-click menu, but discoverable.
  const getRightAdornment = useCallback(
    (node: ResourceTreeNode) => {
      const parsed = parseNodeId(node.id);
      // The Jobs folder gets a kebab (→ "New job"); other dirs/runs do not.
      if (parsed.kind === "runs") return null;
      if (parsed.kind === "dir" && parsed.path !== JOBS_DIR) return null;

      // Per-file change dot (modified/added) for repo-bound projects.
      if (parsed.kind === "file") {
        const status = gitStatusByProject[parsed.projectId];
        const change = status?.changes.find(c => c.path === parsed.path);
        if (!change) return null;
        const color =
          change.status === "added"
            ? "success.main"
            : change.status === "deleted"
              ? "error.main"
              : "warning.main";
        const letter =
          change.status === "added"
            ? "A"
            : change.status === "deleted"
              ? "D"
              : "M";
        return (
          <Tooltip title={`${change.status} (uncommitted)`}>
            <Box
              component="span"
              sx={{ color, fontSize: 11, fontWeight: 700, pr: 0.5 }}
            >
              {letter}
            </Box>
          </Tooltip>
        );
      }

      const project =
        parsed.kind === "project"
          ? projects.find(p => p._id === parsed.projectId)
          : undefined;
      const kebab = (
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
      if (!project?.repo) return kebab;
      const status = gitStatusByProject[parsed.projectId];
      const changeCount = status?.changes.length ?? 0;
      const branchLabel =
        checkoutBranchByProject[parsed.projectId] ??
        status?.branch ??
        project.repo.branch;
      return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
          <Tooltip
            title={
              `${project.repo.owner}/${project.repo.repo} @ ${branchLabel}` +
              (changeCount > 0 ? ` — ${changeCount} uncommitted` : "")
            }
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.25,
                color: changeCount > 0 ? "warning.main" : "text.secondary",
                fontSize: 11,
                maxWidth: 90,
              }}
            >
              <GithubIcon size={12} strokeWidth={1.5} />
              <Box
                component="span"
                sx={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {branchLabel}
                {changeCount > 0 ? ` •${changeCount}` : ""}
              </Box>
            </Box>
          </Tooltip>
          {kebab}
        </Box>
      );
    },
    [projects, gitStatusByProject, checkoutBranchByProject],
  );

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

  // Project-level actions (the kebab next to the project switcher). Git
  // actions live in the Version control section instead.
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

  // Git actions overflow menu (Version control header). Primary commit action
  // is a dedicated button; the rest live here.
  const gitMenuItems = useCallback(
    (projectId: string, close: () => void) => [
      <MenuItem
        key="pull"
        disabled={syncingProjectId === projectId}
        onClick={() => {
          void handleSyncProject(projectId);
          close();
        }}
      >
        <ListItemIcon>
          <SyncIcon size={16} strokeWidth={1.5} />
        </ListItemIcon>
        {syncingProjectId === projectId ? "Pulling\u2026" : "Pull from remote"}
      </MenuItem>,
      <MenuItem
        key="branch"
        onClick={() => {
          setBranchTarget(projectId);
          setBranchName("");
          close();
        }}
      >
        <ListItemIcon>
          <NewBranchIcon size={16} strokeWidth={1.5} />
        </ListItemIcon>
        Create branch
      </MenuItem>,
      <MenuItem
        key="switch"
        onClick={() => {
          void openSwitchDialog(projectId);
          close();
        }}
      >
        <ListItemIcon>
          <SwitchBranchIcon size={16} strokeWidth={1.5} />
        </ListItemIcon>
        Switch branch
      </MenuItem>,
      <MenuItem
        key="pr"
        onClick={() => {
          setPrTarget(projectId);
          setPrTitle("");
          setPrBody("");
          close();
        }}
      >
        <ListItemIcon>
          <PullRequestIcon size={16} strokeWidth={1.5} />
        </ListItemIcon>
        Open pull request
      </MenuItem>,
      <MenuItem
        key="pr-list"
        onClick={() => {
          openPrListDialog(projectId);
          close();
        }}
      >
        <ListItemIcon>
          <PullRequestIcon size={16} strokeWidth={1.5} />
        </ListItemIcon>
        Pull requests
      </MenuItem>,
    ],
    [syncingProjectId, handleSyncProject, openSwitchDialog, openPrListDialog],
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
              {/* Version control (repo-bound projects) */}
              {activeProject.repo ? (
                <>
                  <SectionHeader
                    label="Version control"
                    open={vcOpen}
                    onToggle={() => setVcOpen(o => !o)}
                    actions={
                      <Tooltip title="Branch actions">
                        <IconButton
                          size="small"
                          onClick={e => setGitMenuAnchor(e.currentTarget)}
                        >
                          <KebabIcon size={15} strokeWidth={1.75} />
                        </IconButton>
                      </Tooltip>
                    }
                  />
                  {vcOpen && (
                    <Box sx={{ px: 1.25, pb: 1 }}>
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: 0.5,
                          color: "text.secondary",
                          mb: 0.75,
                          minWidth: 0,
                        }}
                      >
                        <GithubIcon size={13} strokeWidth={1.75} />
                        <Box
                          component="span"
                          sx={{
                            fontSize: 12,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            flex: 1,
                          }}
                        >
                          {activeBranch ?? activeProject.repo.branch}
                        </Box>
                        {activeBranchProtected && (
                          <Tooltip title="Protected branch — changes merge via pull request">
                            <LockIcon size={12} strokeWidth={1.75} />
                          </Tooltip>
                        )}
                        {activeChangeCount > 0 && (
                          <Chip
                            label={activeChangeCount}
                            size="small"
                            color="warning"
                            sx={{ height: 16, fontSize: "0.62rem" }}
                          />
                        )}
                      </Box>
                      <Button
                        fullWidth
                        size="small"
                        variant="outlined"
                        startIcon={<CommitIcon size={15} strokeWidth={1.75} />}
                        disabled={activeChangeCount === 0}
                        onClick={() => openCommitDialog(activeProject._id)}
                        sx={{ textTransform: "none", mb: 1 }}
                      >
                        {activeChangeCount > 0
                          ? `Commit & push (${activeChangeCount})`
                          : "No changes to commit"}
                      </Button>
                      {activeChangeCount > 0 && (
                        <Box
                          sx={{
                            border: 1,
                            borderColor: "divider",
                            borderRadius: 1,
                            overflow: "hidden",
                          }}
                        >
                          {activeStatus?.changes.map(change => {
                            const meta = STATUS_META[change.status];
                            return (
                              <Box
                                key={change.path}
                                role="button"
                                tabIndex={0}
                                title="View diff"
                                onClick={() =>
                                  void handleOpenDiff(
                                    activeProject._id,
                                    change.path,
                                  )
                                }
                                onKeyDown={e => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    void handleOpenDiff(
                                      activeProject._id,
                                      change.path,
                                    );
                                  }
                                }}
                                sx={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 0.75,
                                  px: 1,
                                  py: 0.4,
                                  fontSize: 12,
                                  cursor: "pointer",
                                  "&:hover": {
                                    backgroundColor: "action.hover",
                                  },
                                }}
                              >
                                <Box
                                  component="span"
                                  sx={{
                                    fontWeight: 700,
                                    width: 12,
                                    color: meta.color,
                                  }}
                                >
                                  {meta.letter}
                                </Box>
                                <Box
                                  component="span"
                                  sx={{
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {change.path}
                                </Box>
                              </Box>
                            );
                          })}
                        </Box>
                      )}
                    </Box>
                  )}
                  <Divider />
                </>
              ) : null}

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
                              {job.name}
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

      {/* Git actions menu (Version control header) */}
      <Menu
        open={!!gitMenuAnchor}
        anchorEl={gitMenuAnchor}
        onClose={() => setGitMenuAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {activeProjectId
          ? gitMenuItems(activeProjectId, () => setGitMenuAnchor(null))
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

      {/* Commit & push dialog */}
      <Dialog
        open={!!commitTarget}
        onClose={() => setCommitTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Commit &amp; push</DialogTitle>
        <DialogContent>
          {(() => {
            const status = commitTarget
              ? gitStatusByProject[commitTarget]
              : undefined;
            const changes = status?.changes ?? [];
            return (
              <>
                <Typography variant="caption" color="text.secondary">
                  {status
                    ? `${changes.length} change${
                        changes.length === 1 ? "" : "s"
                      } on ${status.branch}` +
                      (changes.length > 0
                        ? " — click a file to view its diff"
                        : "")
                    : "Loading changes…"}
                </Typography>
                <Box
                  sx={{
                    maxHeight: 160,
                    overflow: "auto",
                    my: 1,
                    border: 1,
                    borderColor: "divider",
                    borderRadius: 1,
                  }}
                >
                  {changes.length === 0 ? (
                    <Typography
                      variant="body2"
                      sx={{ p: 1.5, color: "text.secondary" }}
                    >
                      No changes to commit.
                    </Typography>
                  ) : (
                    changes.map(change => (
                      <Box
                        key={change.path}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          if (commitTarget) {
                            void handleOpenDiff(commitTarget, change.path);
                          }
                        }}
                        onKeyDown={e => {
                          if (
                            (e.key === "Enter" || e.key === " ") &&
                            commitTarget
                          ) {
                            e.preventDefault();
                            void handleOpenDiff(commitTarget, change.path);
                          }
                        }}
                        title="View diff"
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: 1,
                          px: 1.5,
                          py: 0.5,
                          fontSize: 13,
                          cursor: "pointer",
                          "&:hover": { backgroundColor: "action.hover" },
                        }}
                      >
                        <Box
                          component="span"
                          sx={{
                            fontWeight: 700,
                            width: 14,
                            color:
                              change.status === "added"
                                ? "success.main"
                                : change.status === "deleted"
                                  ? "error.main"
                                  : "warning.main",
                          }}
                        >
                          {change.status === "added"
                            ? "A"
                            : change.status === "deleted"
                              ? "D"
                              : "M"}
                        </Box>
                        <Box
                          component="span"
                          sx={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {change.path}
                        </Box>
                      </Box>
                    ))
                  )}
                </Box>
                <Box
                  sx={{
                    display: "flex",
                    justifyContent: "flex-end",
                    mb: 0.5,
                  }}
                >
                  <Button
                    size="small"
                    onClick={handleGenerateMessage}
                    disabled={generatingMessage || changes.length === 0}
                    startIcon={
                      generatingMessage ? (
                        <CircularProgress size={13} />
                      ) : (
                        <GenerateIcon size={14} strokeWidth={1.75} />
                      )
                    }
                    sx={{ textTransform: "none" }}
                  >
                    {generatingMessage ? "Generating…" : "Generate with AI"}
                  </Button>
                </Box>
                <TextField
                  autoFocus
                  fullWidth
                  multiline
                  minRows={2}
                  size="small"
                  label="Commit message"
                  value={commitMessage}
                  onChange={e => setCommitMessage(e.target.value)}
                />
                {commitTargetProtected && (
                  <>
                    <Alert severity="info" sx={{ mt: 1.5 }} icon={false}>
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: 0.75,
                        }}
                      >
                        <LockIcon size={14} strokeWidth={1.75} />
                        <span>
                          {status?.branch ?? "This branch"} is protected —
                          changes commit to a new branch, then merge via pull
                          request.
                        </span>
                      </Box>
                    </Alert>
                    <TextField
                      fullWidth
                      size="small"
                      label="New branch name"
                      placeholder="feature/my-change"
                      value={commitBranchName}
                      onChange={e => setCommitBranchName(e.target.value)}
                      sx={{ mt: 1.5 }}
                    />
                  </>
                )}
                {gitResult && (
                  <Typography
                    variant="caption"
                    color="success.main"
                    display="block"
                    sx={{ mt: 1 }}
                  >
                    {gitResult}
                  </Typography>
                )}
              </>
            );
          })()}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCommitTarget(null)}>Close</Button>
          <Button
            onClick={handleCommit}
            startIcon={
              gitBusy ? (
                <CircularProgress size={14} />
              ) : (
                <CommitIcon size={15} strokeWidth={1.75} />
              )
            }
            disabled={
              gitBusy ||
              !commitMessage.trim() ||
              (commitTargetProtected && !commitBranchName.trim()) ||
              (commitTarget
                ? (gitStatusByProject[commitTarget]?.changes.length ?? 0) === 0
                : true)
            }
          >
            {gitBusy
              ? "Pushing…"
              : commitTargetProtected
                ? "Commit to new branch"
                : "Commit & push"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* File diff dialog (side-by-side, screenshot 52) */}
      <Dialog
        open={!!diffData || diffLoading}
        onClose={() => setDiffData(null)}
        maxWidth="lg"
        fullWidth
        PaperProps={{ sx: { height: "80vh" } }}
      >
        <DialogTitle
          sx={{ fontSize: "0.9rem", fontFamily: "monospace", py: 1.25 }}
        >
          {diffData?.path ?? "Loading diff…"}
        </DialogTitle>
        <DialogContent dividers sx={{ p: 0 }}>
          {diffLoading ? (
            <Box
              sx={{
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <CircularProgress size={20} />
            </Box>
          ) : diffData ? (
            <DiffEditor
              height="100%"
              theme={monacoTheme}
              original={diffData.base}
              modified={diffData.working}
              language={dbtDiffLanguage(diffData.path)}
              beforeMount={registerDbtJinjaLanguage}
              options={{
                readOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
              }}
            />
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDiffData(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Create branch dialog */}
      <Dialog
        open={!!branchTarget}
        onClose={() => setBranchTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Create branch</DialogTitle>
        <DialogContent>
          <Typography variant="caption" color="text.secondary">
            Branches off the current branch and checks it out.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="New branch name"
            placeholder="feature/my-change"
            value={branchName}
            onChange={e => setBranchName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") void handleCreateBranch();
            }}
            sx={{ mt: 1.5 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBranchTarget(null)}>Cancel</Button>
          <Button
            onClick={handleCreateBranch}
            disabled={gitBusy || !branchName.trim()}
          >
            {gitBusy ? "Creating…" : "Create & switch"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Switch branch dialog */}
      <Dialog
        open={!!switchTarget}
        onClose={() => setSwitchTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Switch branch</DialogTitle>
        <DialogContent>
          <FormControl fullWidth size="small" sx={{ mt: 1.5 }}>
            <InputLabel id="dbt-switch-branch">Branch</InputLabel>
            <Select
              labelId="dbt-switch-branch"
              label="Branch"
              value={switchValue}
              onChange={e => setSwitchValue(e.target.value)}
            >
              {switchBranches.length === 0 && (
                <MenuItem disabled value="">
                  Loading branches…
                </MenuItem>
              )}
              {switchBranches.map(branch => (
                <MenuItem key={branch} value={branch}>
                  {branch}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Typography
            variant="caption"
            color="text.secondary"
            display="block"
            sx={{ mt: 1 }}
          >
            Switching pulls the selected branch for you only — teammates keep
            their own checkout, and your uncommitted changes carry over.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSwitchTarget(null)}>Cancel</Button>
          <Button
            onClick={handleSwitchBranch}
            disabled={gitBusy || !switchValue}
          >
            {gitBusy ? "Switching…" : "Switch"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Open pull request dialog */}
      <Dialog
        open={!!prTarget}
        onClose={() => setPrTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Open pull request</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Title"
            value={prTitle}
            onChange={e => setPrTitle(e.target.value)}
            sx={{ mt: 1.5, mb: 2 }}
          />
          <TextField
            fullWidth
            multiline
            minRows={3}
            size="small"
            label="Description (optional)"
            value={prBody}
            onChange={e => setPrBody(e.target.value)}
          />
          <Typography
            variant="caption"
            color="text.secondary"
            display="block"
            sx={{ mt: 1 }}
          >
            Opens a PR from the current branch into the repository&apos;s
            default branch.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPrTarget(null)}>Cancel</Button>
          <Button
            onClick={handleOpenPullRequest}
            startIcon={
              gitBusy ? (
                <CircularProgress size={14} />
              ) : (
                <PullRequestIcon size={15} strokeWidth={1.75} />
              )
            }
            disabled={gitBusy || !prTitle.trim()}
          >
            {gitBusy ? "Opening…" : "Open PR"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Pull requests list dialog (view / edit / close) */}
      <Dialog
        open={!!prListTarget}
        onClose={() => setPrListTarget(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
          }}
        >
          Pull requests
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <FormControl size="small" sx={{ minWidth: 90 }}>
              <Select
                value={prListState}
                onChange={e =>
                  handlePrStateFilterChange(e.target.value as "open" | "all")
                }
              >
                <MenuItem value="open">Open</MenuItem>
                <MenuItem value="all">All</MenuItem>
              </Select>
            </FormControl>
            <Tooltip title="Refresh">
              <IconButton
                size="small"
                onClick={() => {
                  if (prListTarget) {
                    void refreshPrList(prListTarget, prListState);
                  }
                }}
              >
                <RefreshIcon size={16} strokeWidth={2} />
              </IconButton>
            </Tooltip>
          </Box>
        </DialogTitle>
        <DialogContent dividers sx={{ p: 0, minHeight: 160 }}>
          {prList === null ? (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                py: 5,
              }}
            >
              <CircularProgress size={20} />
            </Box>
          ) : prList.length === 0 ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ px: 2.5, py: 4, textAlign: "center" }}
            >
              {prListState === "open"
                ? "No open pull requests."
                : "No pull requests."}
            </Typography>
          ) : (
            prList.map(pr => {
              const isEditing = prEdit?.number === pr.number;
              const isConfirmingClose = prCloseConfirm === pr.number;
              return (
                <Box
                  key={pr.number}
                  sx={{
                    px: 2,
                    py: 1.25,
                    borderBottom: 1,
                    borderColor: "divider",
                    "&:last-of-type": { borderBottom: 0 },
                  }}
                >
                  <Box
                    sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}
                  >
                    <Box sx={{ mt: 0.25, flexShrink: 0, display: "flex" }}>
                      {pr.merged ? (
                        <MergedIcon
                          size={16}
                          strokeWidth={2}
                          color={theme.palette.secondary.main}
                        />
                      ) : pr.state === "open" ? (
                        <PullRequestIcon
                          size={16}
                          strokeWidth={2}
                          color={theme.palette.success.main}
                        />
                      ) : (
                        <PullRequestClosedIcon
                          size={16}
                          strokeWidth={2}
                          color={theme.palette.error.main}
                        />
                      )}
                    </Box>
                    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Link
                        href={pr.htmlUrl}
                        target="_blank"
                        rel="noopener"
                        underline="hover"
                        color="text.primary"
                        sx={{
                          fontSize: "0.85rem",
                          fontWeight: 500,
                          display: "block",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        #{pr.number} {pr.title}
                      </Link>
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "baseline",
                          gap: 0.5,
                          minWidth: 0,
                        }}
                      >
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            minWidth: 0,
                          }}
                        >
                          {pr.headRef} → {pr.baseRef}
                          {pr.author ? ` · ${pr.author}` : ""}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ flexShrink: 0 }}
                        >
                          · {new Date(pr.updatedAt).toLocaleDateString()}
                        </Typography>
                      </Box>
                    </Box>
                    {pr.draft && pr.state === "open" && (
                      <Chip
                        label="Draft"
                        size="small"
                        variant="outlined"
                        sx={{ flexShrink: 0 }}
                      />
                    )}
                    {pr.merged ? (
                      <Chip
                        label="Merged"
                        size="small"
                        color="secondary"
                        variant="outlined"
                        sx={{ flexShrink: 0 }}
                      />
                    ) : pr.state === "closed" ? (
                      <Chip
                        label="Closed"
                        size="small"
                        color="error"
                        variant="outlined"
                        sx={{ flexShrink: 0 }}
                      />
                    ) : (
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          gap: 0.25,
                          flexShrink: 0,
                        }}
                      >
                        <Tooltip title="Edit title & description">
                          <IconButton
                            size="small"
                            disabled={prBusy}
                            onClick={() => {
                              setPrCloseConfirm(null);
                              setPrEdit(
                                isEditing
                                  ? null
                                  : {
                                      number: pr.number,
                                      title: pr.title,
                                      body: pr.body,
                                    },
                              );
                            }}
                          >
                            <RenameIcon size={14} strokeWidth={1.75} />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Close without merging">
                          <IconButton
                            size="small"
                            disabled={prBusy}
                            onClick={() => {
                              setPrEdit(null);
                              setPrCloseConfirm(
                                isConfirmingClose ? null : pr.number,
                              );
                            }}
                          >
                            <PullRequestClosedIcon
                              size={14}
                              strokeWidth={1.75}
                            />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    )}
                  </Box>
                  {isEditing && (
                    <Box sx={{ mt: 1.25, pl: 3 }}>
                      <TextField
                        autoFocus
                        fullWidth
                        size="small"
                        label="Title"
                        value={prEdit.title}
                        onChange={e =>
                          setPrEdit({ ...prEdit, title: e.target.value })
                        }
                        sx={{ mb: 1.5 }}
                      />
                      <TextField
                        fullWidth
                        multiline
                        minRows={2}
                        size="small"
                        label="Description"
                        value={prEdit.body}
                        onChange={e =>
                          setPrEdit({ ...prEdit, body: e.target.value })
                        }
                      />
                      <Box
                        sx={{
                          display: "flex",
                          justifyContent: "flex-end",
                          gap: 1,
                          mt: 1,
                        }}
                      >
                        <Button size="small" onClick={() => setPrEdit(null)}>
                          Cancel
                        </Button>
                        <Button
                          size="small"
                          variant="contained"
                          onClick={handleUpdatePullRequest}
                          disabled={prBusy || !prEdit.title.trim()}
                          startIcon={
                            prBusy ? <CircularProgress size={12} /> : undefined
                          }
                        >
                          {prBusy ? "Saving…" : "Save"}
                        </Button>
                      </Box>
                    </Box>
                  )}
                  {isConfirmingClose && (
                    <Box
                      sx={{
                        mt: 1,
                        pl: 3,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "flex-end",
                        gap: 1,
                      }}
                    >
                      <Typography variant="caption" color="text.secondary">
                        Close #{pr.number} without merging?
                      </Typography>
                      <Button
                        size="small"
                        onClick={() => setPrCloseConfirm(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="small"
                        color="error"
                        variant="contained"
                        onClick={() => void handleClosePullRequest(pr.number)}
                        disabled={prBusy}
                        startIcon={
                          prBusy ? <CircularProgress size={12} /> : undefined
                        }
                      >
                        {prBusy ? "Closing…" : "Close PR"}
                      </Button>
                    </Box>
                  )}
                </Box>
              );
            })
          )}
        </DialogContent>
        <DialogActions>
          <Button
            startIcon={<PullRequestIcon size={15} strokeWidth={1.75} />}
            onClick={() => {
              const pid = prListTarget;
              setPrListTarget(null);
              if (pid) {
                setPrTarget(pid);
                setPrTitle("");
                setPrBody("");
              }
            }}
          >
            New PR
          </Button>
          <Box sx={{ flexGrow: 1 }} />
          <Button onClick={() => setPrListTarget(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!syncSnack}
        autoHideDuration={syncSnack?.severity === "warning" ? 10000 : 6000}
        onClose={() => setSyncSnack(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {syncSnack ? (
          <Alert
            severity={syncSnack.severity}
            variant="filled"
            onClose={() => setSyncSnack(null)}
            sx={{ maxWidth: 520 }}
            action={
              syncSnack.projectId ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    const pid = syncSnack.projectId;
                    setSyncSnack(null);
                    if (pid) void handleSyncProject(pid, true);
                  }}
                >
                  Overwrite local
                </Button>
              ) : undefined
            }
          >
            {syncSnack.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </>
  );
}

export default DbtExplorer;
