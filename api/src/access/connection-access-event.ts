/**
 * One change to who may use a connection, wherever it was made: the app's
 * Access tab (the writers and managers routes), a database connection's
 * `allowAgentWrites` switch, or MCP (set_connection_access). Who made it, on which connection, and what was
 * added or removed. A writers entry records who added it, but a removal
 * leaves nothing on the connection: this is where it stays. Kept: the
 * volume is a handful per workspace, and the question it answers ("who let
 * this workflow write, and when") is asked long after.
 */
import mongoose, { Schema, Types } from "mongoose";
import { loggers } from "../logging";
import { connectionsRepo } from "../repositories/connections";

const logger = loggers.api("connection-access-event");

export interface ListChange {
  added: string[];
  removed: string[];
}

export interface ConnectionAccessChanges {
  /** `principal`, or `principal where` on a database connection. */
  writers?: ListChange;
  /**
   * `everyone: true` when the list was dropped (everyone reads live again);
   * `limited: true` when a list was put where everyone read before, even an
   * empty one (only the writers read live then).
   */
  liveReaders?: ListChange & { everyone?: boolean; limited?: boolean };
  /** User ids. */
  managers?: ListChange;
  /** The switch as it is after the change. */
  liveReads?: boolean;
  /**
   * A database connection's `allowAgentWrites` as it is after the change:
   * on, any credential with the `query:write` scope writes through it.
   */
  agentWrites?: boolean;
}

export interface IConnectionAccessEvent {
  workspaceId: Types.ObjectId;
  connectionId: Types.ObjectId;
  kind: "database" | "source";
  /** The user id of the person signed in, or of the credential's owner. */
  actor: string;
  /** `api`: a REST call made with an API key. */
  via: "app" | "mcp" | "api";
  changes: ConnectionAccessChanges;
  at: Date;
}

const ConnectionAccessEventSchema = new Schema<IConnectionAccessEvent>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    connectionId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ["database", "source"], required: true },
    actor: { type: String, required: true },
    via: { type: String, enum: ["app", "mcp", "api"], required: true },
    changes: { type: Schema.Types.Mixed, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { collection: "connection_access_events", versionKey: false },
);

ConnectionAccessEventSchema.index({ workspaceId: 1, connectionId: 1, at: -1 });

export const ConnectionAccessEvent =
  (mongoose.models
    .ConnectionAccessEvent as mongoose.Model<IConnectionAccessEvent>) ??
  mongoose.model<IConnectionAccessEvent>(
    "ConnectionAccessEvent",
    ConnectionAccessEventSchema,
  );

/** What `after` adds to and removes from `before`. */
export function listChange(before: string[], after: string[]): ListChange {
  return {
    added: after.filter(entry => !before.includes(entry)),
    removed: before.filter(entry => !after.includes(entry)),
  };
}

/** A writers entry as an event names it: `principal`, or `principal where`. */
export function writerLabel(writer: {
  principal: string;
  where?: string | null;
}): string {
  return writer.where
    ? `${writer.principal} ${writer.where}`
    : writer.principal;
}

/** `changes` without the lists nothing was added to or removed from. */
function withoutEmpty(
  changes: ConnectionAccessChanges,
): ConnectionAccessChanges {
  const moved = (list?: ListChange) =>
    !!list && list.added.length + list.removed.length > 0;
  return {
    ...(moved(changes.writers) ? { writers: changes.writers } : {}),
    ...(moved(changes.liveReaders) ||
    changes.liveReaders?.everyone ||
    changes.liveReaders?.limited
      ? { liveReaders: changes.liveReaders }
      : {}),
    ...(moved(changes.managers) ? { managers: changes.managers } : {}),
    ...(changes.liveReads !== undefined
      ? { liveReads: changes.liveReads }
      : {}),
    ...(changes.agentWrites !== undefined
      ? { agentWrites: changes.agentWrites }
      : {}),
  };
}

/**
 * Keep one change to a connection's access. Every path that changes access
 * calls this, after the change is saved; a request that changed nothing
 * records nothing. A failure to record is logged, not thrown: the access is
 * already changed, and the caller's answer must say so.
 */
export async function recordAccessChange(event: {
  workspaceId: string | Types.ObjectId;
  connectionId: string | Types.ObjectId;
  kind: "database" | "source";
  actor: string;
  via: "app" | "mcp" | "api";
  changes: ConnectionAccessChanges;
}): Promise<void> {
  const changes = withoutEmpty(event.changes);
  if (Object.keys(changes).length === 0) return;
  try {
    await connectionsRepo.recordConnectionAccessEvent({
      workspaceId: String(event.workspaceId),
      connectionId: String(event.connectionId),
      kind: event.kind,
      actor: event.actor,
      via: event.via,
      changes,
    });
  } catch (error) {
    logger.error("Could not record a connection access change", {
      workspaceId: String(event.workspaceId),
      connectionId: String(event.connectionId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
