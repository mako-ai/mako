/**
 * AI version/save comments and scheduled-query management for a console.
 */
import { api, unwrapBody } from "../../api";
import type {
  ScheduledQueryRunsResponse,
  ScheduledQueryScheduleResponse,
} from "../../lib/api-types";
import {
  versionManagers,
  versionCommentControllers,
  versionCommentTimers,
} from "./runtime";
import type { ConsoleSlice } from "./slice";

type Keys =
  | "generateVersionComment"
  | "generateSaveComment"
  | "setSchedule"
  | "removeSchedule"
  | "runScheduledNow"
  | "listScheduledRuns";

export const createConsoleScheduleSlice: ConsoleSlice<Keys> = set => ({
  generateVersionComment: (workspaceId, consoleId, versionId, payload) => {
    const DEBOUNCE_MS = 800;

    const existingTimer = versionCommentTimers.get(consoleId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const vm = versionManagers.get(consoleId);
    if (vm) {
      vm.updateVersion(versionId, { aiCommentStatus: "pending" });
    }

    const fire = async () => {
      versionCommentTimers.delete(consoleId);

      const prev = versionCommentControllers.get(consoleId);
      if (prev) prev.abort();

      const controller = new AbortController();
      versionCommentControllers.set(consoleId, controller);

      try {
        const res = unwrapBody(
          await api.POST(
            "/api/workspaces/{workspaceId}/consoles/{id}/version-comment",
            {
              params: { path: { workspaceId, id: consoleId } },
              body: payload,
              signal: controller.signal,
            },
          ),
        ) as {
          success: boolean;
          comment: string | null;
        };

        if (res.success && res.comment && vm) {
          vm.updateVersion(versionId, {
            aiComment: res.comment,
            aiCommentStatus: "done",
          });
        } else if (vm) {
          vm.updateVersion(versionId, { aiCommentStatus: "failed" });
        }
      } catch {
        if (vm) {
          vm.updateVersion(versionId, { aiCommentStatus: "failed" });
        }
      } finally {
        versionCommentControllers.delete(consoleId);
      }
    };

    if (payload.source === "ai") {
      void fire();
    } else {
      const timer = setTimeout(() => void fire(), DEBOUNCE_MS);
      versionCommentTimers.set(consoleId, timer);
    }
  },

  generateSaveComment: async (workspaceId, consoleId, payload, signal) => {
    try {
      const res = unwrapBody(
        await api.POST(
          "/api/workspaces/{workspaceId}/consoles/{id}/version-comment",
          {
            params: { path: { workspaceId, id: consoleId } },
            body: payload,
            signal,
          },
        ),
      ) as {
        success: boolean;
        comment: string | null;
        diff: string | null;
      };
      return res.success
        ? { comment: res.comment ?? null, diff: res.diff ?? null }
        : { comment: null, diff: null };
    } catch {
      return { comment: null, diff: null };
    }
  },

  setSchedule: async (workspaceId, consoleId, input) => {
    try {
      const response = unwrapBody(
        await api.PUT("/api/workspaces/{workspaceId}/consoles/{id}/schedule", {
          params: { path: { workspaceId, id: consoleId } },
          body: input as Record<string, unknown>,
        }),
      ) as ScheduledQueryScheduleResponse;

      if (response.success) {
        set(state => {
          const tab = state.tabs[consoleId];
          if (tab) {
            tab.schedule = response.schedule;
            tab.scheduledRun = response.scheduledRun;
          }
        });
      }

      return response;
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Failed to update schedule",
      } as ScheduledQueryScheduleResponse;
    }
  },

  removeSchedule: async (workspaceId, consoleId) => {
    try {
      const response = unwrapBody(
        await api.DELETE(
          "/api/workspaces/{workspaceId}/consoles/{id}/schedule",
          { params: { path: { workspaceId, id: consoleId } } },
        ),
      ) as { success: boolean; error?: string };

      if (response.success) {
        set(state => {
          const tab = state.tabs[consoleId];
          if (tab) {
            delete tab.schedule;
            if (tab.scheduledRun) {
              delete tab.scheduledRun.nextAt;
            }
          }
        });
      }

      return response;
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Failed to remove schedule",
      };
    }
  },

  runScheduledNow: async (workspaceId, consoleId) => {
    try {
      return unwrapBody(
        await api.POST(
          "/api/workspaces/{workspaceId}/consoles/{id}/schedule/run",
          { params: { path: { workspaceId, id: consoleId } } },
        ),
      ) as ScheduledQueryScheduleResponse;
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : "Failed to run schedule",
      } as ScheduledQueryScheduleResponse;
    }
  },

  listScheduledRuns: async (workspaceId, consoleId, limit = 50) => {
    try {
      return unwrapBody(
        await api.GET(
          "/api/workspaces/{workspaceId}/consoles/{id}/schedule/runs",
          {
            params: {
              path: { workspaceId, id: consoleId },
              query: { limit: String(limit) },
            },
          },
        ),
      ) as ScheduledQueryRunsResponse;
    } catch (e) {
      return {
        success: false,
        runs: [],
        error: e instanceof Error ? e.message : "Failed to load runs",
      } as ScheduledQueryRunsResponse & { error?: string };
    }
  },
});
