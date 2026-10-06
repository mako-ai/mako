/**
 * Processes — durable agentic business processes (api/src/processes).
 *
 * Read models straight from the API, per workspace: the process list (with
 * run stats), one process's detail + runs, one run's timeline, and the
 * human-request inbox. Views poll while something is live (a run that is not
 * terminal, pending approvals); there is no client-side derivation beyond
 * what the server's `projectRun` already returns.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, toErrorMessage, unwrapBody } from "../api";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_RUN_STATUSES: RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export interface TriggerSpec {
  type: "manual" | "event" | "schedule";
  event?: string;
  cron?: string;
  timezone?: string;
}

export interface WaitingOn {
  kind: "approval" | "task" | "sleep" | "event";
  stepKey: string;
  title: string;
  until?: string;
  event?: string;
  requestId?: string;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelCalls: number;
  toolCalls: number;
}

export interface ProcessRunSummary {
  id: string;
  processId: string;
  number: number;
  status: RunStatus;
  waitingOn: WaitingOn | null;
  versionId: string;
  versionNumber: number;
  trigger: { type: string; by?: string; event?: string };
  input: unknown;
  output: unknown;
  error: { message: string; stepKey?: string } | null;
  usage: RunUsage;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ProcessSummary {
  id: string;
  name: string;
  description: string;
  category: string | null;
  triggers: TriggerSpec[];
  enabled: boolean;
  runs: {
    total: number;
    active: number;
    waiting: number;
    failed: number;
    successRate: number | null;
  };
  lastRun: ProcessRunSummary | null;
}

export interface OutlineItem {
  kind: "step" | "agent" | "approval" | "task" | "wait";
  name: string;
  dynamic: boolean;
}

export interface ProcessDetail {
  id: string;
  name: string;
  description: string;
  category: string | null;
  manifest: {
    triggers: TriggerSpec[];
    tools: Array<{
      name: string;
      effect: "read" | "write" | "destructive";
      description: string;
      connections: string[];
    }>;
    inputSchema: unknown;
  };
  connectionSlots: string[];
  currentVersion: {
    id: string;
    number: number;
    hash: string;
    outline: OutlineItem[];
    source: string;
  };
  versions: Array<{
    id: string;
    number: number;
    hash: string;
    createdAt: string;
  }>;
  installation: { enabled: boolean; bindings: Record<string, string> };
}

export interface StepToolCall {
  tool: string;
  effect: string;
  callKey: string;
  caller: string;
  iteration?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  durationMs?: number;
  reconciled?: boolean;
}

export interface AgentTurnView {
  iteration: number;
  model: string;
  text?: string;
  reasoning?: string;
  toolCalls: Array<{
    callId: string;
    tool: string;
    input: unknown;
    output?: unknown;
    error?: string;
  }>;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  finishReason?: string;
  ts: string;
}

export interface StepView {
  key: string;
  name: string;
  kind: string;
  status: "running" | "waiting" | "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  attempts: number;
  output?: unknown;
  error?: string;
  logs: Array<{ ts: string; message: string; data?: unknown; tool?: string }>;
  artifacts: Array<{
    id: string;
    name: string;
    mimeType: string;
    bytes: number;
  }>;
  tools: StepToolCall[];
  agent?: {
    harness?: string;
    model?: string;
    instructions?: string;
    prompt?: unknown;
    tools?: Array<{ name: string; effect: string }>;
    turns: AgentTurnView[];
    iterations?: number;
    toolCalls?: number;
    usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  };
  human?: { requestId?: string; expiresAt?: string };
  wait?: { until?: string; event?: string; match?: unknown };
  versionIds: string[];
}

export interface JournalEvent {
  id: string;
  ts: string;
  type: string;
  stepKey?: string;
  versionId?: string;
  data: Record<string, unknown>;
}

export interface HumanRequest {
  id: string;
  runId: string;
  processId: string;
  processName: string;
  runNumber: number;
  stepKey: string;
  kind: "approval" | "task";
  title: string;
  description: string | null;
  payload: unknown;
  schema: JsonSchema | null;
  assignees: string[];
  status:
    | "pending"
    | "approved"
    | "rejected"
    | "submitted"
    | "expired"
    | "cancelled";
  response: { data?: unknown; comment?: string; edited?: boolean } | null;
  respondedBy: { id: string; email?: string } | null;
  respondedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  description?: string;
  items?: JsonSchema;
  default?: unknown;
}

export interface RunDetail {
  run: ProcessRunSummary;
  processName: string;
  version: {
    id: string;
    number: number;
    outline: OutlineItem[];
    current: { id: string; number: number } | null;
  };
  steps: StepView[];
  events: JournalEvent[];
  humanRequests: HumanRequest[];
}

const BASE = "/api/workspaces/{workspaceId}/processes" as const;

interface ProcessState {
  processes: Record<string, ProcessSummary[]>;
  pendingCount: Record<string, number>;
  details: Record<string, ProcessDetail>;
  runsByProcess: Record<string, ProcessRunSummary[]>;
  runDetails: Record<string, RunDetail>;
  inbox: Record<string, HumanRequest[]>;
  loading: Record<string, boolean>;
  error: string | null;
}

interface ProcessActions {
  fetchProcesses: (workspaceId: string) => Promise<void>;
  fetchProcess: (workspaceId: string, processId: string) => Promise<void>;
  fetchRuns: (workspaceId: string, processId: string) => Promise<void>;
  fetchRun: (workspaceId: string, runId: string) => Promise<RunDetail | null>;
  fetchInbox: (
    workspaceId: string,
    status?: "pending" | "decided",
  ) => Promise<void>;
  startRun: (
    workspaceId: string,
    processId: string,
    input: unknown,
  ) => Promise<ProcessRunSummary | null>;
  cancelRun: (workspaceId: string, runId: string) => Promise<boolean>;
  retryRun: (workspaceId: string, runId: string) => Promise<boolean>;
  respond: (
    workspaceId: string,
    requestId: string,
    response: {
      decision: "approve" | "reject" | "submit";
      data?: unknown;
      comment?: string;
    },
  ) => Promise<boolean>;
  updateProcess: (
    workspaceId: string,
    processId: string,
    patch: { enabled?: boolean; bindings?: Record<string, string> },
  ) => Promise<boolean>;
  fetchArtifact: (
    workspaceId: string,
    runId: string,
    eventId: string,
  ) => Promise<{ name: string; mimeType: string; content: string } | null>;
  clearError: () => void;
  reset: () => void;
}

const initial: ProcessState = {
  processes: {},
  pendingCount: {},
  details: {},
  runsByProcess: {},
  runDetails: {},
  inbox: {},
  loading: {},
  error: null,
};

export const useProcessStore = create<ProcessState & ProcessActions>()(
  immer((set, get) => {
    const fail = (e: unknown, fallback: string) =>
      set(s => {
        s.error = toErrorMessage(e, fallback);
      });

    return {
      ...initial,

      fetchProcesses: async workspaceId => {
        set(s => {
          s.loading[`list:${workspaceId}`] = true;
        });
        try {
          const body = unwrapBody(
            await api.GET(BASE, { params: { path: { workspaceId } } }),
          ) as { processes?: ProcessSummary[]; pendingRequests?: number };
          set(s => {
            s.processes[workspaceId] = body.processes ?? [];
            s.pendingCount[workspaceId] = body.pendingRequests ?? 0;
          });
        } catch (e) {
          fail(e, "Failed to load processes");
        } finally {
          set(s => {
            s.loading[`list:${workspaceId}`] = false;
          });
        }
      },

      fetchProcess: async (workspaceId, processId) => {
        try {
          const body = unwrapBody(
            await api.GET(`${BASE}/{processId}`, {
              params: { path: { workspaceId, processId } },
            }),
          ) as { process?: ProcessDetail };
          if (body.process) {
            const detail = body.process;
            set(s => {
              s.details[`${workspaceId}:${processId}`] = detail;
            });
          }
        } catch (e) {
          fail(e, "Failed to load process");
        }
      },

      fetchRuns: async (workspaceId, processId) => {
        try {
          const body = unwrapBody(
            await api.GET(`${BASE}/runs`, {
              params: {
                path: { workspaceId },
                query: { processId, limit: 50 },
              },
            }),
          ) as { runs?: ProcessRunSummary[] };
          set(s => {
            s.runsByProcess[`${workspaceId}:${processId}`] = body.runs ?? [];
          });
        } catch (e) {
          fail(e, "Failed to load runs");
        }
      },

      fetchRun: async (workspaceId, runId) => {
        try {
          const body = unwrapBody(
            await api.GET(`${BASE}/runs/{runId}`, {
              params: { path: { workspaceId, runId } },
            }),
          ) as unknown as RunDetail;
          set(s => {
            s.runDetails[runId] = body;
          });
          return body;
        } catch (e) {
          fail(e, "Failed to load run");
          return null;
        }
      },

      fetchInbox: async (workspaceId, status) => {
        try {
          const body = unwrapBody(
            await api.GET(`${BASE}/inbox`, {
              params: {
                path: { workspaceId },
                query: status ? { status } : {},
              },
            }),
          ) as { requests?: HumanRequest[] };
          set(s => {
            s.inbox[workspaceId] = body.requests ?? [];
            s.pendingCount[workspaceId] = (body.requests ?? []).filter(
              r => r.status === "pending",
            ).length;
          });
        } catch (e) {
          fail(e, "Failed to load inbox");
        }
      },

      startRun: async (workspaceId, processId, input) => {
        try {
          const body = unwrapBody(
            await api.POST(`${BASE}/{processId}/runs`, {
              params: { path: { workspaceId, processId } },
              body: { input },
            }),
          ) as { run?: ProcessRunSummary };
          void get().fetchRuns(workspaceId, processId);
          void get().fetchProcesses(workspaceId);
          return body.run ?? null;
        } catch (e) {
          fail(e, "Failed to start run");
          return null;
        }
      },

      cancelRun: async (workspaceId, runId) => {
        try {
          unwrapBody(
            await api.POST(`${BASE}/runs/{runId}/cancel`, {
              params: { path: { workspaceId, runId } },
            }),
          );
          await get().fetchRun(workspaceId, runId);
          return true;
        } catch (e) {
          fail(e, "Failed to cancel run");
          return false;
        }
      },

      retryRun: async (workspaceId, runId) => {
        try {
          unwrapBody(
            await api.POST(`${BASE}/runs/{runId}/retry`, {
              params: { path: { workspaceId, runId } },
            }),
          );
          await get().fetchRun(workspaceId, runId);
          return true;
        } catch (e) {
          fail(e, "Failed to retry run");
          return false;
        }
      },

      respond: async (workspaceId, requestId, response) => {
        try {
          unwrapBody(
            await api.POST(`${BASE}/inbox/{requestId}/respond`, {
              params: { path: { workspaceId, requestId } },
              body: response,
            }),
          );
          await get().fetchInbox(workspaceId);
          return true;
        } catch (e) {
          fail(e, "Failed to submit response");
          return false;
        }
      },

      updateProcess: async (workspaceId, processId, patch) => {
        try {
          const body = unwrapBody(
            await api.PATCH(`${BASE}/{processId}`, {
              params: { path: { workspaceId, processId } },
              body: patch,
            }),
          ) as { process?: ProcessDetail };
          if (body.process) {
            const detail = body.process;
            set(s => {
              s.details[`${workspaceId}:${processId}`] = detail;
            });
          }
          void get().fetchProcesses(workspaceId);
          return true;
        } catch (e) {
          fail(e, "Failed to update process");
          return false;
        }
      },

      fetchArtifact: async (workspaceId, runId, eventId) => {
        try {
          const body = unwrapBody(
            await api.GET(`${BASE}/runs/{runId}/artifacts/{eventId}`, {
              params: { path: { workspaceId, runId, eventId } },
            }),
          ) as {
            artifact?: { name: string; mimeType: string; content: string };
          };
          return body.artifact ?? null;
        } catch (e) {
          fail(e, "Failed to load artifact");
          return null;
        }
      },

      clearError: () =>
        set(s => {
          s.error = null;
        }),

      reset: () => set(() => ({ ...initial })),
    };
  }),
);
