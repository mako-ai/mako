/**
 * Console records and query execution on the server: load, fetch, save,
 * delete, execute, cancel, export.
 */
import { unspecced } from "../../api/unspecced";
import { api, toLoadError, unwrapBody } from "../../api";
import {
  isLocalConnectionId,
  localAgentClient,
} from "../../lib/local-agent-client";
import { computeConsoleStateHash } from "../../utils/stateHash";
import type {
  ConsoleContentResponse,
  ConsoleDeleteResponse,
  ConsoleSaveResponse,
  QueryCancelResponse,
  QueryExecuteResponse,
} from "../../lib/api-types";
import { realtimeClientId } from "../../lib/realtime-client-id";
import { localExecutionIds, cloudSafeConnectionId } from "./runtime";
import type { ConsoleSlice } from "./slice";

type Keys =
  | "loadConsole"
  | "reloadConsole"
  | "fetchConsoleContent"
  | "fetchConsoleDetails"
  | "fetchConsoleExecutions"
  | "openConsoleFromServer"
  | "fetchConsoleRunArtifact"
  | "saveConsole"
  | "createConsoleRecord"
  | "exportQueryResults"
  | "deleteConsole"
  | "executeQuery"
  | "cancelQuery";

export const createConsoleServerSlice: ConsoleSlice<Keys> = (set, get) => ({
  loadConsole: async (workspaceId, consoleId, options) => {
    // Check if console is already loaded. A load-error placeholder tab
    // does not count: fall through and retry the fetch (access may have
    // been granted since, or the failure was transient).
    const existingTab = get().tabs[consoleId];
    if (existingTab && !existingTab.metadata?.loadError) {
      if (options?.openScheduledRuns) {
        get().updateMetadata(consoleId, {
          ...(existingTab.metadata || {}),
          openScheduledRuns: true,
        });
      }
      get().setActiveTab(consoleId);
      return;
    }

    set(state => {
      state.loading[consoleId] = true;
      state.error[consoleId] = null;
    });

    try {
      const res = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/consoles/content", {
          params: { path: { workspaceId }, query: { id: consoleId } },
        }),
      ) as ConsoleContentResponse;

      if (res.success) {
        const content = res.content || "";
        const filePath = res.path || res.name;

        get().openTab(
          {
            id: res.id,
            title: res.name || res.path || "Console",
            content,
            isSaved: res.isSaved ?? !!filePath,
            savedStateHash: res.savedStateHash,
            connectionId: res.connectionId,
            databaseId: res.databaseId,
            databaseName: res.databaseName,
            filePath,
            kind: "console",
            chartSpec: res.chartSpec,
            resultsViewMode: res.resultsViewMode,
            schedule: res.schedule,
            scheduledRun: res.scheduledRun,
            access: res.access,
            workspaceRole: res.workspaceRole,
            owner_id: res.owner_id,
            readOnly: res.readOnly,
            metadata: options?.openScheduledRuns
              ? { openScheduledRuns: true }
              : undefined,
          },
          {
            preserveMissingSavedStateHash:
              res.lastDraftOrigin === "agent" &&
              res.savedStateHash === undefined,
          },
        );
        get().setActiveTab(res.id);
      } else {
        set(state => {
          state.error[consoleId] = "Failed to load console";
        });
        get().openConsoleLoadErrorTab(consoleId, {
          message: "Failed to load console",
        });
      }
    } catch (e) {
      console.error("Failed to load console", e);
      const loadError = toLoadError(e, "Failed to load console");
      set(state => {
        state.error[consoleId] = loadError.message;
      });
      get().openConsoleLoadErrorTab(consoleId, loadError);
    } finally {
      set(state => {
        delete state.loading[consoleId];
      });
    }
  },

  /**
   * Deep links and palette opens must not fail silently: when the console
   * can't be loaded (deleted, other workspace, no access), open a
   * placeholder tab that renders the load error (Editor short-circuits on
   * `metadata.loadError`). The tab reuses the console id so the /c/:id
   * URL sticks and a successful retry replaces it in place.
   */

  reloadConsole: async (workspaceId, consoleId) => {
    try {
      const res = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/consoles/content", {
          params: { path: { workspaceId }, query: { id: consoleId } },
        }),
      ) as ConsoleContentResponse;

      if (res.success) {
        const content = res.content || "";
        const filePath = res.path || res.name;

        get().openTab(
          {
            id: res.id,
            title: res.name || res.path || "Console",
            content,
            isSaved: res.isSaved ?? !!filePath,
            savedStateHash: res.savedStateHash,
            connectionId: res.connectionId,
            databaseId: res.databaseId,
            databaseName: res.databaseName,
            filePath,
            kind: "console",
            chartSpec: res.chartSpec,
            resultsViewMode: res.resultsViewMode,
          },
          {
            preserveMissingSavedStateHash:
              res.lastDraftOrigin === "agent" &&
              res.savedStateHash === undefined,
          },
        );
        get().setActiveTab(res.id);
      }
    } catch {
      // silent
    }
  },

  fetchConsoleContent: async (workspaceId, consoleId, options) => {
    try {
      const res = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/consoles/content", {
          params: { path: { workspaceId }, query: { id: consoleId } },
          signal: options?.signal,
        }),
      ) as ConsoleContentResponse;

      if (res.success) {
        // Saved-ness comes from the SERVER's isSaved flag. The previous
        // `res.path || res.name` inference silently flipped drafts to
        // isSaved=true (name is always set), which permanently disabled
        // their autosave. Legacy docs without the field fall back to
        // path presence (those predate drafts).
        const isSaved = res.isSaved ?? !!res.path;
        const filePath = isSaved ? res.path || res.name : undefined;
        set(state => {
          const tab = state.tabs[consoleId];
          if (tab) {
            tab.content = res.content || "";
            tab.connectionId = res.connectionId;
            tab.databaseId = res.databaseId;
            tab.databaseName = res.databaseName;
            // Canonical: the title is ALWAYS the leaf name from the server.
            // Sidebar/search opens seed the tab with a placeholder (often
            // the full path); reconcile it to the authoritative leaf so the
            // tab strip, breadcrumb and document.title agree.
            if (res.name) tab.title = res.name;
            tab.filePath = filePath;
            tab.access = res.access;
            tab.owner_id = res.owner_id;
            tab.readOnly = res.readOnly;
            tab.schedule = res.schedule;
            tab.scheduledRun = res.scheduledRun;
            tab.version = res.version;
            tab.draftRevision = res.draftRevision ?? 1;
            tab.remoteUpdate = null;
            tab.lastRun = res.lastRun ?? tab.lastRun;
          }
        });

        const savedStateHash =
          res.savedStateHash ??
          (isSaved && res.lastDraftOrigin === "agent"
            ? undefined
            : computeConsoleStateHash(
                res.content || "",
                res.connectionId,
                res.databaseId,
                res.databaseName,
              ));
        get().updateSavedState(consoleId, isSaved, savedStateHash);
      }

      return res.success ? res : null;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        return null;
      }
      console.error("Failed to fetch console content", e);
      return null;
    }
  },

  fetchConsoleDetails: async (workspaceId, consoleId) => {
    try {
      const data = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/consoles/{id}/details", {
          params: { path: { workspaceId, id: consoleId } },
        }),
      ) as {
        success: boolean;
        console?: {
          description?: string;
          ownerDisplayName?: string;
          owner_id?: string;
          access?: string;
          createdAt?: string;
          updatedAt?: string;
          executionCount?: number;
          lastExecutedAt?: string;
        };
      };
      return data.success && data.console ? data.console : null;
    } catch {
      return null;
    }
  },

  fetchConsoleExecutions: async (workspaceId, consoleId, options) => {
    try {
      const limit = options?.limit ?? 10;
      const data = unwrapBody(
        await api.GET(
          "/api/workspaces/{workspaceId}/consoles/{id}/executions",
          {
            params: {
              path: { workspaceId, id: consoleId },
              query: { limit: String(limit) },
            },
          },
        ),
      ) as {
        success: boolean;
        executions?: Array<{
          id: string;
          executedAt: string;
          source: string;
          status: string;
          executionTimeMs: number;
          rowCount: number | null;
          errorType: string | null;
          apiKeyId: string | null;
        }>;
      };
      if (!data.success || !Array.isArray(data.executions)) return [];
      return data.executions.map(execution => ({
        ...execution,
        id: String(execution.id),
        executedAt:
          typeof execution.executedAt === "string"
            ? execution.executedAt
            : new Date(execution.executedAt).toISOString(),
        apiKeyId: execution.apiKeyId ? String(execution.apiKeyId) : null,
      }));
    } catch {
      return [];
    }
  },

  openConsoleFromServer: async (workspaceId, consoleId, options) => {
    const focus = options?.focus !== false;
    if (get().tabs[consoleId]) {
      if (focus) get().setActiveTab(consoleId);
      return;
    }
    try {
      const res = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/consoles/content", {
          params: { path: { workspaceId }, query: { id: consoleId } },
        }),
      ) as ConsoleContentResponse;
      if (!res.success) return;
      // Re-check: the tab may have appeared while we fetched (e.g. the
      // legacy ui-intent poke and the in-band tool result both firing).
      if (get().tabs[consoleId]) {
        if (focus) get().setActiveTab(consoleId);
        return;
      }
      const isSaved = res.isSaved ?? !!res.path;
      get().openTab(
        {
          id: consoleId,
          title: res.name || res.path || "Untitled",
          content: res.content || "",
          connectionId: res.connectionId,
          databaseId: res.databaseId,
          databaseName: res.databaseName,
          isSaved,
          savedStateHash: res.savedStateHash,
          filePath: isSaved ? res.path || res.name : undefined,
          access: res.access,
          workspaceRole: res.workspaceRole,
          owner_id: res.owner_id,
          readOnly: res.readOnly,
          version: res.version,
          draftRevision: res.draftRevision ?? 1,
          lastRun: res.lastRun,
          kind: "console",
        },
        {
          replacePristine: false,
          preserveMissingSavedStateHash:
            res.lastDraftOrigin === "agent" && res.savedStateHash === undefined,
        },
      );
      if (focus) get().setActiveTab(consoleId);
    } catch (e) {
      console.error("Failed to open console from server", e);
    }
  },

  fetchConsoleRunArtifact: async (workspaceId, consoleId) => {
    try {
      const res = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/consoles/content", {
          params: { path: { workspaceId }, query: { id: consoleId } },
        }),
      ) as ConsoleContentResponse;
      if (!res.success) return null;
      // Merge ONLY the run artifact; content/revision replication is
      // handled by the realtime revision sync (single guarded path).
      set(state => {
        const tab = state.tabs[consoleId];
        if (tab && res.lastRun) {
          tab.lastRun = res.lastRun;
        }
      });
      return res.lastRun ?? null;
    } catch (e) {
      console.error("Failed to fetch console run artifact", e);
      return null;
    }
  },

  saveConsole: async (
    workspaceId,
    tabId,
    content,
    path,
    connectionId,
    databaseName,
    databaseId,
    chartSpec,
    resultsViewMode,
    comment,
    access,
  ) => {
    try {
      const cleanPath = path.endsWith(".js") ? path.slice(0, -3) : path;
      // Optimistic concurrency: send the version this tab was loaded
      // from so the server rejects (409) instead of overwriting a
      // concurrent save by someone else. The draft revision rides along
      // so a stale window cannot silently revert agent edits / other
      // tabs' autosaves (those bump draftRevision but not version).
      const expectedVersion = get().tabs[tabId]?.version;
      const expectedDraftRevision = get().tabs[tabId]?.draftRevision;
      const result = await unspecced.request(
        "PUT",
        `/api/workspaces/${workspaceId}/consoles/${tabId}`,
        {
          body: {
            content,
            path: cleanPath,
            connectionId: cloudSafeConnectionId(connectionId),
            databaseName,
            databaseId,
            isSaved: true,
            chartSpec: chartSpec ?? null,
            resultsViewMode,
            comment: comment ?? "",
            access,
            isPrivate: access === undefined ? undefined : access === "private",
            expectedVersion,
            expectedDraftRevision,
            // Realtime sync: identifies this tab so its own
            // console.updated poke is suppressed.
            clientId: realtimeClientId,
          },
        },
      );
      const { response } = result;
      // Every status carries a JSON body the caller branches on (409
      // conflicts, validation errors), so read it whatever the status.
      const raw = response.ok ? result.data : result.error;
      const res = (
        typeof raw === "object" && raw !== null ? raw : {}
      ) as ConsoleSaveResponse;

      if (response.status === 409 && res.error === "conflict") {
        return {
          success: false,
          error: "conflict",
          conflict: res.conflict,
        };
      }

      if (response.status === 409 && res.error === "version_conflict") {
        return {
          success: false,
          error: "version_conflict",
          versionConflict: res.versionConflict,
        };
      }

      if (!response.ok) {
        return {
          success: false,
          error: res.error || "Save failed",
          code: (res as { code?: string }).code,
        };
      }

      if (res.success) {
        const newVersion = res.version;
        const newDraftRevision = res.draftRevision;
        set(state => {
          const tab = state.tabs[tabId];
          if (!tab) return;
          if (typeof newVersion === "number") tab.version = newVersion;
          if (typeof newDraftRevision === "number") {
            tab.draftRevision = newDraftRevision;
            tab.remoteUpdate = null;
          }
        });
        return { success: true, path: cleanPath, version: newVersion };
      }
      return {
        success: false,
        error: res.error || "Save failed",
        code: (res as { code?: string }).code,
      };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Save failed",
      };
    }
  },

  createConsoleRecord: async (workspaceId, payload) => {
    const result = await api.POST("/api/workspaces/{workspaceId}/consoles", {
      params: { path: { workspaceId } },
      body: payload,
    });
    const raw = result.response.ok ? result.data : result.error;
    return {
      status: result.response.status,
      body: (typeof raw === "object" && raw !== null
        ? raw
        : {}) as ConsoleSaveResponse,
    };
  },

  exportQueryResults: async (workspaceId, payload) =>
    unwrapBody(
      await api.POST("/api/workspaces/{workspaceId}/execute/export", {
        params: { path: { workspaceId } },
        body: payload,
        parseAs: "blob",
      }),
    ) as Blob,

  deleteConsole: async (workspaceId, consoleId) => {
    try {
      return unwrapBody(
        await api.DELETE("/api/workspaces/{workspaceId}/consoles/{id}", {
          params: { path: { workspaceId, id: consoleId } },
        }),
      ) as ConsoleDeleteResponse;
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Delete failed",
      };
    }
  },

  executeQuery: async (workspaceId, connectionId, query, options) => {
    try {
      const payload = {
        connectionId,
        query,
        databaseId: options?.databaseId,
        databaseName: options?.databaseName,
        executionId: options?.executionId,
        pageSize: options?.pageSize,
        cursor: options?.cursor,
        mode: "preview" as const,
        source: "console_ui",
        ...(options?.consoleId ? { consoleId: options.consoleId } : {}),
        ...(options?.confirmUnsafe ? { confirmUnsafe: true } : {}),
      };

      const isLocal = isLocalConnectionId(connectionId);
      if (isLocal && options?.executionId) {
        localExecutionIds.add(options.executionId);
      }

      let status: number;
      let res: QueryExecuteResponse;
      if (isLocal) {
        const r = await localAgentClient.postWithStatus<QueryExecuteResponse>(
          "/execute",
          payload,
          { signal: options?.signal, alsoOk: [400, 403] },
        );
        status = r.status;
        res = r.body;
      } else {
        // 400/403 carry a structured error body, so read the raw result
        // rather than throwing on non-2xx.
        const r = await api.POST("/api/workspaces/{workspaceId}/execute", {
          params: { path: { workspaceId } },
          body: payload,
          signal: options?.signal,
        });
        status = r.response.status;
        res = (r.data ?? r.error) as QueryExecuteResponse;
      }

      if (status === 400 || status === 403) {
        return {
          success: false,
          error: res.error || "Execution failed",
          code: res.code,
        };
      }

      return res.success
        ? res
        : { success: false, error: res.error || "Execution failed" };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        return { success: false, error: "Query cancelled" };
      }
      return {
        success: false,
        error: e instanceof Error ? e.message : "Execution failed",
      };
    }
  },

  cancelQuery: async (workspaceId, executionId) => {
    try {
      if (localExecutionIds.has(executionId)) {
        localExecutionIds.delete(executionId);
        return await localAgentClient.post<QueryCancelResponse>(
          "/execute/cancel",
          { executionId },
        );
      }
      return unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/execute/cancel", {
          params: { path: { workspaceId } },
          body: { executionId },
        }),
      ) as QueryCancelResponse;
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Cancel failed",
      };
    }
  },
});
