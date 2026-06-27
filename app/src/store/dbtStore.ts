/**
 * dbt Store
 *
 * State + API access for the dbt IDE: projects, virtual files, jobs, runs.
 * Mirrors the appStore/flowStore shapes. The agent's client tools mutate
 * through the same writeFile/persistFile path as the editor so UI and agent
 * edits share one code path.
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

export interface DbtEnvironment {
  name: string;
  connectionId: string;
  targetSchema: string;
  threads: number;
  vars?: Record<string, unknown>;
}

export interface DbtRepoBinding {
  provider: "github";
  installationId?: number;
  owner: string;
  repo: string;
  branch: string;
  subdirectory?: string;
  lastSyncedSha?: string;
  lastSyncedAt?: string;
}

export interface DbtCiConfig {
  enabled: boolean;
  environment?: string;
  deferToProduction?: boolean;
}

export interface DbtProjectItem {
  _id: string;
  name: string;
  dbtVersion: string;
  environments: DbtEnvironment[];
  defaultEnvironment: string;
  updatedAt?: string;
  /** Set when the project is imported/synced from a Git repository. */
  repo?: DbtRepoBinding;
  /** Pull-request CI config (repo-bound projects). */
  ci?: DbtCiConfig;
  /** Artifact-store key of last prod manifest (Slim CI defer state). */
  lastProdManifestKey?: string;
}

export interface GitHubInstallationItem {
  installationId: number;
  accountLogin: string;
  accountType: "Organization" | "User";
  repositorySelection: "all" | "selected";
}

export interface GitHubRepoItem {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface GitHubStatus {
  appConfigured: boolean;
  appSlug: string | null;
  devTokenAvailable: boolean;
  installations: GitHubInstallationItem[];
}

export interface GitHubRepoCheck {
  owner: string;
  repo: string;
  branch: string;
  subdirectory?: string;
  defaultBranch: string;
  hasDbtProjectYml: boolean;
  suggestedSubdirectories: string[];
}

export interface ImportGitHubPayload {
  name: string;
  environments: DbtEnvironment[];
  defaultEnvironment: string;
  dbtVersion?: string;
  repo: {
    owner: string;
    repo: string;
    branch?: string;
    subdirectory?: string;
    installationId?: number;
  };
}

export interface SyncResult {
  sha: string;
  added: number;
  updated: number;
  deleted: number;
  skippedLarge: string[];
  /** Files left untouched because they had uncommitted local edits. */
  preservedLocal: string[];
  /** The branch that was pulled (for user-facing feedback). */
  branch?: string;
}

export interface GitFileStatus {
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface GitFileDiff {
  path: string;
  status: "added" | "modified" | "deleted";
  base: string;
  working: string;
}

export interface GitStatus {
  branch: string;
  changes: GitFileStatus[];
  added: number;
  modified: number;
  deleted: number;
  hasChanges: boolean;
}

export interface CommitResult {
  committed: boolean;
  sha?: string;
  branch: string;
  pushed: { added: number; modified: number; deleted: number };
}

export interface DbtFileEntry {
  content: string;
  /** True while local edits have not been persisted yet. */
  dirty: boolean;
  loaded: boolean;
}

export interface DbtJobItem {
  _id: string;
  projectId: string;
  name: string;
  environment: string;
  commands: string[];
  schedule?: { cron: string; timezone: string } | null;
  scheduledRun?: {
    nextAt?: string;
    lastAt?: string;
    lastStatus?: "success" | "error";
    lastError?: string;
    lastDurationMs?: number;
    runCount?: number;
    consecutiveFailures?: number;
  };
  enabled: boolean;
  deferToProduction?: boolean;
}

export interface DbtRunLogLine {
  ts: string;
  level: string;
  line: string;
}

export interface DbtStepResult {
  uniqueId: string;
  name: string;
  resourceType: string;
  status: string;
  executionTimeMs: number;
  rowsAffected?: number;
  message?: string;
}

export interface DbtRunItem {
  _id: string;
  projectId: string;
  jobId?: string;
  environment: string;
  commands: string[];
  status: "queued" | "running" | "success" | "error" | "cancelled";
  trigger: "schedule" | "manual" | "agent" | "ci";
  triggeredBy: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  /** Set when the run was cancelled. */
  cancelledAt?: string;
  /** User id (or "agent") that cancelled the run. */
  cancelledBy?: string;
  stepResults?: DbtStepResult[];
  error?: string;
  createdAt: string;
  /** PR context for CI runs (trigger === "ci"). */
  ci?: {
    prNumber: number;
    headSha: string;
    headRef: string;
    baseRef: string;
    owner: string;
    repo: string;
  };
}

/** Which run artifacts were stored (keys present → downloadable). */
export interface DbtArtifactKeys {
  manifest?: string;
  runResults?: string;
  catalog?: string;
  sources?: string;
}

export type DbtArtifactKind = keyof DbtArtifactKeys;

export interface DbtRunDetails extends DbtRunItem {
  logs: DbtRunLogLine[];
  logCursor: number;
  artifactKeys?: DbtArtifactKeys;
}

export interface DbtCompileResult {
  ok: boolean;
  exitCode: number;
  compiledSql?: string;
  logs: DbtRunLogLine[];
}

export interface DbtRunModelResult {
  ok: boolean;
  exitCode: number;
  stepResults: DbtStepResult[];
  logs: DbtRunLogLine[];
}

export interface DbtCommandRunResult {
  ok: boolean;
  exitCode: number;
  subcommand: string;
  stepResults: DbtStepResult[];
  logs: DbtRunLogLine[];
}

export interface DbtLineageNode {
  id: string;
  name: string;
  resourceType: string;
  filePath?: string;
  lastStatus?: string;
  description?: string;
  materialized?: string;
  tags?: string[];
  columns?: Array<{ name: string; type?: string; description?: string }>;
  url?: string;
  owner?: string;
}

export interface DbtLineage {
  nodes: DbtLineageNode[];
  edges: Array<{ source: string; target: string }>;
  generatedAt: string | null;
}

interface DbtState {
  projects: DbtProjectItem[];
  projectsLoaded: boolean;
  /** Currently selected project (drives the dbt Studio-style explorer). */
  activeProjectId: string | null;
  /** projectId → sorted file paths (tree source of truth). */
  filePathsByProject: Record<string, string[]>;
  /** projectId → path → file entry. */
  filesByProject: Record<string, Record<string, DbtFileEntry>>;
  /** projectId → jobs. */
  jobsByProject: Record<string, DbtJobItem[]>;
  /** projectId → recent runs (newest first), unfiltered (project-wide view). */
  runsByProject: Record<string, DbtRunItem[]>;
  /** jobId → recent runs for that job (newest first). Kept separate from
   * `runsByProject` so the job view and the project-wide Runs view never
   * clobber each other's list when both are mounted. */
  runsByJob: Record<string, DbtRunItem[]>;
  /** runId → details incl. accumulated logs. */
  runDetails: Record<string, DbtRunDetails>;
  /** projectId → working-tree git status (repo-bound projects). */
  gitStatusByProject: Record<string, GitStatus>;
  /** Project settings drawer (mounted at app root). */
  settingsProjectId: string | null;
  /** New project drawer (mounted at app root). */
  createProjectOpen: boolean;
  createProjectMode: "blank" | "github";
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
}

interface DbtActions {
  fetchProjects: (workspaceId: string) => Promise<void>;
  setActiveProject: (projectId: string | null) => void;
  createProject: (
    workspaceId: string,
    payload: {
      name: string;
      environments: DbtEnvironment[];
      defaultEnvironment: string;
      dbtVersion?: string;
    },
  ) => Promise<DbtProjectItem | null>;
  updateProject: (
    workspaceId: string,
    projectId: string,
    patch: {
      name?: string;
      environments?: DbtEnvironment[];
      defaultEnvironment?: string;
      dbtVersion?: string;
      ci?: DbtCiConfig;
    },
  ) => Promise<DbtProjectItem | null>;
  deleteProject: (workspaceId: string, projectId: string) => Promise<boolean>;
  fetchGitHubStatus: (workspaceId: string) => Promise<GitHubStatus | null>;
  fetchGitHubRepos: (
    workspaceId: string,
    installationId: number,
  ) => Promise<GitHubRepoItem[]>;
  fetchGitHubBranches: (
    workspaceId: string,
    params: {
      owner: string;
      repo: string;
      installationId?: number;
    },
  ) => Promise<string[]>;
  checkGitHubRepo: (
    workspaceId: string,
    params: {
      owner: string;
      repo: string;
      branch?: string;
      subdirectory?: string;
      installationId?: number;
    },
  ) => Promise<GitHubRepoCheck | null>;
  getGitHubInstallUrl: (workspaceId: string) => Promise<string | null>;
  importProjectFromGitHub: (
    workspaceId: string,
    payload: ImportGitHubPayload,
  ) => Promise<DbtProjectItem | null>;
  syncProjectFromGitHub: (
    workspaceId: string,
    projectId: string,
    options?: { discard?: boolean },
  ) => Promise<SyncResult | null>;
  fetchGitStatus: (
    workspaceId: string,
    projectId: string,
  ) => Promise<GitStatus | null>;
  fetchGitDiff: (
    workspaceId: string,
    projectId: string,
    path: string,
  ) => Promise<GitFileDiff | null>;
  commitAndPush: (
    workspaceId: string,
    projectId: string,
    message: string,
  ) => Promise<CommitResult | null>;
  generateCommitMessage: (
    workspaceId: string,
    projectId: string,
  ) => Promise<string | null>;
  listBranches: (
    workspaceId: string,
    projectId: string,
  ) => Promise<{ branches: string[]; current: string } | null>;
  createBranch: (
    workspaceId: string,
    projectId: string,
    name: string,
  ) => Promise<DbtProjectItem | null>;
  switchBranch: (
    workspaceId: string,
    projectId: string,
    branch: string,
  ) => Promise<DbtProjectItem | null>;
  openPullRequest: (
    workspaceId: string,
    projectId: string,
    payload: { title: string; body?: string; base?: string },
  ) => Promise<{ number: number; htmlUrl: string } | null>;

  fetchFiles: (workspaceId: string, projectId: string) => Promise<void>;
  readFile: (
    workspaceId: string,
    projectId: string,
    path: string,
  ) => Promise<string | null>;
  writeFile: (projectId: string, path: string, content: string) => void;
  persistFile: (
    workspaceId: string,
    projectId: string,
    path: string,
  ) => Promise<boolean>;
  createFile: (
    workspaceId: string,
    projectId: string,
    path: string,
    content?: string,
  ) => Promise<boolean>;
  deleteFile: (
    workspaceId: string,
    projectId: string,
    path: string,
  ) => Promise<boolean>;
  renameFile: (
    workspaceId: string,
    projectId: string,
    from: string,
    to: string,
  ) => Promise<boolean>;
  /**
   * Apply a server-originated file change (agent server tools poke the realtime
   * channel). Pulls fresh content for an open file, or drops a deleted file.
   * Skips files with unsaved local edits to avoid clobbering the user's buffer.
   */
  applyRemoteFileUpdate: (
    workspaceId: string,
    projectId: string,
    path: string,
    deleted?: boolean,
  ) => Promise<void>;

  fetchJobs: (workspaceId: string, projectId: string) => Promise<void>;
  saveJob: (
    workspaceId: string,
    projectId: string,
    job: Partial<DbtJobItem> & { name: string },
    jobId?: string,
  ) => Promise<DbtJobItem | null>;
  deleteJob: (
    workspaceId: string,
    projectId: string,
    jobId: string,
  ) => Promise<boolean>;
  triggerJob: (
    workspaceId: string,
    projectId: string,
    jobId: string,
  ) => Promise<string | null>;
  retryRun: (
    workspaceId: string,
    projectId: string,
    runId: string,
    jobId?: string,
  ) => Promise<string | null>;

  fetchRuns: (
    workspaceId: string,
    projectId: string,
    jobId?: string,
  ) => Promise<void>;
  fetchRunDetails: (
    workspaceId: string,
    projectId: string,
    runId: string,
  ) => Promise<DbtRunDetails | null>;
  cancelRun: (
    workspaceId: string,
    projectId: string,
    runId: string,
  ) => Promise<boolean>;
  /** Fetch a run artifact and trigger a browser download. */
  downloadRunArtifact: (
    workspaceId: string,
    projectId: string,
    runId: string,
    kind: DbtArtifactKind,
  ) => Promise<boolean>;

  compileModel: (
    workspaceId: string,
    projectId: string,
    select: string | undefined,
    environment?: string,
    defer?: boolean,
  ) => Promise<DbtCompileResult | null>;
  runModel: (
    workspaceId: string,
    projectId: string,
    select: string,
    environment?: string,
    defer?: boolean,
  ) => Promise<DbtRunModelResult | null>;
  runCommand: (
    workspaceId: string,
    projectId: string,
    command: string,
    environment?: string,
    defer?: boolean,
  ) => Promise<DbtCommandRunResult | null>;
  fetchLineage: (
    workspaceId: string,
    projectId: string,
  ) => Promise<DbtLineage | null>;

  openProjectSettings: (projectId: string) => void;
  closeProjectSettings: () => void;
  openCreateProject: (mode?: "blank" | "github") => void;
  closeCreateProject: () => void;

  reset: () => void;
}

type DbtStore = DbtState & DbtActions;

const initialState: DbtState = {
  projects: [],
  projectsLoaded: false,
  activeProjectId: null,
  filePathsByProject: {},
  filesByProject: {},
  jobsByProject: {},
  runsByProject: {},
  runsByJob: {},
  runDetails: {},
  gitStatusByProject: {},
  settingsProjectId: null,
  createProjectOpen: false,
  createProjectMode: "blank",
  loading: {},
  error: {},
};

function errMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Encode a dbt file path for use in a URL while preserving the "/" separators.
 * `encodeURI` leaves `#`, `?`, `&`, `+` unescaped, which would corrupt the
 * request for paths containing those characters — so encode each segment.
 */
function encodeDbtPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Refresh the working-tree git status for a repo-bound project after a file
 * write. Fire-and-forget: keeps the "Commit & push (N)" badge in sync when the
 * agent (or the editor) creates/modifies/deletes/renames files. No-op for
 * projects without a repo binding (the status endpoint would 400).
 */
function refreshGitStatusForRepoProject(
  get: () => DbtStore,
  workspaceId: string,
  projectId: string,
): void {
  const project = get().projects.find(p => p._id === projectId);
  if (project?.repo) void get().fetchGitStatus(workspaceId, projectId);
}

export const useDbtStore = create<DbtStore>()(
  immer((set, get) => ({
    ...initialState,

    fetchProjects: async workspaceId => {
      set(state => {
        state.loading.projects = true;
        state.error.projects = null;
      });
      try {
        const response = await apiClient.get<{
          success: boolean;
          projects: DbtProjectItem[];
        }>(`/workspaces/${workspaceId}/dbt/projects`);
        set(state => {
          const projects = response.projects ?? [];
          state.projects = projects;
          state.projectsLoaded = true;
          state.loading.projects = false;
          // Keep a valid selection: clear if the active project disappeared,
          // and default to the first project when nothing is selected yet.
          const stillExists =
            state.activeProjectId &&
            projects.some(p => p._id === state.activeProjectId);
          if (!stillExists) {
            state.activeProjectId = projects[0]?._id ?? null;
          }
        });
      } catch (error) {
        set(state => {
          state.loading.projects = false;
          state.error.projects = errMessage(error, "Failed to load projects");
        });
      }
    },

    setActiveProject: projectId => {
      set(state => {
        state.activeProjectId = projectId;
      });
    },

    createProject: async (workspaceId, payload) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          project: DbtProjectItem;
        }>(`/workspaces/${workspaceId}/dbt/projects`, payload);
        const project = response.project;
        set(state => {
          state.projects.unshift(project);
          state.activeProjectId = project._id;
        });
        return project;
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(error, "Failed to create project");
        });
        return null;
      }
    },

    updateProject: async (workspaceId, projectId, patch) => {
      try {
        const response = await apiClient.patch<{
          success: boolean;
          project: DbtProjectItem;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}`, patch);
        const project = response.project;
        set(state => {
          const idx = state.projects.findIndex(p => p._id === projectId);
          if (idx >= 0) state.projects[idx] = project;
        });
        return project;
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(error, "Failed to update project");
        });
        return null;
      }
    },

    deleteProject: async (workspaceId, projectId) => {
      try {
        await apiClient.delete(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}`,
        );
        set(state => {
          state.projects = state.projects.filter(p => p._id !== projectId);
          delete state.filePathsByProject[projectId];
          delete state.filesByProject[projectId];
          for (const job of state.jobsByProject[projectId] ?? []) {
            delete state.runsByJob[job._id];
          }
          delete state.jobsByProject[projectId];
          delete state.runsByProject[projectId];
          if (state.activeProjectId === projectId) {
            state.activeProjectId = state.projects[0]?._id ?? null;
          }
        });
        return true;
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(error, "Failed to delete project");
        });
        return false;
      }
    },

    fetchGitHubStatus: async workspaceId => {
      try {
        const response = await apiClient.get<
          { success: boolean } & GitHubStatus
        >(`/workspaces/${workspaceId}/dbt/github/status`);
        return {
          appConfigured: response.appConfigured,
          appSlug: response.appSlug,
          devTokenAvailable: response.devTokenAvailable,
          installations: response.installations ?? [],
        };
      } catch {
        return null;
      }
    },

    fetchGitHubRepos: async (workspaceId, installationId) => {
      const response = await apiClient.get<{
        success: boolean;
        repos: GitHubRepoItem[];
      }>(
        `/workspaces/${workspaceId}/dbt/github/repos?installationId=${installationId}`,
      );
      return response.repos ?? [];
    },

    fetchGitHubBranches: async (workspaceId, params) => {
      try {
        const qs = new URLSearchParams({
          owner: params.owner,
          repo: params.repo,
        });
        if (params.installationId !== undefined) {
          qs.set("installationId", String(params.installationId));
        }
        const response = await apiClient.get<{
          success: boolean;
          branches: string[];
        }>(`/workspaces/${workspaceId}/dbt/github/branches?${qs}`);
        return response.branches ?? [];
      } catch {
        return [];
      }
    },

    checkGitHubRepo: async (workspaceId, params) => {
      try {
        const qs = new URLSearchParams({
          owner: params.owner,
          repo: params.repo,
        });
        if (params.branch) qs.set("branch", params.branch);
        if (params.subdirectory) qs.set("subdirectory", params.subdirectory);
        if (params.installationId !== undefined) {
          qs.set("installationId", String(params.installationId));
        }
        const response = await apiClient.get<
          { success: boolean } & GitHubRepoCheck
        >(`/workspaces/${workspaceId}/dbt/github/repo-check?${qs}`);
        return response;
      } catch {
        return null;
      }
    },

    getGitHubInstallUrl: async workspaceId => {
      try {
        const response = await apiClient.get<{ success: boolean; url: string }>(
          `/workspaces/${workspaceId}/dbt/github/install-url`,
        );
        return response.url ?? null;
      } catch {
        return null;
      }
    },

    importProjectFromGitHub: async (workspaceId, payload) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          project: DbtProjectItem;
        }>(`/workspaces/${workspaceId}/dbt/projects/import-github`, payload);
        const project = response.project;
        set(state => {
          state.projects.unshift(project);
          state.activeProjectId = project._id;
        });
        return project;
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(
            error,
            "Failed to import project from GitHub",
          );
        });
        return null;
      }
    },

    syncProjectFromGitHub: async (workspaceId, projectId, options) => {
      try {
        const query = options?.discard ? "?discard=true" : "";
        const response = await apiClient.post<
          { success: boolean; project: DbtProjectItem } & SyncResult
        >(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/sync${query}`,
          {},
        );
        set(state => {
          const idx = state.projects.findIndex(p => p._id === projectId);
          if (idx >= 0) state.projects[idx] = response.project;
          // Drop cached file contents so the editor re-reads synced files.
          delete state.filesByProject[projectId];
        });
        return {
          sha: response.sha,
          added: response.added,
          updated: response.updated,
          deleted: response.deleted,
          skippedLarge: response.skippedLarge ?? [],
          preservedLocal: response.preservedLocal ?? [],
          branch: response.project.repo?.branch,
        };
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(
            error,
            "Failed to sync from GitHub",
          );
        });
        return null;
      }
    },

    fetchGitStatus: async (workspaceId, projectId) => {
      try {
        const response = await apiClient.get<{
          success: boolean;
          status: GitStatus;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/git/status`);
        set(state => {
          state.gitStatusByProject[projectId] = response.status;
        });
        return response.status;
      } catch {
        return null;
      }
    },

    fetchGitDiff: async (workspaceId, projectId, path) => {
      try {
        const response = await apiClient.get<{
          success: boolean;
          diff: GitFileDiff;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/git/diff`, {
          path,
        });
        return response.diff;
      } catch (error) {
        set(state => {
          state.error[`git:${projectId}`] = errMessage(
            error,
            "Failed to load diff",
          );
        });
        return null;
      }
    },

    commitAndPush: async (workspaceId, projectId, message) => {
      try {
        const response = await apiClient.post<
          { success: boolean } & CommitResult
        >(`/workspaces/${workspaceId}/dbt/projects/${projectId}/git/commit`, {
          message,
        });
        await get().fetchGitStatus(workspaceId, projectId);
        return {
          committed: response.committed,
          sha: response.sha,
          branch: response.branch,
          pushed: response.pushed,
        };
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(error, "Failed to commit and push");
        });
        return null;
      }
    },

    generateCommitMessage: async (workspaceId, projectId) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          message: string | null;
        }>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/git/commit-message`,
          {},
        );
        return response.message ?? null;
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(
            error,
            "Failed to generate commit message",
          );
        });
        return null;
      }
    },

    listBranches: async (workspaceId, projectId) => {
      try {
        const response = await apiClient.get<{
          success: boolean;
          branches: string[];
          current: string;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/git/branches`);
        return { branches: response.branches ?? [], current: response.current };
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(error, "Failed to list branches");
        });
        return null;
      }
    },

    createBranch: async (workspaceId, projectId, name) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          project: DbtProjectItem;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/git/branch`, {
          name,
        });
        set(state => {
          const idx = state.projects.findIndex(p => p._id === projectId);
          if (idx >= 0) state.projects[idx] = response.project;
        });
        return response.project;
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(error, "Failed to create branch");
        });
        return null;
      }
    },

    switchBranch: async (workspaceId, projectId, branch) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          project: DbtProjectItem;
        }>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/git/switch-branch`,
          { branch },
        );
        set(state => {
          const idx = state.projects.findIndex(p => p._id === projectId);
          if (idx >= 0) state.projects[idx] = response.project;
          delete state.filesByProject[projectId];
        });
        return response.project;
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(error, "Failed to switch branch");
        });
        return null;
      }
    },

    openPullRequest: async (workspaceId, projectId, payload) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          number: number;
          htmlUrl: string;
        }>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/git/pull-request`,
          payload,
        );
        return { number: response.number, htmlUrl: response.htmlUrl };
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(
            error,
            "Failed to open pull request",
          );
        });
        return null;
      }
    },

    fetchFiles: async (workspaceId, projectId) => {
      set(state => {
        state.loading[`files:${projectId}`] = true;
      });
      try {
        const response = await apiClient.get<{
          success: boolean;
          files: Array<{ path: string }>;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/files`);
        set(state => {
          state.filePathsByProject[projectId] = (response.files ?? []).map(
            file => file.path,
          );
          state.loading[`files:${projectId}`] = false;
        });
      } catch (error) {
        set(state => {
          state.loading[`files:${projectId}`] = false;
          state.error[`files:${projectId}`] = errMessage(
            error,
            "Failed to load files",
          );
        });
      }
    },

    readFile: async (workspaceId, projectId, path) => {
      const existing = get().filesByProject[projectId]?.[path];
      if (existing?.loaded) return existing.content;
      try {
        const response = await apiClient.get<{
          success: boolean;
          file: { path: string; content: string };
        }>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/files/${encodeDbtPath(path)}`,
        );
        const content = response.file?.content ?? "";
        set(state => {
          if (!state.filesByProject[projectId]) {
            state.filesByProject[projectId] = {};
          }
          state.filesByProject[projectId][path] = {
            content,
            dirty: false,
            loaded: true,
          };
        });
        return content;
      } catch (error) {
        set(state => {
          state.error[`file:${projectId}:${path}`] = errMessage(
            error,
            "Failed to read file",
          );
        });
        return null;
      }
    },

    writeFile: (projectId, path, content) => {
      set(state => {
        if (!state.filesByProject[projectId]) {
          state.filesByProject[projectId] = {};
        }
        state.filesByProject[projectId][path] = {
          content,
          dirty: true,
          loaded: true,
        };
        const paths = state.filePathsByProject[projectId];
        if (paths && !paths.includes(path)) {
          paths.push(path);
          paths.sort();
        }
      });
    },

    persistFile: async (workspaceId, projectId, path) => {
      const file = get().filesByProject[projectId]?.[path];
      if (!file) return false;
      try {
        await apiClient.put(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/files/${encodeDbtPath(path)}`,
          { content: file.content },
        );
        set(state => {
          const entry = state.filesByProject[projectId]?.[path];
          if (entry) entry.dirty = false;
        });
        refreshGitStatusForRepoProject(get, workspaceId, projectId);
        return true;
      } catch (error) {
        set(state => {
          state.error[`file:${projectId}:${path}`] = errMessage(
            error,
            "Failed to save file",
          );
        });
        return false;
      }
    },

    createFile: async (workspaceId, projectId, path, content = "") => {
      get().writeFile(projectId, path, content);
      return get().persistFile(workspaceId, projectId, path);
    },

    applyRemoteFileUpdate: async (workspaceId, projectId, path, deleted) => {
      if (deleted) {
        set(state => {
          delete state.filesByProject[projectId]?.[path];
          const paths = state.filePathsByProject[projectId];
          if (paths) {
            state.filePathsByProject[projectId] = paths.filter(p => p !== path);
          }
        });
        return;
      }
      // Don't clobber a dirty buffer the user is editing.
      const entry = get().filesByProject[projectId]?.[path];
      if (entry?.dirty) return;
      try {
        const response = await apiClient.get<{
          success: boolean;
          file: { path: string; content: string };
        }>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/files/${encodeDbtPath(path)}`,
        );
        const content = response.file?.content ?? "";
        set(state => {
          if (!state.filesByProject[projectId]) {
            state.filesByProject[projectId] = {};
          }
          state.filesByProject[projectId][path] = {
            content,
            dirty: false,
            loaded: true,
          };
          const paths = state.filePathsByProject[projectId];
          if (paths && !paths.includes(path)) {
            paths.push(path);
            paths.sort();
          }
        });
      } catch {
        /* best-effort live refresh */
      }
    },

    deleteFile: async (workspaceId, projectId, path) => {
      try {
        await apiClient.delete(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/files/${encodeDbtPath(path)}`,
        );
        set(state => {
          delete state.filesByProject[projectId]?.[path];
          const paths = state.filePathsByProject[projectId];
          if (paths) {
            state.filePathsByProject[projectId] = paths.filter(p => p !== path);
          }
        });
        refreshGitStatusForRepoProject(get, workspaceId, projectId);
        return true;
      } catch (error) {
        set(state => {
          state.error[`file:${projectId}:${path}`] = errMessage(
            error,
            "Failed to delete file",
          );
        });
        return false;
      }
    },

    renameFile: async (workspaceId, projectId, from, to) => {
      try {
        await apiClient.post(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/files/rename`,
          { from, to },
        );
        set(state => {
          const files = state.filesByProject[projectId];
          if (files?.[from]) {
            files[to] = files[from];
            delete files[from];
          }
          const paths = state.filePathsByProject[projectId];
          if (paths) {
            state.filePathsByProject[projectId] = paths
              .map(p => (p === from ? to : p))
              .sort();
          }
        });
        refreshGitStatusForRepoProject(get, workspaceId, projectId);
        return true;
      } catch (error) {
        set(state => {
          state.error[`file:${projectId}:${from}`] = errMessage(
            error,
            "Failed to rename file",
          );
        });
        return false;
      }
    },

    fetchJobs: async (workspaceId, projectId) => {
      try {
        const response = await apiClient.get<{
          success: boolean;
          jobs: DbtJobItem[];
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/jobs`);
        set(state => {
          state.jobsByProject[projectId] = response.jobs ?? [];
        });
      } catch (error) {
        set(state => {
          state.error[`jobs:${projectId}`] = errMessage(
            error,
            "Failed to load jobs",
          );
        });
      }
    },

    saveJob: async (workspaceId, projectId, job, jobId) => {
      try {
        const response = jobId
          ? await apiClient.patch<{ success: boolean; job: DbtJobItem }>(
              `/workspaces/${workspaceId}/dbt/projects/${projectId}/jobs/${jobId}`,
              job,
            )
          : await apiClient.post<{ success: boolean; job: DbtJobItem }>(
              `/workspaces/${workspaceId}/dbt/projects/${projectId}/jobs`,
              job,
            );
        const saved = response.job;
        set(state => {
          const jobs = state.jobsByProject[projectId] ?? [];
          const idx = jobs.findIndex(j => j._id === saved._id);
          if (idx >= 0) jobs[idx] = saved;
          else jobs.push(saved);
          state.jobsByProject[projectId] = jobs;
        });
        return saved;
      } catch (error) {
        set(state => {
          state.error[`jobs:${projectId}`] = errMessage(
            error,
            "Failed to save job",
          );
        });
        return null;
      }
    },

    deleteJob: async (workspaceId, projectId, jobId) => {
      try {
        await apiClient.delete(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/jobs/${jobId}`,
        );
        set(state => {
          state.jobsByProject[projectId] = (
            state.jobsByProject[projectId] ?? []
          ).filter(j => j._id !== jobId);
        });
        return true;
      } catch (error) {
        set(state => {
          state.error[`jobs:${projectId}`] = errMessage(
            error,
            "Failed to delete job",
          );
        });
        return false;
      }
    },

    triggerJob: async (workspaceId, projectId, jobId) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          runId: string;
        }>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/jobs/${jobId}/trigger`,
        );
        // Refresh both the job-scoped list (job view) and the unfiltered list
        // (project-wide Runs view) so whichever is open shows the new run.
        await Promise.all([
          get().fetchRuns(workspaceId, projectId, jobId),
          get().fetchRuns(workspaceId, projectId),
        ]);
        return response.runId ?? null;
      } catch (error) {
        set(state => {
          state.error[`runs:${projectId}`] = errMessage(
            error,
            "Failed to trigger job",
          );
        });
        return null;
      }
    },

    retryRun: async (workspaceId, projectId, runId, jobId) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          runId: string;
        }>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/runs/${runId}/retry`,
        );
        // Refresh both lists: the retry may be triggered from the job view or
        // the project-wide Runs view, and both should reflect the new run.
        await Promise.all([
          jobId
            ? get().fetchRuns(workspaceId, projectId, jobId)
            : Promise.resolve(),
          get().fetchRuns(workspaceId, projectId),
        ]);
        return response.runId ?? null;
      } catch (error) {
        set(state => {
          state.error[`runs:${projectId}`] = errMessage(
            error,
            "Failed to retry run",
          );
        });
        return null;
      }
    },

    fetchRuns: async (workspaceId, projectId, jobId) => {
      try {
        const response = await apiClient.get<{
          success: boolean;
          runs: DbtRunItem[];
        }>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/runs`,
          jobId ? { jobId, limit: "100" } : { limit: "100" },
        );
        set(state => {
          if (jobId) {
            state.runsByJob[jobId] = response.runs ?? [];
          } else {
            state.runsByProject[projectId] = response.runs ?? [];
          }
        });
      } catch (error) {
        set(state => {
          state.error[`runs:${projectId}`] = errMessage(
            error,
            "Failed to load runs",
          );
        });
      }
    },

    fetchRunDetails: async (workspaceId, projectId, runId) => {
      const cursor = get().runDetails[runId]?.logCursor ?? 0;
      try {
        const response = await apiClient.get<{
          success: boolean;
          run: DbtRunDetails;
        }>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/runs/${runId}`,
          { logsSince: String(cursor) },
        );
        const run = response.run;
        // Build the merged value as a plain object OUTSIDE the producer: a
        // reference captured from inside `set` is an immer draft that gets
        // revoked once produce() finalizes, so reading it later throws.
        const previous = get().runDetails[runId];
        const logs = previous
          ? [...previous.logs, ...(run.logs ?? [])]
          : (run.logs ?? []);
        const merged: DbtRunDetails = { ...run, logs };
        set(state => {
          state.runDetails[runId] = merged;
          // Keep the run list row in sync (status/duration changes) in both the
          // project-wide list and the per-job list.
          const { logs: _logs, logCursor: _cursor, ...listItem } = run;
          const syncList = (list: DbtRunItem[] | undefined) => {
            if (!list) return;
            const idx = list.findIndex(r => r._id === runId);
            if (idx >= 0) list[idx] = { ...list[idx], ...listItem };
          };
          syncList(state.runsByProject[projectId]);
          if (run.jobId) syncList(state.runsByJob[run.jobId]);
        });
        return merged;
      } catch (error) {
        set(state => {
          state.error[`run:${runId}`] = errMessage(error, "Failed to load run");
        });
        return null;
      }
    },

    cancelRun: async (workspaceId, projectId, runId) => {
      try {
        await apiClient.post(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/runs/${runId}/cancel`,
        );
        return true;
      } catch (error) {
        set(state => {
          state.error[`run:${runId}`] = errMessage(
            error,
            "Failed to cancel run",
          );
        });
        return false;
      }
    },

    downloadRunArtifact: async (workspaceId, projectId, runId, kind) => {
      const fileNames: Record<DbtArtifactKind, string> = {
        manifest: "manifest.json",
        runResults: "run_results.json",
        catalog: "catalog.json",
        sources: "sources.json",
      };
      try {
        // Artifacts are JSON; apiClient parses them. Re-serialize for download.
        const content = await apiClient.get<unknown>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/runs/${runId}/artifacts/${kind}`,
        );
        const blob = new Blob([JSON.stringify(content, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileNames[kind];
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        return true;
      } catch (error) {
        set(state => {
          state.error[`run:${runId}`] = errMessage(
            error,
            "Failed to download artifact",
          );
        });
        return false;
      }
    },

    compileModel: async (
      workspaceId,
      projectId,
      select,
      environment,
      defer,
    ) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          compile: DbtCompileResult;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/compile`, {
          ...(select ? { select } : {}),
          ...(environment ? { environment } : {}),
          ...(defer ? { defer } : {}),
        });
        return response.compile ?? null;
      } catch (error) {
        return {
          ok: false,
          exitCode: 1,
          logs: [
            {
              ts: new Date().toISOString(),
              level: "error",
              line: errMessage(error, "Compile failed"),
            },
          ],
        };
      }
    },

    runModel: async (workspaceId, projectId, select, environment, defer) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          run: DbtRunModelResult;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/run-select`, {
          select,
          ...(environment ? { environment } : {}),
          ...(defer ? { defer } : {}),
        });
        return response.run ?? null;
      } catch (error) {
        return {
          ok: false,
          exitCode: 1,
          stepResults: [],
          logs: [
            {
              ts: new Date().toISOString(),
              level: "error",
              line: errMessage(error, "Run failed"),
            },
          ],
        };
      }
    },

    runCommand: async (workspaceId, projectId, command, environment, defer) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          result: DbtCommandRunResult;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/command`, {
          command,
          ...(environment ? { environment } : {}),
          ...(defer ? { defer } : {}),
        });
        return response.result ?? null;
      } catch (error) {
        return {
          ok: false,
          exitCode: 1,
          subcommand: "",
          stepResults: [],
          logs: [
            {
              ts: new Date().toISOString(),
              level: "error",
              line: errMessage(error, "Command failed"),
            },
          ],
        };
      }
    },

    fetchLineage: async (workspaceId, projectId) => {
      try {
        const response = await apiClient.get<{
          success: boolean;
          lineage: DbtLineage;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/lineage`);
        return response.lineage ?? null;
      } catch (error) {
        set(state => {
          state.error[`lineage:${projectId}`] = errMessage(
            error,
            "Failed to load lineage",
          );
        });
        return null;
      }
    },

    openProjectSettings: projectId => {
      set(state => {
        state.settingsProjectId = projectId;
      });
    },

    closeProjectSettings: () => {
      set(state => {
        state.settingsProjectId = null;
      });
    },

    openCreateProject: mode => {
      set(state => {
        state.createProjectOpen = true;
        state.createProjectMode = mode ?? "blank";
      });
    },

    closeCreateProject: () => {
      set(state => {
        state.createProjectOpen = false;
        state.createProjectMode = "blank";
      });
    },

    reset: () => set(initialState),
  })),
);
