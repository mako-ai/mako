/**
 * One write through a connection by a person or workflow: who, where, and
 * whether their writers list allowed it. Kept 90 days: the Access tab shows
 * who tried to write, with Allow. Never the statement itself: only its
 * target.
 */
import mongoose, { Schema, Types } from "mongoose";

export interface IConnectionWriteEvent {
  workspaceId: Types.ObjectId;
  connectionId: Types.ObjectId;
  principal: string;
  target?: string;
  allowed: boolean;
  at: Date;
}

const ConnectionWriteEventSchema = new Schema<IConnectionWriteEvent>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    connectionId: { type: Schema.Types.ObjectId, required: true },
    principal: { type: String, required: true },
    target: { type: String },
    allowed: { type: Boolean, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { collection: "connection_write_events", versionKey: false },
);

ConnectionWriteEventSchema.index({ workspaceId: 1, connectionId: 1, at: -1 });
ConnectionWriteEventSchema.index(
  { at: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 },
);

export const ConnectionWriteEvent =
  (mongoose.models
    .ConnectionWriteEvent as mongoose.Model<IConnectionWriteEvent>) ??
  mongoose.model<IConnectionWriteEvent>(
    "ConnectionWriteEvent",
    ConnectionWriteEventSchema,
  );
