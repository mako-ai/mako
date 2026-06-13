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

export interface DbtProjectItem {
  _id: string;
  name: string;
  dbtVersion: string;
  environments: DbtEnvironment[];
  defaultEnvironment: string;
  updatedAt?: string;
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
  trigger: "schedule" | "manual" | "agent";
  triggeredBy: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  stepResults?: DbtStepResult[];
  error?: string;
  createdAt: string;
}

export interface DbtRunDetails extends DbtRunItem {
  logs: DbtRunLogLine[];
  logCursor: number;
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
  /** projectId → sorted file paths (tree source of truth). */
  filePathsByProject: Record<string, string[]>;
  /** projectId → path → file entry. */
  filesByProject: Record<string, Record<string, DbtFileEntry>>;
  /** projectId → jobs. */
  jobsByProject: Record<string, DbtJobItem[]>;
  /** projectId → recent runs (newest first). */
  runsByProject: Record<string, DbtRunItem[]>;
  /** runId → details incl. accumulated logs. */
  runDetails: Record<string, DbtRunDetails>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
}

interface DbtActions {
  fetchProjects: (workspaceId: string) => Promise<void>;
  createProject: (
    workspaceId: string,
    payload: {
      name: string;
      environments: DbtEnvironment[];
      defaultEnvironment: string;
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
    },
  ) => Promise<DbtProjectItem | null>;
  deleteProject: (workspaceId: string, projectId: string) => Promise<boolean>;

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

  compileModel: (
    workspaceId: string,
    projectId: string,
    select: string | undefined,
    environment?: string,
  ) => Promise<DbtCompileResult | null>;
  runModel: (
    workspaceId: string,
    projectId: string,
    select: string,
    environment?: string,
  ) => Promise<DbtRunModelResult | null>;
  fetchLineage: (
    workspaceId: string,
    projectId: string,
  ) => Promise<DbtLineage | null>;

  reset: () => void;
}

type DbtStore = DbtState & DbtActions;

const initialState: DbtState = {
  projects: [],
  projectsLoaded: false,
  filePathsByProject: {},
  filesByProject: {},
  jobsByProject: {},
  runsByProject: {},
  runDetails: {},
  loading: {},
  error: {},
};

function errMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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
          state.projects = response.projects ?? [];
          state.projectsLoaded = true;
          state.loading.projects = false;
        });
      } catch (error) {
        set(state => {
          state.loading.projects = false;
          state.error.projects = errMessage(error, "Failed to load projects");
        });
      }
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
          delete state.jobsByProject[projectId];
          delete state.runsByProject[projectId];
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
      try {
        const response = await apiClient.get<{
          success: boolean;
          file: { path: string; content: string };
        }>(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/files/${encodeURI(path)}`,
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
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/files/${encodeURI(path)}`,
          { content: file.content },
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

    deleteFile: async (workspaceId, projectId, path) => {
      try {
        await apiClient.delete(
          `/workspaces/${workspaceId}/dbt/projects/${projectId}/files/${encodeURI(path)}`,
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
        await get().fetchRuns(workspaceId, projectId, jobId);
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
        await get().fetchRuns(workspaceId, projectId, jobId);
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
          state.runsByProject[projectId] = response.runs ?? [];
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
        let merged: DbtRunDetails | null = null;
        set(state => {
          const previous = state.runDetails[runId];
          const logs = previous
            ? [...previous.logs, ...(run.logs ?? [])]
            : (run.logs ?? []);
          state.runDetails[runId] = { ...run, logs };
          merged = state.runDetails[runId];
          // Keep the run list row in sync (status/duration changes).
          const runs = state.runsByProject[projectId];
          if (runs) {
            const idx = runs.findIndex(r => r._id === runId);
            if (idx >= 0) {
              const { logs: _logs, logCursor: _cursor, ...listItem } = run;
              runs[idx] = { ...runs[idx], ...listItem };
            }
          }
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

    compileModel: async (workspaceId, projectId, select, environment) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          compile: DbtCompileResult;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/compile`, {
          ...(select ? { select } : {}),
          ...(environment ? { environment } : {}),
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

    runModel: async (workspaceId, projectId, select, environment) => {
      try {
        const response = await apiClient.post<{
          success: boolean;
          run: DbtRunModelResult;
        }>(`/workspaces/${workspaceId}/dbt/projects/${projectId}/run-select`, {
          select,
          ...(environment ? { environment } : {}),
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

    reset: () => set(initialState),
  })),
);
