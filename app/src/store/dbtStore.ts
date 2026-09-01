/**
 * dbt Store
 *
 * State + API access for the dbt IDE: projects, virtual files, jobs, runs.
 * Mirrors the appStore/flowStore shapes. The agent's client tools mutate
 * through the same writeFile/persistFile path as the editor so UI and agent
 * edits share one code path.
 */

import { create } from "zustand";
import { toErrorMessage as errMessage } from "../api";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";
import { toLoadError, type LoadError } from "../api/result";
import { realtimeClientId } from "../lib/realtime-client-id";
import { onRealtimeEvent } from "./lib/realtime-channel";

export interface DbtEnvironment {
  name: string;
  connectionId: string;
  targetSchema: string;
  threads: number;
  vars?: Record<string, unknown>;
  /**
   * Personal (per-developer) environment: set to the owning user's id when
   * auto-provisioned as that user's private dev target (schema `dbt_<user>`).
   * Selectors hide other users' personal environments.
   */
  ownerUserId?: string;
}

/**
 * Environments the given user may target: shared environments plus their own
 * personal environment (other users' personal targets are hidden).
 */
export function visibleDbtEnvironments(
  environments: DbtEnvironment[] | undefined,
  userId: string | undefined,
): DbtEnvironment[] {
  return (environments ?? []).filter(
    env => !env.ownerUserId || env.ownerUserId === userId,
  );
}

export interface DbtProjectItem {
  _id: string;
  name: string;
  dbtVersion: string;
  environments: DbtEnvironment[];
  defaultEnvironment: string;
  /**
   * Explicit production (defer target) environment. Unset → convention:
   * the env named "prod" when one exists, else the project default.
   */
  prodEnvironment?: string;
  /**
   * The CALLER's saved development environment for this project (per-user
   * setting, persisted by the env pickers). Unset → auto: their personal
   * environment when provisioned, else the project default. Single player:
   * the shared dev default IS the personal target; teams: each user's own.
   */
  myDevEnvironment?: string;
  updatedAt?: string;
  /** Artifact-store key of last prod manifest (Slim CI defer state). */
  lastProdManifestKey?: string;
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
  /**
   * Git branch the run's source tree came from (repo-bound projects).
   * Combined with `workingTreeUserId` it tells WHAT was built: a user's
   * working tree (checkout + uncommitted drafts) vs the committed branch.
   */
  sourceBranch?: string;
  /** Set when the run built this user's working tree (drafts included). */
  workingTreeUserId?: string;
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

export interface DbtCommandRunResult {
  ok: boolean;
  exitCode: number;
  subcommand: string;
  stepResults: DbtStepResult[];
  logs: DbtRunLogLine[];
}

/** Rows a Preview fetches by default — mirrors DBT_PREVIEW_DEFAULT_LIMIT. */
export const DBT_PREVIEW_DEFAULT_LIMIT = 500;

/**
 * Result of `dbt show --output json`. `ok: false` means dbt produced no rows
 * payload (compile error) — `logs` carries the reason. `ok: true` with an
 * empty `rows` is a model that legitimately returned nothing.
 */
export interface DbtPreviewResult {
  ok: boolean;
  exitCode: number;
  /** The `--limit` dbt ran with, so the UI can say when rows were capped. */
  limit: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  node?: string;
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
  /** Project settings drawer (mounted at app root). */
  settingsProjectId: string | null;
  /** New project drawer (mounted at app root). */
  createProjectOpen: boolean;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  /**
   * Structured load failures (status + message) for the fetches that tab
   * views gate on: `projects`, `jobs:<projectId>`, `file:<projectId>:<path>`.
   * Lets views render "not found" / "no access" instead of loading forever.
   */
  loadErrors: Record<string, LoadError>;
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
      /** Production/defer env override; "" clears back to the convention. */
      prodEnvironment?: string;
      dbtVersion?: string;
    },
  ) => Promise<DbtProjectItem | null>;
  deleteProject: (workspaceId: string, projectId: string) => Promise<boolean>;
  /**
   * Idempotently provision the caller's personal (per-developer) environment
   * on a project (schema `dbt_<user>`, same connection as prod). Returns the
   * environment or null on failure.
   */
  ensurePersonalEnvironment: (
    workspaceId: string,
    projectId: string,
  ) => Promise<DbtEnvironment | null>;
  /**
   * Persist the caller's per-user dev environment for a project ("" clears
   * back to Auto). Updates `myDevEnvironment` on the cached project.
   */
  setMyEnvironment: (
    workspaceId: string,
    projectId: string,
    environment: string,
  ) => Promise<boolean>;

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
  runCommand: (
    workspaceId: string,
    projectId: string,
    command: string,
    environment?: string,
    defer?: boolean,
  ) => Promise<DbtCommandRunResult | null>;
  /** Bounded read-only row preview (`dbt show`) for the editor Results grid. */
  previewModel: (
    workspaceId: string,
    projectId: string,
    select: string,
    environment?: string,
    defer?: boolean,
    limit?: number,
  ) => Promise<DbtPreviewResult | null>;
  fetchLineage: (
    workspaceId: string,
    projectId: string,
  ) => Promise<DbtLineage | null>;

  openProjectSettings: (projectId: string) => void;
  closeProjectSettings: () => void;
  openCreateProject: () => void;
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
  settingsProjectId: null,
  createProjectOpen: false,
  loading: {},
  error: {},
  loadErrors: {},
};

/**
 * Encode a dbt file path for use in a URL while preserving the "/" separators.
 * `encodeURI` leaves `#`, `?`, `&`, `+` unescaped, which would corrupt the
 * request for paths containing those characters — so encode each segment.
 */
function encodeDbtPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export const useDbtStore = create<DbtStore>()(
  immer((set, get) => ({
    ...initialState,

    fetchProjects: async workspaceId => {
      set(state => {
        state.loading.projects = true;
        state.error.projects = null;
        delete state.loadErrors.projects;
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
          state.loadErrors.projects = toLoadError(
            error,
            "Failed to load projects",
          );
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
          if (idx >= 0) {
            // PATCH responses don't carry the caller's per-user dev env
            // (list enrichment does) — keep the cached value.
            state.projects[idx] = {
              ...project,
              myDevEnvironment: state.projects[idx].myDevEnvironment,
            };
          }
        });
        return project;
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(error, "Failed to update project");
        });
        return null;
      }
    },

    ensurePersonalEnvironment: async (workspaceId, projectId) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          created: boolean;
          environment: DbtEnvironment;
        }>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/environments/personal`,
          {},
        );
        // Refresh the project so selectors pick up the new environment.
        if (response.created) await get().fetchProjects(workspaceId);
        return response.environment ?? null;
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(
            error,
            "Failed to create personal environment",
          );
        });
        return null;
      }
    },

    setMyEnvironment: async (workspaceId, projectId, environment) => {
      try {
        const response = await apiClient.put<{
          success: boolean;
          myDevEnvironment?: string;
        }>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/my-environment`,
          { environment },
        );
        set(state => {
          const idx = state.projects.findIndex(p => p._id === projectId);
          if (idx >= 0) {
            state.projects[idx].myDevEnvironment = response.myDevEnvironment;
          }
        });
        return true;
      } catch (error) {
        set(state => {
          state.error.projects = errMessage(
            error,
            "Failed to save your dev environment",
          );
        });
        return false;
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
      set(state => {
        delete state.loadErrors[`file:${projectId}:${path}`];
      });
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
          state.loadErrors[`file:${projectId}:${path}`] = toLoadError(
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
          // clientId lets this tab suppress the echo of its own save poke.
          { content: file.content, clientId: realtimeClientId },
        );
        set(state => {
          const entry = state.filesByProject[projectId]?.[path];
          if (entry) entry.dirty = false;
        });
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
          // clientId lets this tab suppress the echo of its own rename pokes.
          { from, to, clientId: realtimeClientId },
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
      set(state => {
        delete state.loadErrors[`jobs:${projectId}`];
      });
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
          state.loadErrors[`jobs:${projectId}`] = toLoadError(
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

    previewModel: async (
      workspaceId,
      projectId,
      select,
      environment,
      defer,
      limit,
    ) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          preview: DbtPreviewResult;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/preview`, {
          select,
          ...(environment ? { environment } : {}),
          ...(defer ? { defer } : {}),
          ...(limit ? { limit } : {}),
        });
        return response.preview ?? null;
      } catch (error) {
        return {
          ok: false,
          exitCode: 1,
          limit: limit ?? DBT_PREVIEW_DEFAULT_LIMIT,
          columns: [],
          rows: [],
          logs: [
            {
              ts: new Date().toISOString(),
              level: "error",
              line: errMessage(error, "Preview failed"),
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

    openCreateProject: () => {
      set(state => {
        state.createProjectOpen = true;
      });
    },

    closeCreateProject: () => {
      set(state => {
        state.createProjectOpen = false;
      });
    },

    reset: () => set(initialState),
  })),
);

// ── Realtime reactions (registered here so the dbt domain owns them) ──
// All echo-suppressed by clientId. User-scoped events (drafts, checkouts)
// carry forUserId: they only concern the acting user's windows — a draft is
// invisible to everyone else, so other users must not react (or even
// refetch).

// Server-executed dbt file mutation tools: pull the fresh file content (or
// drop a deleted file) for OPEN dbt projects.
onRealtimeEvent(
  "dbt.file.updated",
  "dbtStore",
  (event, ctx) => {
    if (event.forUserId && event.forUserId !== ctx.currentUserId) return;
    if (!ctx.workspaceId) return;
    const dbt = useDbtStore.getState();
    // Only touch projects this window has loaded.
    if (!dbt.filePathsByProject[event.projectId]) return;
    void dbt.applyRemoteFileUpdate(
      ctx.workspaceId,
      event.projectId,
      event.path,
      event.deleted,
    );
  },
  { suppressOwnEcho: true },
);

onRealtimeEvent(
  "dbt.job.updated",
  "dbtStore",
  (event, ctx) => {
    if (!ctx.workspaceId) return;
    const dbt = useDbtStore.getState();
    if (!dbt.projects.some(p => p._id === event.projectId)) return;
    void dbt.fetchJobs(ctx.workspaceId, event.projectId);
  },
  { suppressOwnEcho: true },
);

onRealtimeEvent(
  "dbt.run.updated",
  "dbtStore",
  (event, ctx) => {
    if (!ctx.workspaceId) return;
    const dbt = useDbtStore.getState();
    if (!dbt.projects.some(p => p._id === event.projectId)) return;
    void dbt.fetchRuns(ctx.workspaceId, event.projectId);
    if (event.jobId) {
      void dbt.fetchRuns(ctx.workspaceId, event.projectId, event.jobId);
    }
  },
  { suppressOwnEcho: true },
);

onRealtimeEvent(
  "dbt.project.updated",
  "dbtStore",
  (_event, ctx) => {
    if (!ctx.workspaceId) return;
    // Refresh the project list lazily — only when the dbt surface was used.
    if (!useDbtStore.getState().projectsLoaded) return;
    void useDbtStore.getState().fetchProjects(ctx.workspaceId);
  },
  { suppressOwnEcho: true },
);
