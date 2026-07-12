/**
 * Workspace realtime channel
 *
 * Server→client push for the "server-authoritative drafts + live push"
 * architecture (issue #475). Events are *pokes*, not authoritative data:
 * clients compare the carried `draftRevision` with what they have and pull
 * over normal HTTP when stale (poke-then-pull). Late/duplicate/lost events
 * are therefore self-correcting and wire ordering does not matter.
 *
 * Fan-out runs over the shared pluggable pub/sub backend (pubsub.service.ts):
 * Redis when REDIS_URL is set (multi-instance), in-process otherwise. Each
 * API instance forwards events to its own connected SSE clients
 * (routes/realtime.ts).
 */
import {
  createPubSubPublisher,
  createPubSubSubscriber,
  reportPubSubFailure,
  type Publisher,
  type Subscriber,
} from "./pubsub.service";
import { loggers } from "../logging";

const logger = loggers.api("realtime");

const CHANNEL_PREFIX = "mako:realtime:ws:";

/** Events delivered on a workspace's realtime channel. */
export type RealtimeEvent =
  | {
      type: "console.updated";
      consoleId: string;
      draftRevision: number;
      name?: string;
      updatedBy: string;
      /**
       * Identifier of the writer's tab (browser tabs) or `agent:<chatId>`
       * (server-side agent tools). Tabs suppress their own echoes with it.
       */
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
      type: "chat.activity";
      chatId: string;
      state: "streaming" | "idle";
    }
  // Agent-driven mutation pokes for server-executed app/dbt/dashboard tools
  // (the app/dbt/dashboard analogue of console.updated). Open tabs pull the
  // authoritative document over normal HTTP when the carried version/path is
  // newer than what they hold (poke-then-pull). `clientId` lets a tab suppress
  // its own echoes; agent writes carry `agent:<chatId>`.
  | {
      type: "app.updated";
      appId: string;
      version: number;
      updatedBy: string;
      clientId?: string;
      origin: "agent" | "save";
    }
  | {
      type: "dbt.file.updated";
      projectId: string;
      path: string;
      deleted?: boolean;
      updatedBy: string;
      clientId?: string;
      origin: "agent" | "save";
      /**
       * Set for draft (uncommitted) edits: only this user's windows should
       * react — drafts are invisible to everyone else. Unset for committed /
       * base-tree updates, which are workspace-wide.
       */
      forUserId?: string;
    }
  // Git surface changed for a dbt project: commit/push, sync/pull, PR merge,
  // or a restore. Clients refetch git status + the file tree (poke-then-pull).
  | {
      type: "dbt.git.updated";
      projectId: string;
      updatedBy: string;
      clientId?: string;
      /** Set when only this user's working tree changed (e.g. their commit). */
      forUserId?: string;
    }
  // A user's checkout moved (branch create/switch/delete). Per-user by
  // definition — only the acting user's windows refresh their branch state.
  | {
      type: "dbt.checkout.updated";
      projectId: string;
      branch: string;
      forUserId: string;
      updatedBy: string;
      clientId?: string;
    }
  // Job list changed (create/update/delete) — clients refetch jobs.
  | { type: "dbt.job.updated"; projectId: string; clientId?: string }
  // A run was created/cancelled/retried — clients refetch run lists.
  | {
      type: "dbt.run.updated";
      projectId: string;
      runId?: string;
      jobId?: string;
      clientId?: string;
    }
  // Project list/settings changed (create/patch/delete) — refetch projects.
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
      type: "app-v2.project.updated";
      projectId?: string;
      forUserId?: string;
      forUserIds?: string[];
    }
  | {
      type: "app-v2.project.deleted";
      projectId: string;
      forUserId?: string;
      forUserIds?: string[];
    }
  | {
      type: "app-v2.worktree.updated";
      projectId: string;
      worktreeId: string;
      revision: number;
      forUserId: string;
    }
  | {
      type: "app-v2.commit.created";
      projectId: string;
      worktreeId: string;
      sha: string;
      forUserId?: string;
      forUserIds?: string[];
    }
  | {
      type: "app-v2.github.conflict";
      projectId: string;
      chatId: string;
      remoteBranch: string;
      forUserId: string;
    };

function channelFor(workspaceId: string): string {
  return `${CHANNEL_PREFIX}${workspaceId}`;
}

// Lazily-created handles. One publisher and one subscriber connection per
// process; the subscriber multiplexes channels with ref-counted listeners.
let publisher: Publisher | null = null;
let subscriber: Subscriber | null = null;

interface ChannelListeners {
  callbacks: Map<(event: RealtimeEvent) => void, string | undefined>;
}

const channelListeners = new Map<string, ChannelListeners>();

function getPublisher(): Publisher {
  if (!publisher) {
    publisher = createPubSubPublisher();
  }
  return publisher;
}

function getSubscriber(): Subscriber {
  if (!subscriber) {
    subscriber = createPubSubSubscriber();
  }
  return subscriber;
}

/**
 * Publish an event to every client subscribed to the workspace's channel.
 * Fire-and-forget by design: realtime delivery is best-effort and must never
 * fail a write path. Failures are logged.
 */
export function publishRealtimeEvent(
  workspaceId: string,
  event: RealtimeEvent,
): void {
  void (async () => {
    try {
      await getPublisher().publish(
        channelFor(workspaceId),
        JSON.stringify(event),
      );
    } catch (error) {
      logger.warn("Failed to publish realtime event", {
        error,
        workspaceId,
        eventType: event.type,
      });
      // Escalates to a throttled ERROR: a failing publish means the Redis
      // backend is down/over quota and realtime + stream resume are degraded.
      reportPubSubFailure("realtime-publish", error);
    }
  })();
}

/**
 * Subscribe to a workspace's realtime events. Returns an async disposer.
 *
 * The underlying backend channel is subscribed when the first listener for a
 * workspace registers and unsubscribed when the last one leaves
 * (ref-counting), so idle workspaces cost nothing.
 */
export async function subscribeToWorkspaceEvents(
  workspaceId: string,
  callback: (event: RealtimeEvent) => void,
  options?: { userId?: string },
): Promise<() => Promise<void>> {
  const channel = channelFor(workspaceId);
  let listeners = channelListeners.get(channel);

  if (!listeners) {
    listeners = { callbacks: new Map() };
    channelListeners.set(channel, listeners);
    const entry = listeners;
    await getSubscriber().subscribe(channel, (message: string) => {
      let event: RealtimeEvent;
      try {
        const parsed = JSON.parse(message) as unknown;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed) ||
          typeof (parsed as { type?: unknown }).type !== "string"
        ) {
          throw new Error("Realtime event must be an object with a type");
        }
        event = parsed as RealtimeEvent;
      } catch (error) {
        logger.warn("Dropping malformed realtime event", { error, channel });
        return;
      }
      for (const [cb, subscriberUserId] of entry.callbacks) {
        if (
          "forUserId" in event &&
          event.forUserId !== undefined &&
          event.forUserId !== subscriberUserId
        ) {
          continue;
        }
        if (
          "forUserIds" in event &&
          event.forUserIds !== undefined &&
          !event.forUserIds.includes(subscriberUserId ?? "")
        ) {
          continue;
        }
        try {
          cb(event);
        } catch (error) {
          logger.warn("Realtime event listener threw", { error, channel });
        }
      }
    });
  }

  listeners.callbacks.set(callback, options?.userId);

  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    const current = channelListeners.get(channel);
    if (!current) return;
    current.callbacks.delete(callback);
    if (current.callbacks.size === 0) {
      channelListeners.delete(channel);
      try {
        await getSubscriber().unsubscribe(channel);
      } catch (error) {
        logger.warn("Failed to unsubscribe realtime channel", {
          error,
          channel,
        });
      }
    }
  };
}
