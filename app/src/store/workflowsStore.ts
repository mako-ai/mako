/**
 * Workflows — what is deployed, the workflows, their runs and their files —
 * keyed by workspace. Everything here is read from the API on demand; runs
 * live in Hatchet and the deploy state on the workspace, so the store only
 * caches what the screens last saw.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrapBody, toErrorMessage as message } from "../api";

export interface WorkflowDeployment {
  liveSha: string | null;
  targetSha: string | null;
  deploying: boolean;
  buildError: string | null;
}

export interface WorkflowRunSummary {
  runId?: string;
  workflowId: string;
  /** True for a run of unmerged branch code. */
  preview: boolean;
  status?: string;
  startedAt?: string;
  durationMs?: number;
  error?: string;
  trigger?: string;
  triggeredBy?: string;
}

export interface WorkflowRunStep {
  step?: string;
  status?: string;
  attempt?: number;
  durationMs?: number;
  output?: string;
  error?: string;
  logs: Array<string | undefined>;
}

export interface WorkflowRun extends WorkflowRunSummary {
  input?: string;
  output?: string;
  steps: WorkflowRunStep[];
}

export interface WorkflowsOverview {
  enabled: boolean;
  /** False when this installation has no Hatchet: the section is hidden. */
  configured: boolean;
  /** False when the workspace has no repository to keep workflow files in. */
  repoLinked: boolean;
  deployment: WorkflowDeployment;
  preview: (WorkflowDeployment & { branch: string }) | null;
  dashboardUrl: string | null;
  workflows?: Array<{ workflowId: string; preview: boolean }>;
  schedules?: Array<{ workflowId: string; cron: string }>;
  recentRuns?: WorkflowRunSummary[];
}

type Result = { ok: boolean; error?: string; runId?: string };

interface WorkflowsState {
  overviewByWorkspace: Record<string, WorkflowsOverview>;
  runsById: Record<string, WorkflowRun>;
  filesByWorkspace: Record<string, string[]>;
  error: string | null;

  fetchOverview: (workspaceId: string) => Promise<void>;
  fetchRun: (workspaceId: string, runId: string) => Promise<void>;
  fetchFiles: (workspaceId: string) => Promise<void>;
  fetchFile: (workspaceId: string, path: string) => Promise<string | null>;
  run: (
    workspaceId: string,
    workflowId: string,
    input: Record<string, unknown>,
    preview: boolean,
  ) => Promise<Result>;
  cancel: (workspaceId: string, runId: string) => Promise<Result>;
  replay: (workspaceId: string, runId: string) => Promise<Result>;
}

/** Preview workflows are registered under this prefix (see the worker). */
const PREVIEW_PREFIX = "preview_";

export const isActiveRun = (status?: string) =>
  status === "RUNNING" || status === "QUEUED";

export const useWorkflowsStore = create<WorkflowsState>()(
  immer(set => {
    const runAction = async (
      workspaceId: string,
      runId: string,
      action: "cancel" | "replay",
    ): Promise<Result> => {
      try {
        unwrapBody(
          await api.POST(
            `/api/workspaces/{workspaceId}/workflows/runs/{id}/${action}`,
            { params: { path: { workspaceId, id: runId } } },
          ),
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: message(e, `Failed to ${action} the run`) };
      }
    };

    return {
      overviewByWorkspace: {},
      runsById: {},
      filesByWorkspace: {},
      error: null,

      fetchOverview: async workspaceId => {
        try {
          const body = unwrapBody(
            await api.GET("/api/workspaces/{workspaceId}/workflows", {
              params: { path: { workspaceId } },
            }),
          ) as unknown as WorkflowsOverview;
          set(s => {
            s.overviewByWorkspace[workspaceId] = body;
            s.error = null;
          });
        } catch (e) {
          set(s => {
            s.error = message(e, "Failed to load workflows");
          });
        }
      },

      fetchRun: async (workspaceId, runId) => {
        try {
          const body = unwrapBody(
            await api.GET("/api/workspaces/{workspaceId}/workflows/runs/{id}", {
              params: { path: { workspaceId, id: runId } },
            }),
          ) as unknown as { run: WorkflowRun };
          set(s => {
            s.runsById[runId] = body.run;
          });
        } catch {
          // The list still shows the run; its detail is retried on the next poll.
        }
      },

      fetchFiles: async workspaceId => {
        try {
          const body = unwrapBody(
            await api.GET("/api/workspaces/{workspaceId}/workflows/files", {
              params: { path: { workspaceId }, query: {} },
            }),
          ) as unknown as { files?: string[] };
          set(s => {
            s.filesByWorkspace[workspaceId] = body.files ?? [];
          });
        } catch {
          // Files are a convenience next to the runs; an empty tree is fine.
        }
      },

      fetchFile: async (workspaceId, path) => {
        try {
          const body = unwrapBody(
            await api.GET("/api/workspaces/{workspaceId}/workflows/files", {
              params: { path: { workspaceId }, query: { path } },
            }),
          ) as unknown as { contents?: string };
          return body.contents ?? "";
        } catch {
          return null;
        }
      },

      run: async (workspaceId, workflowId, input, preview) => {
        try {
          const body = unwrapBody(
            await api.POST(
              "/api/workspaces/{workspaceId}/workflows/{name}/run",
              {
                params: {
                  path: {
                    workspaceId,
                    name: `${preview ? PREVIEW_PREFIX : ""}${workflowId}`,
                  },
                },
                body: { input },
              },
            ),
          ) as unknown as { run?: { run?: { metadata?: { id?: string } } } };
          return { ok: true, runId: body.run?.run?.metadata?.id };
        } catch (e) {
          return { ok: false, error: message(e, "Failed to start the run") };
        }
      },

      cancel: (workspaceId, runId) => runAction(workspaceId, runId, "cancel"),
      replay: (workspaceId, runId) => runAction(workspaceId, runId, "replay"),
    };
  }),
);
