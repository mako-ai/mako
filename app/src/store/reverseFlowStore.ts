import { create } from "zustand";
import { apiClient } from "../lib/api-client";

export interface ReverseFlowMapping {
  target: string;
  source: {
    column?: string;
    const?: unknown;
    transform?: {
      ops?: string[];
      template?: string;
      lookupMap?: Record<string, string>;
      defaultValue?: unknown;
    };
  };
  required?: boolean;
  onConflict?: "overwrite" | "fill_empty" | "ignore";
}

export interface ReverseFlowSpec {
  source: {
    connectionId: string;
    database?: string;
    query: string;
    primaryKey: string;
  };
  destination: {
    connectorId: string;
    entity: string;
    writeMode: "create" | "update" | "upsert";
    allowCreate: boolean;
    updateFieldStrategy: "overwrite" | "fill_empty" | "ignore";
    match: {
      lookupColumn: string;
      remoteField: string;
      onMultiple: "skip" | "update_first" | "fail";
    };
  };
  mappings: ReverseFlowMapping[];
  incremental?: {
    trackingColumn: string;
    trackingType: "timestamp" | "numeric" | "string";
    lastValue?: string;
  };
  pagination?: {
    mode: "offset" | "keyset";
    keysetColumn?: string;
    keysetDirection?: "asc" | "desc";
  };
  schedule: {
    enabled: boolean;
    cron?: string;
    timezone: string;
  };
  safety: {
    maxRowsPerRun: number;
    dryRunRequiredBeforeActivate: boolean;
    batchSize: number;
  };
}

export interface ReverseFlow {
  id: string;
  _id?: string;
  name: string;
  status: "draft" | "active" | "paused";
  spec: ReverseFlowSpec;
  version: number;
  lastDryRun?: {
    at: string;
    sampleSize: number;
    accepted: number;
    rejected: number;
    ambiguous: number;
    passed: boolean;
  };
  scheduledRun?: {
    nextAt?: string;
    lastAt?: string;
    lastStatus?: "success" | "partial" | "error";
    lastError?: string;
    runCount: number;
    consecutiveFailures: number;
  };
}

export interface ReverseFlowRun {
  _id: string;
  status: "queued" | "running" | "success" | "partial" | "error";
  triggerType: "schedule" | "manual";
  triggeredAt: string;
  completedAt?: string;
  rowsRead: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsSkipped: number;
  rowsFailed: number;
  ambiguous: number;
  rowOutcomes: Array<{
    sourcePk: string;
    status: string;
    remoteId?: string;
    error?: string;
  }>;
}

export interface ReverseFlowDryRunResult {
  rows: Array<{
    sourceRow: Record<string, unknown>;
    payload: Record<string, unknown>;
    match?: { status: string; remoteId?: string; matchCount?: number };
    fieldDiffs?: Array<{
      field: string;
      before: unknown;
      after: unknown;
      willOverwrite: boolean;
    }>;
    outcome: { status: string; error?: string; retryable?: boolean };
  }>;
  summary: {
    sampleSize: number;
    accepted: number;
    rejected: number;
    ambiguous: number;
    passed: boolean;
  };
}

export const DEFAULT_REVERSE_FLOW_SPEC: ReverseFlowSpec = {
  source: { connectionId: "", query: "", primaryKey: "" },
  destination: {
    connectorId: "",
    entity: "leads",
    writeMode: "upsert",
    allowCreate: true,
    updateFieldStrategy: "fill_empty",
    match: { lookupColumn: "email", remoteField: "email", onMultiple: "skip" },
  },
  mappings: [],
  schedule: { enabled: false, timezone: "UTC" },
  safety: {
    maxRowsPerRun: 5000,
    dryRunRequiredBeforeActivate: true,
    batchSize: 200,
  },
};

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

interface ReverseFlowStore {
  flows: ReverseFlow[];
  activeFlow?: ReverseFlow;
  runs: ReverseFlowRun[];
  dryRun?: ReverseFlowDryRunResult;
  loading: boolean;
  error?: string;
  fetchFlows: (workspaceId: string) => Promise<void>;
  fetchFlow: (workspaceId: string, id: string) => Promise<ReverseFlow>;
  createFlow: (
    workspaceId: string,
    input: { name: string; spec: ReverseFlowSpec },
  ) => Promise<ReverseFlow>;
  updateFlow: (
    workspaceId: string,
    id: string,
    input: { name: string; spec: ReverseFlowSpec; reason?: string },
  ) => Promise<ReverseFlow>;
  dryRunFlow: (
    workspaceId: string,
    id: string,
    input?: { spec?: ReverseFlowSpec; sampleSize?: number },
  ) => Promise<ReverseFlowDryRunResult>;
  activateFlow: (workspaceId: string, id: string) => Promise<ReverseFlow>;
  pauseFlow: (workspaceId: string, id: string) => Promise<ReverseFlow>;
  runFlow: (workspaceId: string, id: string) => Promise<void>;
  fetchRuns: (workspaceId: string, id: string) => Promise<ReverseFlowRun[]>;
}

function path(workspaceId: string, suffix = "") {
  return `/workspaces/${workspaceId}/reverse-flows${suffix}`;
}

export const useReverseFlowStore = create<ReverseFlowStore>((set, get) => ({
  flows: [],
  runs: [],
  loading: false,

  async fetchFlows(workspaceId) {
    set({ loading: true, error: undefined });
    try {
      const res = await apiClient.get<ApiResponse<ReverseFlow[]>>(
        path(workspaceId),
      );
      set({ flows: res.data, loading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
    }
  },

  async fetchFlow(workspaceId, id) {
    set({ loading: true, error: undefined });
    const res = await apiClient.get<ApiResponse<ReverseFlow>>(
      path(workspaceId, `/${id}`),
    );
    set({ activeFlow: res.data, loading: false });
    return res.data;
  },

  async createFlow(workspaceId, input) {
    const res = await apiClient.post<ApiResponse<ReverseFlow>>(
      path(workspaceId),
      input,
    );
    set({ activeFlow: res.data, flows: [res.data, ...get().flows] });
    return res.data;
  },

  async updateFlow(workspaceId, id, input) {
    const res = await apiClient.put<ApiResponse<ReverseFlow>>(
      path(workspaceId, `/${id}`),
      input,
    );
    set({
      activeFlow: res.data,
      flows: get().flows.map(flow => (flow.id === id ? res.data : flow)),
    });
    return res.data;
  },

  async dryRunFlow(workspaceId, id, input) {
    const res = await apiClient.post<ApiResponse<ReverseFlowDryRunResult>>(
      path(workspaceId, `/${id}/dry-run`),
      input,
    );
    set({ dryRun: res.data });
    return res.data;
  },

  async activateFlow(workspaceId, id) {
    const res = await apiClient.post<ApiResponse<ReverseFlow>>(
      path(workspaceId, `/${id}/activate`),
    );
    set({ activeFlow: res.data });
    return res.data;
  },

  async pauseFlow(workspaceId, id) {
    const res = await apiClient.post<ApiResponse<ReverseFlow>>(
      path(workspaceId, `/${id}/pause`),
    );
    set({ activeFlow: res.data });
    return res.data;
  },

  async runFlow(workspaceId, id) {
    await apiClient.post<ApiResponse<void>>(path(workspaceId, `/${id}/run`));
  },

  async fetchRuns(workspaceId, id) {
    const res = await apiClient.get<ApiResponse<ReverseFlowRun[]>>(
      path(workspaceId, `/${id}/runs`),
    );
    set({ runs: res.data });
    return res.data;
  },
}));
