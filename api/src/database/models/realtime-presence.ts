import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * RealtimePresence — one document per connected realtime (SSE) client tab.
 *
 * Heartbeated by routes/realtime.ts while the connection is open; reaped by
 * a TTL index after 90s without a heartbeat. Lets server-side code answer
 * "is any browser attached to this workspace right now?" across instances
 * (used by the agent's "no client attached" tool fallback).
 */
export interface IRealtimePresence extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  clientId: string;
  userId: string;
  lastSeenAt: Date;
}

const RealtimePresenceSchema = new Schema<IRealtimePresence>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    clientId: { type: String, required: true },
    userId: { type: String, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { collection: "realtime_presence" },
);

RealtimePresenceSchema.index({ workspaceId: 1, clientId: 1 }, { unique: true });
// TTL reaper: connections that stop heartbeating disappear automatically.
RealtimePresenceSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 90 });

export const RealtimePresence = mongoose.model<IRealtimePresence>(
  "RealtimePresence",
  RealtimePresenceSchema,
);
