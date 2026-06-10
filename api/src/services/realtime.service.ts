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
    };

function channelFor(workspaceId: string): string {
  return `${CHANNEL_PREFIX}${workspaceId}`;
}

// Lazily-created handles. One publisher and one subscriber connection per
// process; the subscriber multiplexes channels with ref-counted listeners.
let publisher: Publisher | null = null;
let subscriber: Subscriber | null = null;

interface ChannelListeners {
  callbacks: Set<(event: RealtimeEvent) => void>;
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
): Promise<() => Promise<void>> {
  const channel = channelFor(workspaceId);
  let listeners = channelListeners.get(channel);

  if (!listeners) {
    listeners = { callbacks: new Set() };
    channelListeners.set(channel, listeners);
    const entry = listeners;
    await getSubscriber().subscribe(channel, (message: string) => {
      let event: RealtimeEvent;
      try {
        event = JSON.parse(message) as RealtimeEvent;
      } catch (error) {
        logger.warn("Dropping malformed realtime event", { error, channel });
        return;
      }
      for (const cb of entry.callbacks) {
        try {
          cb(event);
        } catch (error) {
          logger.warn("Realtime event listener threw", { error, channel });
        }
      }
    });
  }

  listeners.callbacks.add(callback);

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
