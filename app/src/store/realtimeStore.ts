/**
 * Workspace realtime channel (client side)
 *
 * Owns the EventSource connection to GET /api/workspaces/:id/realtime and
 * routes server pokes. Delivery is poke-then-pull: events carry hints
 * (consoleId + draftRevision); when stale we pull authoritative data over
 * normal HTTP (POST /consoles/revisions-sync). Reconnect, tab focus and a
 * received poke all funnel through the same sync path, so lost/duplicate/
 * out-of-order events are self-correcting.
 *
 * NOTE: the EventSource itself is a documented exception to the
 * "stores use apiClient" rule (same as the chat SSE stream) — native
 * EventSource is the transport, cookies carry auth.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";
import { getApiBasePath } from "../lib/api-base-path";
import { realtimeClientId } from "../lib/realtime-client-id";
import { useConsoleStore, hasUnsavedLocalEdits } from "./consoleStore";
import { useConsoleTreeStore } from "./consoleTreeStore";
import type { ConsoleRevisionsSyncResponse } from "../lib/api-types";

/** Mirror of the server's RealtimeEvent union (api realtime.service.ts). */
export type RealtimeEvent =
  | {
      type: "console.updated";
      consoleId: string;
      draftRevision: number;
      name?: string;
      updatedBy: string;
      clientId?: string;
      origin: "draft" | "save" | "agent";
    }
  | { type: "console.deleted"; consoleId: string }
  | {
      type: "console.run.completed";
      consoleId: string;
      status: "success" | "error";
      rowCount?: number;
      durationMs?: number;
      error?: string;
    }
  | {
      type: "chat.ui-intent";
      chatId: string;
      intent: "open_console";
      consoleId: string;
    }
  | { type: "chat.activity"; chatId: string; state: "streaming" | "idle" };

export type RealtimeStatus = "idle" | "connecting" | "open" | "reconnecting";

interface RealtimeState {
  status: RealtimeStatus;
  workspaceId: string | null;
  /** Chat currently open in the chat panel (for chat.ui-intent routing). */
  activeChatId: string | null;
  /** Live agent activity per chat (chat.activity events). */
  chatActivity: Record<string, "streaming" | "idle">;
}

interface RealtimeActions {
  connect: (workspaceId: string) => void;
  disconnect: () => void;
  setActiveChatId: (chatId: string | null) => void;
  /** Pull authoritative copies of open consoles whose revisions changed. */
  syncRevisions: () => Promise<void>;
}

type RealtimeStore = RealtimeState & RealtimeActions;

// --- module-level connection machinery (not reactive state) ---

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityListenerInstalled = false;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/** Batch bursts of pokes (e.g. agent patching repeatedly) into one pull. */
const SYNC_DEBOUNCE_MS = 250;

/** Last known writer per console (from pokes) — labels the dirty affordance. */
const lastUpdatedByConsole = new Map<string, string>();

function isConsoleTabKind(kind: string | undefined): boolean {
  return kind === undefined || kind === "console";
}

function isObjectIdLike(id: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(id);
}

function clearTimers(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = null;
  }
}

export const useRealtimeStore = create<RealtimeStore>()(
  immer((set, get) => {
    const scheduleSync = () => {
      if (syncDebounceTimer) return;
      syncDebounceTimer = setTimeout(() => {
        syncDebounceTimer = null;
        void get().syncRevisions();
      }, SYNC_DEBOUNCE_MS);
    };

    const handleConsoleUpdated = (
      event: Extract<RealtimeEvent, { type: "console.updated" }>,
    ) => {
      // Suppress our own echo — this tab already has the content it wrote.
      if (event.clientId && event.clientId === realtimeClientId) return;

      lastUpdatedByConsole.set(event.consoleId, event.updatedBy);

      // Explicit saves can change names/paths in the explorer tree.
      if (event.origin === "save") {
        const workspaceId = get().workspaceId;
        if (workspaceId) {
          void useConsoleTreeStore.getState().fetchTree(workspaceId);
        }
      }

      const tab = useConsoleStore.getState().tabs[event.consoleId];
      if (!tab) return; // not open in this window — nothing to update
      // A tab that never synced (no draftRevision) counts as revision 0 so
      // even the server's first revision is pulled.
      if ((tab.draftRevision ?? 0) >= event.draftRevision) return; // stale

      scheduleSync();
    };

    const handleConsoleDeleted = (
      event: Extract<RealtimeEvent, { type: "console.deleted" }>,
    ) => {
      const workspaceId = get().workspaceId;
      if (workspaceId) {
        void useConsoleTreeStore.getState().fetchTree(workspaceId);
      }
      const consoleStore = useConsoleStore.getState();
      if (consoleStore.tabs[event.consoleId]) {
        consoleStore.setRemoteUpdate(event.consoleId, {
          draftRevision: Number.MAX_SAFE_INTEGER,
          updatedBy: lastUpdatedByConsole.get(event.consoleId),
          kind: "deleted",
        });
      }
    };

    const handleRunCompleted = (
      event: Extract<RealtimeEvent, { type: "console.run.completed" }>,
    ) => {
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;

      // The run bumped the console's draftRevision (the artifact is part of
      // replicated draft state). Pull any content/revision change through
      // the normal guarded sync path — NEVER fast-forward the revision base
      // out-of-band, or the Monaco buffer ends up permanently stale.
      scheduleSync();

      // Separately, pull the persisted run artifact and render it through
      // the existing results-panel pipeline (same events the client
      // run_console used). The agent runs queries fast: this event often
      // races the tab being opened by the create/open intent, so wait
      // briefly for the tab.
      void (async () => {
        for (
          let attempt = 0;
          attempt < 10 && !useConsoleStore.getState().tabs[event.consoleId];
          attempt++
        ) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (!useConsoleStore.getState().tabs[event.consoleId]) return;

        const lastRun = await useConsoleStore
          .getState()
          .fetchConsoleRunArtifact(workspaceId, event.consoleId);
        if (!lastRun) return;
        window.dispatchEvent(
          new CustomEvent("console-execution-result", {
            detail: {
              consoleId: event.consoleId,
              result:
                lastRun.status === "success"
                  ? {
                      results: lastRun.sampleRows ?? [],
                      executedAt: lastRun.at,
                      resultCount: lastRun.rowCount ?? 0,
                      executionTime: lastRun.durationMs,
                      fields: lastRun.fields ?? null,
                      pageInfo: null,
                    }
                  : null,
            },
          }),
        );
      })();
    };

    const handleChatUiIntent = (
      event: Extract<RealtimeEvent, { type: "chat.ui-intent" }>,
    ) => {
      // Only act on intents for the chat this window is actually viewing —
      // other chats replay their intents on reattach (console restore).
      if (!get().activeChatId || event.chatId !== get().activeChatId) return;
      const workspaceId = get().workspaceId;
      if (!workspaceId || event.intent !== "open_console") return;

      const consoleStore = useConsoleStore.getState();
      if (consoleStore.tabs[event.consoleId]) {
        consoleStore.setActiveTab(event.consoleId);
        return;
      }
      void consoleStore.openConsoleFromServer(workspaceId, event.consoleId);
    };

    const handleEvent = (event: RealtimeEvent) => {
      switch (event.type) {
        case "console.updated":
          handleConsoleUpdated(event);
          break;
        case "console.deleted":
          handleConsoleDeleted(event);
          break;
        case "console.run.completed":
          handleRunCompleted(event);
          break;
        case "chat.ui-intent":
          handleChatUiIntent(event);
          break;
        case "chat.activity":
          set(state => {
            state.chatActivity[event.chatId] = event.state;
          });
          break;
      }
    };

    const scheduleReconnect = () => {
      if (reconnectTimer) return;
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      reconnectAttempt += 1;
      const backoff = Math.min(
        RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1),
        RECONNECT_MAX_MS,
      );
      const jitter = backoff * (0.8 + Math.random() * 0.4);
      set(state => {
        state.status = "reconnecting";
      });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        const ws = get().workspaceId;
        if (ws) openConnection(ws);
      }, jitter);
    };

    const openConnection = (workspaceId: string) => {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      set(state => {
        state.status = reconnectAttempt > 0 ? "reconnecting" : "connecting";
      });

      const basePath = getApiBasePath(import.meta.env.VITE_API_URL);
      const prefix = basePath === "/" ? "" : basePath;
      const url = `${prefix}/workspaces/${workspaceId}/realtime?clientId=${encodeURIComponent(realtimeClientId)}`;

      const source = new EventSource(url, { withCredentials: true });
      eventSource = source;

      source.onopen = () => {
        if (eventSource !== source) return;
        reconnectAttempt = 0;
        set(state => {
          state.status = "open";
        });
        // Reconnect is a refetch, not a replay: reconcile everything the
        // window has open against current server revisions.
        void get().syncRevisions();
      };

      source.addEventListener("message", (e: MessageEvent) => {
        if (eventSource !== source) return;
        try {
          handleEvent(JSON.parse(e.data) as RealtimeEvent);
        } catch {
          // Malformed event — the next revision sync corrects any gap.
        }
      });

      source.onerror = () => {
        if (eventSource !== source) return;
        source.close();
        eventSource = null;
        scheduleReconnect();
      };
    };

    const installVisibilityListener = () => {
      if (visibilityListenerInstalled) return;
      visibilityListenerInstalled = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        const { workspaceId, status } = get();
        if (!workspaceId) return;
        if (status === "open") {
          // Connection survived the background period; revisions may not have.
          void get().syncRevisions();
        } else {
          // Skip the remaining backoff — the user is looking at the tab now.
          clearTimers();
          reconnectAttempt = 0;
          openConnection(workspaceId);
        }
      });
    };

    return {
      status: "idle",
      workspaceId: null,
      activeChatId: null,
      chatActivity: {},

      connect: (workspaceId: string) => {
        if (get().workspaceId === workspaceId && eventSource) return;
        clearTimers();
        reconnectAttempt = 0;
        set(state => {
          state.workspaceId = workspaceId;
          state.chatActivity = {};
        });
        installVisibilityListener();
        openConnection(workspaceId);
      },

      disconnect: () => {
        clearTimers();
        reconnectAttempt = 0;
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        set(state => {
          state.status = "idle";
          state.workspaceId = null;
          state.chatActivity = {};
        });
      },

      setActiveChatId: chatId => {
        set(state => {
          state.activeChatId = chatId;
        });
      },

      syncRevisions: async () => {
        const workspaceId = get().workspaceId;
        if (!workspaceId) return;

        const consoleStore = useConsoleStore.getState();
        const revisions: Record<string, number> = {};
        for (const tab of Object.values(consoleStore.tabs)) {
          if (!isConsoleTabKind(tab.kind)) continue;
          if (!isObjectIdLike(tab.id)) continue;
          // Never-synced tabs claim revision 0 so the server's first
          // revision (a fresh draft autosave is revision 1) is returned.
          revisions[tab.id] = tab.draftRevision ?? 0;
        }
        if (Object.keys(revisions).length === 0) return;

        try {
          const res = await apiClient.post<ConsoleRevisionsSyncResponse>(
            `/workspaces/${workspaceId}/consoles/revisions-sync`,
            { revisions },
          );
          if (!res.success) return;

          const store = useConsoleStore.getState();
          for (const entry of res.changed) {
            const tab = store.tabs[entry.id];
            if (!tab) continue;
            if ((tab.draftRevision ?? 0) >= entry.draftRevision) continue;
            if (tab.content === entry.content) {
              // Server content already matches this tab (echoed write from
              // another tab, run-artifact revision bump, …). Fast-forward
              // revision/metadata WITHOUT touching the Monaco buffer — it
              // may be ahead by keystrokes that haven't autosaved yet.
              store.fastForwardRemoteConsoleEntry(entry);
            } else if (hasUnsavedLocalEdits(entry.id)) {
              // Remote update while this tab holds unsaved local edits
              // (recent keystrokes, queued/blocked autosave, or an unsaved
              // explicit-save delta). Never merge silently — surface the
              // affordance; revision-checked writes backstop the rest.
              store.setRemoteUpdate(entry.id, {
                draftRevision: entry.draftRevision,
                updatedBy: lastUpdatedByConsole.get(entry.id),
                kind: "updated",
              });
            } else {
              store.applyRemoteConsoleEntry(entry);
            }
          }
          for (const deletedId of res.deleted) {
            const tab = store.tabs[deletedId];
            // Drafts living only in this window (not yet on the server) are
            // reported as "deleted" by the sync endpoint — ignore those.
            if (!tab || !tab.isSaved) continue;
            store.setRemoteUpdate(deletedId, {
              draftRevision: Number.MAX_SAFE_INTEGER,
              updatedBy: lastUpdatedByConsole.get(deletedId),
              kind: "deleted",
            });
          }
        } catch {
          // Best-effort: the next poke/focus/reconnect tries again.
        }
      },
    };
  }),
);
