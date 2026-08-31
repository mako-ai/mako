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
import { api, unwrapBody } from "../api";
import { getApiBasePath } from "../lib/api-base-path";
import { realtimeClientId } from "../lib/realtime-client-id";
import {
  useConsoleStore,
  hasUnsavedLocalEdits,
  hasBlockedDraftSave,
  hasPendingAgentReview,
} from "./consoleStore";
import { useAppsStore, type AppsBoxState } from "./appsStore";
import { focusAppsTab } from "../apps-runtime/shell";
import { useDashboardStore } from "./dashboardStore";
import { useDbtStore } from "./dbtStore";
import { useNotebookStore } from "./notebookStore";
import { useNotebookTreeStore } from "./notebookTreeStore";
import { focusNotebookTab } from "../notebook-runtime/shell";
import { useNotebookPresenceStore } from "./notebookPresenceStore";
import { computeDashboardStateHash } from "../utils/stateHash";
import { decideRemoteApply } from "./lib/remoteApplyGate";
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
  | {
      type: "chat.ui-intent";
      chatId: string;
      intent: "open_notebook";
      notebookId: string;
      title?: string;
    }
  | { type: "chat.activity"; chatId: string; state: "streaming" | "idle" }
  | {
      type: "app.updated";
      appId: string;
      updatedBy?: string;
      origin:
        | "commit"
        | "merge"
        | "discard"
        | "checkout"
        | "lifecycle"
        | "push";
    }
  | {
      type: "dbt.file.updated";
      projectId: string;
      path: string;
      deleted?: boolean;
      updatedBy: string;
      clientId?: string;
      origin: "agent" | "save";
      /** Draft (uncommitted) edit: only this user's windows should react. */
      forUserId?: string;
    }
  | { type: "dbt.job.updated"; projectId: string; clientId?: string }
  | {
      type: "dbt.run.updated";
      projectId: string;
      runId?: string;
      jobId?: string;
      clientId?: string;
    }
  | { type: "dbt.project.updated"; projectId?: string; clientId?: string }
  | {
      type: "dashboard.updated";
      dashboardId: string;
      version: number;
      updatedBy: string;
      clientId?: string;
      origin: "agent" | "save";
    }
  | {
      type: "notebook.updated";
      notebookId: string;
      version: number;
      updatedBy: string;
      clientId?: string;
      origin: "agent" | "save";
    }
  | {
      type: "notebook.presence";
      notebookId: string;
      clientId: string;
      userId: string;
      userName: string;
      activeCellId?: string | null;
      gone?: boolean;
    }
  | {
      type: "notebook.tree.updated";
    }
  // The (workspace, user) sandbox reported its own state, pushed from inside
  // the box the moment it changed. Applied directly — no refetch.
  | {
      type: "app.box-state";
      userId: string;
      state: AppsBoxState;
    }
  // An agent in this user's chat asked the UI to open an Apps app tab
  // (app_open_app). Scoped to the requesting user.
  | {
      type: "app.open-app";
      userId: string;
      appId: string;
      slug?: string;
      title?: string;
    };

export type RealtimeStatus = "idle" | "connecting" | "open" | "reconnecting";

interface RealtimeState {
  status: RealtimeStatus;
  workspaceId: string | null;
  /** Logged-in user id — filters user-scoped (forUserId) dbt draft events. */
  currentUserId: string | null;
  /** Chat currently open in the chat panel (for chat.ui-intent routing). */
  activeChatId: string | null;
  /** Live agent activity per chat (chat.activity events). */
  chatActivity: Record<string, "streaming" | "idle">;
}

interface RealtimeActions {
  connect: (workspaceId: string) => void;
  disconnect: () => void;
  setActiveChatId: (chatId: string | null) => void;
  setCurrentUserId: (userId: string | null) => void;
  /** Pull authoritative copies of open consoles whose revisions changed. */
  syncRevisions: () => Promise<void>;
}

type RealtimeStore = RealtimeState & RealtimeActions;

// --- module-level connection machinery (not reactive state) ---

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let wakeListenersInstalled = false;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let deferredResyncTimer: ReturnType<typeof setTimeout> | null = null;
/** Timestamp of the last frame seen on the SSE stream (any event type). */
let lastEventAt = 0;
/** Timestamp of the last wake-trigger handling (focus/visibility burst). */
let lastWakeAt = 0;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
/** Batch bursts of pokes (e.g. agent patching repeatedly) into one pull. */
const SYNC_DEBOUNCE_MS = 250;
/**
 * Liveness watchdog: the server heartbeats every 15s (realtime.ts
 * HEARTBEAT_INTERVAL_MS), so a stream that has been silent longer than this
 * is dead even though no `error` event fired (NAT/proxy half-close, sleeping
 * machine). 35s tolerates two missed beats. This bounds how long a MISSED
 * poke can leave a window stale with no user interaction: the reconnect's
 * `onopen` runs syncRevisions, so lowering this directly shrinks the
 * worst-case "edited elsewhere but not shown here" window (≈35s + one sweep).
 */
const WATCHDOG_STALE_MS = 35_000;
const WATCHDOG_INTERVAL_MS = 8_000;
/**
 * Wake-trigger staleness: when the user comes back to this window (focus /
 * visibility / pageshow), a stream that hasn't produced a frame within ~1.5
 * heartbeats is treated as dead and reconnected immediately instead of
 * waiting for the slow watchdog. Chrome can freeze background tabs and kill
 * their sockets without firing an `error` event, so `status === "open"`
 * cannot be trusted on wake.
 */
const WAKE_STALE_MS = 25_000;
/** Collapse the burst of focus+visibility events one window switch fires. */
const WAKE_THROTTLE_MS = 1_000;
/**
 * Re-evaluation delay when a remote update was deferred only because the
 * user was mid-typing (keystroke recency / in-flight autosave). Slightly
 * longer than consoleStore's USER_EDIT_RECENCY_MS (3s) so the re-run sees a
 * quiescent tab and can apply cleanly without user interaction.
 */
const DEFERRED_RESYNC_MS = 3_500;

/** Last known writer per console (from pokes) — labels the dirty affordance. */
const lastUpdatedByConsole = new Map<string, string>();

/**
 * Consoles whose most recent poke was an agent (modify_console) edit. The
 * poke only carries metadata; origin is known here but the authoritative
 * content arrives later via the pull (syncRevisions). This bridges the two:
 * when the pulled copy lands, an agent-origin console is routed into the
 * Monaco diff review (beginAgentReview) instead of being applied silently.
 * Consumed on pull; a console already under review stays in review until the
 * user accepts/rejects (tracked by consoleStore.hasPendingAgentReview).
 */
const agentOriginConsoles = new Set<string>();

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
  if (deferredResyncTimer) {
    clearTimeout(deferredResyncTimer);
    deferredResyncTimer = null;
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

    /**
     * A remote update was deferred (banner) only because the user was
     * mid-typing — re-run the sync once the recency window has passed so a
     * now-quiescent tab converges on its own. Without this, a single remote
     * edit landing inside the typing window leaves the tab stale until the
     * user clicks the banner or another event happens to arrive.
     */
    const scheduleDeferredResync = () => {
      if (deferredResyncTimer) return;
      deferredResyncTimer = setTimeout(() => {
        deferredResyncTimer = null;
        void get().syncRevisions();
      }, DEFERRED_RESYNC_MS);
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

      // Remember agent-origin edits even when the tab is NOT open yet (the
      // common create_console → immediate modify_console race: the modify
      // poke can land while openConsoleFromServer is still fetching). The
      // reconcile after the tab opens uses this + lastDraftOrigin to route
      // the pulled copy into the diff review instead of a silent apply.
      if (event.origin === "agent") {
        agentOriginConsoles.add(event.consoleId);
      }

      const tab = useConsoleStore.getState().tabs[event.consoleId];
      if (!tab) return; // not open yet — openConsoleFromServer reconciles

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
      if (!workspaceId) return;

      // A server-executed create_notebook ran: refresh the explorer list so the
      // new notebook appears, and open it in the editor (the client tool that
      // used to do this no longer runs now that notebook tools are
      // server-executed).
      if (event.intent === "open_notebook") {
        const nb = useNotebookStore.getState();
        void nb.loadNotebooks();
        focusNotebookTab(event.notebookId, event.title || "Untitled notebook");
        return;
      }

      if (event.intent !== "open_console") return;
      const consoleStore = useConsoleStore.getState();
      void (async () => {
        if (consoleStore.tabs[event.consoleId]) {
          consoleStore.setActiveTab(event.consoleId);
        } else {
          await consoleStore.openConsoleFromServer(
            workspaceId,
            event.consoleId,
          );
        }
        // Pokes for this console may have arrived before the tab existed
        // (create → immediate modify). Reconcile against the server now so a
        // dropped poke does not leave the freshly opened tab on stale
        // create-time content.
        void get().syncRevisions();
      })();
    };

    // Apps (git-backed): any durable change (agent turn, WIP flush, merge)
    // pokes open windows; the store refetches from the API (git is the
    // authority, so a refetch is always safe — openFile preserves dirty local
    // edits and only refreshes clean buffers).
    const handleAppUpdated = (
      event: Extract<RealtimeEvent, { type: "app.updated" }>,
    ) => {
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      const v2 = useAppsStore.getState();
      // Explorer list (titles, new/deleted apps).
      void v2.fetchApps(workspaceId);
      if (event.origin === "lifecycle") return;
      // §10 monorepo: appId "" = workspace-wide (a workspace worktree
      // changed; it may span apps) — refresh every app this window has
      // loaded. A non-empty appId scopes to that app as before.
      const appIds = event.appId ? [event.appId] : Object.keys(v2.filesByApp);
      for (const appId of appIds) {
        // Only refresh heavier per-app state when this window has it loaded.
        if (v2.filesByApp[appId]) {
          void v2.fetchFiles(workspaceId, appId);
          void v2.fetchStatus(workspaceId, appId);
        }
        if (v2.branchesByApp[appId]) {
          void v2.fetchBranches(workspaceId, appId);
        }
        const selected = v2.selectedFile[appId];
        if (selected) {
          const entry = v2.fileContents[`${appId}\u0000${selected}`];
          if (entry && !entry.dirty) {
            void v2.openFile(workspaceId, appId, selected);
          }
        }
      }
    };

    // User-scoped dbt events (drafts, checkouts) carry forUserId: they only
    // concern the acting user's windows — a draft is invisible to everyone
    // else, so other users must not react (or even refetch).
    const isForAnotherUser = (forUserId?: string): boolean =>
      Boolean(forUserId && forUserId !== get().currentUserId);

    // Server-executed dbt file mutation tools: pull the fresh file content (or
    // drop a deleted file) for OPEN dbt projects. Echo-suppressed by clientId;
    // draft edits (forUserId) only apply to the author's windows.
    const handleDbtFileUpdated = (
      event: Extract<RealtimeEvent, { type: "dbt.file.updated" }>,
    ) => {
      if (event.clientId && event.clientId === realtimeClientId) return;
      if (isForAnotherUser(event.forUserId)) return;
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      const dbt = useDbtStore.getState();
      // Only touch projects this window has loaded.
      if (!dbt.filePathsByProject[event.projectId]) return;
      void dbt.applyRemoteFileUpdate(
        workspaceId,
        event.projectId,
        event.path,
        event.deleted,
      );
    };

    const handleDbtJobUpdated = (
      event: Extract<RealtimeEvent, { type: "dbt.job.updated" }>,
    ) => {
      if (event.clientId && event.clientId === realtimeClientId) return;
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      const dbt = useDbtStore.getState();
      if (!dbt.projects.some(p => p._id === event.projectId)) return;
      void dbt.fetchJobs(workspaceId, event.projectId);
    };

    const handleDbtRunUpdated = (
      event: Extract<RealtimeEvent, { type: "dbt.run.updated" }>,
    ) => {
      if (event.clientId && event.clientId === realtimeClientId) return;
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      const dbt = useDbtStore.getState();
      if (!dbt.projects.some(p => p._id === event.projectId)) return;
      void dbt.fetchRuns(workspaceId, event.projectId);
      if (event.jobId) {
        void dbt.fetchRuns(workspaceId, event.projectId, event.jobId);
      }
    };

    const handleDbtProjectUpdated = (
      event: Extract<RealtimeEvent, { type: "dbt.project.updated" }>,
    ) => {
      if (event.clientId && event.clientId === realtimeClientId) return;
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      // Refresh the project list lazily — only when the dbt surface was used.
      if (!useDbtStore.getState().projectsLoaded) return;
      void useDbtStore.getState().fetchProjects(workspaceId);
    };

    // Server-persisted dashboard saves/restores (draft/published model): pull
    // the authoritative dashboard for an OPEN dashboard when its version
    // advances — but NEVER clobber a user mid-edit. Skips the reload if this
    // tab is editing or holds unsaved local changes (their work wins until they
    // save/discard); echo-suppressed by clientId; stale events ignored.
    const handleDashboardUpdated = (
      event: Extract<RealtimeEvent, { type: "dashboard.updated" }>,
    ) => {
      if (event.clientId && event.clientId === realtimeClientId) return;
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      const ds = useDashboardStore.getState();
      const open = ds.openDashboards[event.dashboardId];
      if (!open) return; // not open here — explorer/canvas refreshes lazily
      if ((open.version ?? 0) >= event.version) return; // stale / own echo
      if (ds.editingDashboards[event.dashboardId]) return; // don't stomp editor
      const savedHash = ds.savedStateHashes[event.dashboardId];
      if (
        savedHash !== undefined &&
        computeDashboardStateHash(open) !== savedHash
      ) {
        return; // unsaved local changes — preserve them
      }
      void ds.reloadDashboard(workspaceId, event.dashboardId);
    };

    // Notebook document changed (human or agent save): pull the authoritative
    // notebook for an OPEN notebook when its version advances (a tab that is
    // mid-save is skipped so it never stomps an in-flight local edit); if the
    // notebook isn't open here, refresh the explorer list so new notebooks
    // appear. Echo-suppressed by clientId.
    const handleNotebookUpdated = (
      event: Extract<RealtimeEvent, { type: "notebook.updated" }>,
    ) => {
      if (event.clientId && event.clientId === realtimeClientId) return;
      const nb = useNotebookStore.getState();
      const open = nb.openNotebooks[event.notebookId];
      if (!open) {
        void nb.loadNotebooks();
        return;
      }
      if ((open.version ?? 0) >= event.version) return; // stale / own echo
      void nb.reloadOpenNotebook(event.notebookId);
    };

    const handleNotebookPresence = (
      event: Extract<RealtimeEvent, { type: "notebook.presence" }>,
    ) => {
      const presence = useNotebookPresenceStore.getState();
      if (event.gone) {
        presence.remove(event.notebookId, event.clientId);
        return;
      }
      presence.touch(event.notebookId, {
        clientId: event.clientId,
        userId: event.userId,
        userName: event.userName,
        activeCellId: event.activeCellId ?? null,
      });
    };

    const handleNotebookTreeUpdated = () => {
      const ws = get().workspaceId;
      if (ws) void useNotebookTreeStore.getState().refresh(ws);
    };

    const handleBoxState = (
      event: Extract<RealtimeEvent, { type: "app.box-state" }>,
    ) => {
      useAppsStore.getState().applyBoxState(event.userId, event.state);
    };

    const handleOpenApp = (
      event: Extract<RealtimeEvent, { type: "app.open-app" }>,
    ) => {
      // The user's own agent asked the UI to show an app. Scoped to the
      // requesting user — a teammate's agent must not steal this focus.
      const me = get().currentUserId;
      if (!me || event.userId !== me) return;
      focusAppsTab(event.appId, event.title ?? event.slug ?? "App", event.slug);
    };

    const handleEvent = (event: RealtimeEvent) => {
      switch (event.type) {
        case "console.updated":
          handleConsoleUpdated(event);
          break;
        case "app.updated":
          handleAppUpdated(event);
          break;
        case "app.box-state":
          handleBoxState(event);
          break;
        case "app.open-app":
          handleOpenApp(event);
          break;
        case "dashboard.updated":
          handleDashboardUpdated(event);
          break;
        case "notebook.updated":
          handleNotebookUpdated(event);
          break;
        case "notebook.tree.updated":
          handleNotebookTreeUpdated();
          break;
        case "notebook.presence":
          handleNotebookPresence(event);
          break;
        case "dbt.file.updated":
          handleDbtFileUpdated(event);
          break;
        case "dbt.job.updated":
          handleDbtJobUpdated(event);
          break;
        case "dbt.run.updated":
          handleDbtRunUpdated(event);
          break;
        case "dbt.project.updated":
          handleDbtProjectUpdated(event);
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
          // Agent turn finished: reconcile open consoles. Tool-agnostic
          // catch-all for any console.updated poke missed during the turn
          // (SSE blip, poke-before-tab-open race) and for detached
          // server-side runs that completed while this window was attached.
          if (event.state === "idle" && event.chatId === get().activeChatId) {
            scheduleSync();
          }
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

    const stopWatchdog = () => {
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
    };

    // Detect silently-dead connections (no `error` event ever fires for a
    // NAT/proxy half-close): if nothing — message, ping, hello — arrived
    // within the stale window while we believe the stream is open, drop the
    // socket and reconnect. The reconnect's `onopen` runs syncRevisions, so
    // missed pokes are repaired by the normal poke-then-pull reconciliation.
    const startWatchdog = () => {
      if (watchdogTimer) return;
      watchdogTimer = setInterval(() => {
        if (!eventSource) return;
        if (get().status !== "open") return;
        if (Date.now() - lastEventAt <= WATCHDOG_STALE_MS) return;
        eventSource.close();
        eventSource = null;
        scheduleReconnect();
      }, WATCHDOG_INTERVAL_MS);
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
        lastEventAt = Date.now();
        set(state => {
          state.status = "open";
        });
        // Reconnect is a refetch, not a replay: reconcile everything the
        // window has open against current server revisions.
        void get().syncRevisions();
      };

      source.addEventListener("message", (e: MessageEvent) => {
        if (eventSource !== source) return;
        lastEventAt = Date.now();
        try {
          handleEvent(JSON.parse(e.data) as RealtimeEvent);
        } catch {
          // Malformed event — the next revision sync corrects any gap.
        }
      });

      // Liveness only — these carry no payload the store consumes.
      source.addEventListener("ping", () => {
        if (eventSource !== source) return;
        lastEventAt = Date.now();
      });
      source.addEventListener("hello", () => {
        if (eventSource !== source) return;
        lastEventAt = Date.now();
      });

      source.onerror = () => {
        if (eventSource !== source) return;
        source.close();
        eventSource = null;
        scheduleReconnect();
      };
    };

    /**
     * The user came back to this window. IMPORTANT: `visibilitychange` alone
     * is NOT enough — two side-by-side windows are both permanently
     * "visible", so switching between them never fires it. Window `focus` is
     * the trigger that matches how people actually multi-window;
     * `pageshow`/`resume` cover BFCache restores and unfrozen tabs.
     */
    const wake = () => {
      const now = Date.now();
      // One window switch fires a burst (focus + visibilitychange); the
      // first one does the work.
      if (now - lastWakeAt < WAKE_THROTTLE_MS) return;
      lastWakeAt = now;

      const { workspaceId, status } = get();
      if (!workspaceId) return;

      const streamSilentMs = now - lastEventAt;
      if (status === "open" && eventSource && streamSilentMs <= WAKE_STALE_MS) {
        // Connection looks healthy; revisions may still have moved while we
        // were backgrounded (throttled timers) — reconcile.
        void get().syncRevisions();
      } else {
        // Stream missing, mid-backoff, or silent past ~1.5 heartbeats.
        // `status === "open"` is NOT trustworthy here: Chrome freezes
        // background tabs and can drop their sockets without an `error`
        // event. Reconnect now; `onopen` runs the revision sync.
        clearTimers();
        reconnectAttempt = 0;
        openConnection(workspaceId);
      }
    };

    const installWakeListeners = () => {
      if (wakeListenersInstalled) return;
      wakeListenersInstalled = true;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") wake();
      });
      window.addEventListener("focus", wake);
      window.addEventListener("pageshow", wake);
      // Page Lifecycle API: fired when Chrome unfreezes a frozen tab.
      document.addEventListener("resume", wake);
    };

    return {
      status: "idle",
      workspaceId: null,
      currentUserId: null,
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
        installWakeListeners();
        startWatchdog();
        openConnection(workspaceId);
      },

      disconnect: () => {
        clearTimers();
        stopWatchdog();
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

      setCurrentUserId: userId => {
        set(state => {
          state.currentUserId = userId;
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
          const res = unwrapBody(
            await api.POST(
              "/api/workspaces/{workspaceId}/consoles/revisions-sync",
              { params: { path: { workspaceId } }, body: { revisions } },
            ),
          ) as ConsoleRevisionsSyncResponse;
          if (!res.success) return;

          const store = useConsoleStore.getState();
          for (const entry of res.changed) {
            const tab = store.tabs[entry.id];

            // An agent edit can also RENAME the console (modify_console title).
            // Patch the sidebar tree node by id IN PLACE (no full refetch, so
            // no loading skeletons or layout shift) — the Apollo-style
            // "update entity by id" pattern. tab.title here is the pre-apply
            // value, so a real rename is detected before it is applied below.
            if (entry.name && tab && entry.name !== tab.title) {
              useConsoleTreeStore
                .getState()
                .applyRemoteRename(workspaceId, entry.id, entry.name);
            }

            // Agent (modify_console) edits surface as a Monaco Accept/Reject
            // diff instead of being applied silently. Route the pulled copy
            // into the review when:
            //   - the latest live poke for this console was the agent's, OR
            //   - the console is already mid-review (cumulative agent edits /
            //     unrelated re-syncs keep refreshing the diff, never the
            //     buffer), OR
            //   - the synced copy itself says the last write was the agent's
            //     (reconnect/reload after a MISSED poke — the durable signal).
            // beginAgentReview no-ops when the proposed content already
            // matches the tab, so non-content bumps never spuriously trigger.
            const isAgentEdit =
              agentOriginConsoles.has(entry.id) ||
              hasPendingAgentReview(entry.id) ||
              entry.lastDraftOrigin === "agent";
            if (isAgentEdit) {
              agentOriginConsoles.delete(entry.id);
              store.beginAgentReview(entry);
              continue;
            }

            const decision = decideRemoteApply({
              tabExists: Boolean(tab),
              tabRevision: tab?.draftRevision,
              entryRevision: entry.draftRevision,
              contentMatches: tab?.content === entry.content,
              unsavedLocalEdits: hasUnsavedLocalEdits(entry.id),
            });
            switch (decision) {
              case "skip":
                break;
              case "fast-forward":
                // Server content already matches this tab (echoed write from
                // another tab, run-artifact revision bump, …). Fast-forward
                // revision/metadata WITHOUT touching the Monaco buffer — it
                // may be ahead by keystrokes that haven't autosaved yet.
                store.fastForwardRemoteConsoleEntry(entry);
                break;
              case "banner":
                // Remote update while this tab holds unsaved local edits
                // (recent keystrokes, queued/blocked autosave, or an unsaved
                // explicit-save delta). Never merge silently — surface the
                // affordance; revision-checked writes backstop the rest.
                store.setRemoteUpdate(entry.id, {
                  draftRevision: entry.draftRevision,
                  updatedBy: lastUpdatedByConsole.get(entry.id),
                  kind: "updated",
                });
                // Transient deferral (typing recency / autosave in flight)
                // without a CONFIRMED conflict: re-evaluate shortly — once
                // the tab is quiescent the decision flips to "apply" and the
                // banner clears itself. Confirmed conflicts (blocked
                // autosave after a real 409, or unsaved explicit-save
                // deltas) wait for the user instead of polling.
                if (
                  !hasBlockedDraftSave(entry.id) &&
                  !(tab?.isSaved ?? false)
                ) {
                  scheduleDeferredResync();
                }
                break;
              case "apply":
                store.applyRemoteConsoleEntry(entry);
                break;
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
