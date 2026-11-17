/**
 * One change to who may use a connection, made over MCP
 * (set_connection_access): who made it, on which connection, and what was
 * added or removed. A writers entry records who added it, but a removal
 * leaves nothing on the connection: this is where it stays. Kept: the
 * volume is a handful per workspace, and the question it answers ("who let
 * this workflow write, and when") is asked long after.
 */
import mongoose, { Schema, Types } from "mongoose";

export interface ListChange {
  added: string[];
  removed: string[];
}

export interface ConnectionAccessChanges {
  /** `principal`, or `principal where` on a database connection. */
  writers?: ListChange;
  /** `everyone: true` when the list was dropped. */
  liveReaders?: ListChange & { everyone?: boolean };
  /** User ids. */
  managers?: ListChange;
  /** The switch as it is after the change. */
  liveReads?: boolean;
}

export interface IConnectionAccessEvent {
  workspaceId: Types.ObjectId;
  connectionId: Types.ObjectId;
  kind: "database" | "source";
  /** The user id of the credential's owner. */
  actor: string;
  via: "mcp";
  changes: ConnectionAccessChanges;
  at: Date;
}

const ConnectionAccessEventSchema = new Schema<IConnectionAccessEvent>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    connectionId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ["database", "source"], required: true },
    actor: { type: String, required: true },
    via: { type: String, enum: ["mcp"], required: true },
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
