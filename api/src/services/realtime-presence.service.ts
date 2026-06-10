/**
 * Realtime client presence
 *
 * Tracks which browser tabs currently hold an open realtime (SSE)
 * connection, per workspace. The SSE route heartbeats presence while a
 * connection is open; a Mongo TTL index reaps stale rows. This gives a
 * multi-instance-correct answer to "is any browser attached?" without
 * adding pub/sub KV scans.
 *
 * Consumers:
 *   - agent.routes.ts "no client attached" fallback for client-only tools.
 */
import { Types } from "mongoose";
import { RealtimePresence } from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.api("realtime");

/**
 * A client counts as attached if it heartbeated within this window. The SSE
 * heartbeat fires every 25s, so 60s tolerates one missed beat plus skew.
 */
const PRESENCE_FRESHNESS_MS = 60_000;

/** Upsert (refresh) a client's presence row. Best-effort, never throws. */
export async function touchRealtimePresence(
  workspaceId: string,
  clientId: string,
  userId: string,
): Promise<void> {
  if (!clientId) return;
  try {
    await RealtimePresence.updateOne(
      { workspaceId: new Types.ObjectId(workspaceId), clientId },
      { $set: { lastSeenAt: new Date(), userId } },
      { upsert: true },
    );
  } catch (error) {
    logger.debug("Failed to touch realtime presence", {
      error,
      workspaceId,
      clientId,
    });
  }
}

/** Remove a client's presence row on clean disconnect. Best-effort. */
export async function clearRealtimePresence(
  workspaceId: string,
  clientId: string,
): Promise<void> {
  if (!clientId) return;
  try {
    await RealtimePresence.deleteOne({
      workspaceId: new Types.ObjectId(workspaceId),
      clientId,
    });
  } catch (error) {
    logger.debug("Failed to clear realtime presence", {
      error,
      workspaceId,
      clientId,
    });
  }
}

/** Is at least one browser tab attached to this workspace right now? */
export async function hasAttachedClients(
  workspaceId: string,
): Promise<boolean> {
  try {
    const fresh = await RealtimePresence.exists({
      workspaceId: new Types.ObjectId(workspaceId),
      lastSeenAt: { $gte: new Date(Date.now() - PRESENCE_FRESHNESS_MS) },
    });
    return fresh !== null;
  } catch (error) {
    // Fail open: assuming a client is attached preserves today's behavior
    // (client-driven tool loop) rather than risking a wrong synthetic result.
    logger.warn("Presence check failed; assuming clients attached", {
      error,
      workspaceId,
    });
    return true;
  }
}
