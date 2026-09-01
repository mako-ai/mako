/**
 * Typed registry for workspace realtime events.
 *
 * The transport (realtimeStore: EventSource, reconnect, watchdog) parses
 * frames and dispatches them through here; each resource kind registers its
 * reaction NEXT TO ITS OWN STORE (dashboardStore reacts to
 * dashboard.updated, dbtStore to dbt.*, …) instead of the transport file
 * reaching into six stores. `suppressOwnEcho` is the one copy of the
 * clientId echo guard that used to be pasted into every handler.
 *
 * Registration is module-scoped and keyed: registering the same
 * (type, key) again replaces the handler, so Vite HMR re-runs are
 * idempotent. realtimeStore imports the registering store modules for
 * side effects, which guarantees every handler is installed before the
 * first event can arrive.
 */
import { realtimeClientId } from "../../lib/realtime-client-id";
import type { AppsBoxState } from "../appsStore";

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

export type RealtimeEventType = RealtimeEvent["type"];

/** What the transport knows at dispatch time; handlers re-check as needed. */
export interface RealtimeHandlerContext {
  workspaceId: string | null;
  /** Logged-in user id — filters user-scoped (forUserId / userId) events. */
  currentUserId: string | null;
}

export type RealtimeHandler<T extends RealtimeEventType> = (
  event: Extract<RealtimeEvent, { type: T }>,
  ctx: RealtimeHandlerContext,
) => void;

interface Registration {
  handler: RealtimeHandler<RealtimeEventType>;
  suppressOwnEcho: boolean;
}

const registry = new Map<RealtimeEventType, Map<string, Registration>>();

/** This window's own write, echoed back — the tab already has the content. */
export function isOwnEcho(event: { clientId?: string }): boolean {
  return Boolean(event.clientId && event.clientId === realtimeClientId);
}

/**
 * Register a reaction to one event type. `key` names the registration
 * (usually the store's name) so HMR re-runs replace rather than stack.
 * `suppressOwnEcho` drops events whose clientId is this window's own.
 */
export function onRealtimeEvent<T extends RealtimeEventType>(
  type: T,
  key: string,
  handler: RealtimeHandler<T>,
  opts?: { suppressOwnEcho?: boolean },
): void {
  let byKey = registry.get(type);
  if (!byKey) {
    byKey = new Map();
    registry.set(type, byKey);
  }
  byKey.set(key, {
    // The map erases the per-type generic; dispatch re-establishes it by
    // only routing events whose `type` matched the registration.
    handler: handler as unknown as RealtimeHandler<RealtimeEventType>,
    suppressOwnEcho: opts?.suppressOwnEcho ?? false,
  });
}

/** Run every registered handler; one throwing must not starve the rest. */
export function dispatchRealtimeEvent(
  event: RealtimeEvent,
  ctx: RealtimeHandlerContext,
): void {
  const byKey = registry.get(event.type);
  if (!byKey) return;
  for (const { handler, suppressOwnEcho } of byKey.values()) {
    if (suppressOwnEcho && isOwnEcho(event as { clientId?: string })) continue;
    try {
      handler(event, ctx);
    } catch (error) {
      // A kind's reaction failing is that kind's problem; the channel and
      // the other kinds keep working. Next poke/sync self-corrects.
      console.error("realtime handler failed", event.type, error);
    }
  }
}
