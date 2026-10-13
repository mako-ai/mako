/**
 * Workflows — what is deployed, the workflows, their runs and their files —
 * keyed by workspace. Everything here is read from the API on demand; runs
 * live in Hatchet and the deploy state on the workspace, so the store only
 * caches what the screens last saw.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrapBody, toErrorMessage as message } from "../api";

interface WorkflowDeployment {
  liveSha: string | null;
  targetSha: string | null;
  buildError: string | null;
}

export interface WorkflowRunSummary {
  runId?: string;
  workflowId: string;
  /** A run of the viewer's checkout in their sandbox; it is in no list. */
  sandbox?: boolean;
  status?: string;
  startedAt?: string;
  durationMs?: number;
  error?: string;
  trigger?: string;
}

interface WorkflowRunStep {
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

interface WorkflowsOverview {
  /** False when this installation has no Hatchet: the section is hidden. */
  configured: boolean;
  /** False when the workspace has no repository to keep workflow files in. */
  repoLinked: boolean;
  deployment: WorkflowDeployment;
  /** Where an admin opens the Hatchet dashboard, when the installation has one. */
  dashboardUrl: string | null;
  /** The viewer is an admin: the switches and webhook URLs are theirs. */
  mayChange?: boolean;
  /** `active`: its schedule and webhook are on. `webhookUrl`: for admins; null while off. */
  workflows?: Array<{
    workflowId: string;
    active: boolean;
    webhookUrl?: string | null;
  }>;
  schedules?: Array<{ workflowId: string; cron: string }>;
  recentRuns?: WorkflowRunSummary[];
}

type Result = {
  ok: boolean;
  error?: string;
  /** A run started on main. */
  runId?: string;
  /** A finished sandbox run. */
  run?: WorkflowRun;
};

interface WorkflowsState {
  overviewByWorkspace: Record<string, WorkflowsOverview>;
  runsById: Record<string, WorkflowRun>;
  filesByWorkspace: Record<string, string[]>;
  fetchOverview: (workspaceId: string) => Promise<void>;
  fetchRun: (workspaceId: string, runId: string) => Promise<void>;
  fetchFiles: (workspaceId: string) => Promise<void>;
  run: (
    workspaceId: string,
    workflowId: string,
    input: Record<string, unknown>,
    sandbox: boolean,
  ) => Promise<Result>;
  /** Change what starts a workflow: its Active switch, its webhook. */
  setTriggers: (
    workspaceId: string,
    workflowId: string,
    change: { active?: boolean; webhook?: boolean },
  ) => Promise<Result>;
}

export const isActiveRun = (status?: string) =>
  status === "RUNNING" || status === "QUEUED";

/** One file under `workflows/`, or null when it is not on the branch. */
export async function fetchWorkflowFile(
  workspaceId: string,
  path: string,
): Promise<string | null> {
  try {
    const body = unwrapBody(
      await api.GET("/api/workspaces/{workspaceId}/workflows/files", {
        params: { path: { workspaceId }, query: { path } },
      }),
    ) as { contents?: string };
    return body.contents ?? "";
  } catch {
    return null;
  }
}

export const useWorkflowsStore = create<WorkflowsState>()(
  immer(set => ({
    overviewByWorkspace: {},
    runsById: {},
    filesByWorkspace: {},

    // The three reads keep what the screens last saw when a poll fails: the
    // next poll tries again.
    fetchOverview: async workspaceId => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/workflows", {
            params: { path: { workspaceId } },
          }),
        ) as WorkflowsOverview;
        set(s => {
          s.overviewByWorkspace[workspaceId] = body;
        });
      } catch {
        // See above.
      }
    },

    fetchRun: async (workspaceId, runId) => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/workflows/runs/{id}", {
            params: { path: { workspaceId, id: runId } },
          }),
        ) as { run: WorkflowRun };
        set(s => {
          s.runsById[runId] = body.run;
        });
      } catch {
        // See above.
      }
    },

    fetchFiles: async workspaceId => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/workflows/files", {
            params: { path: { workspaceId }, query: {} },
          }),
        ) as { files?: string[] };
        set(s => {
          s.filesByWorkspace[workspaceId] = body.files ?? [];
        });
      } catch {
        // See above.
      }
    },

    run: async (workspaceId, workflowId, input, sandbox) => {
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/workflows/{name}/run", {
            params: { path: { workspaceId, name: workflowId } },
            body: { input, sandbox },
          }),
        ) as { runId?: string; run?: WorkflowRun };
        return { ok: true, runId: body.runId, run: body.run };
      } catch (e) {
        return { ok: false, error: message(e, "Failed to start the run") };
      }
    },

    setTriggers: async (workspaceId, workflowId, change) => {
      try {
        unwrapBody(
          await api.PUT(
            "/api/workspaces/{workspaceId}/workflows/{name}/triggers",
            {
              params: { path: { workspaceId, name: workflowId } },
              body: change,
            },
          ),
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: message(e, "Failed to change the trigger") };
      }
    },
  })),
);
