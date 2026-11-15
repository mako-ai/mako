import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * WebhookEvent model interface
 */
export interface IWebhookEvent extends Document {
  _id: Types.ObjectId;
  flowId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  eventId: string; // External event ID (e.g., Stripe's evt_xxx)
  eventType: string; // e.g., "customer.updated"
  receivedAt: Date;
  processedAt?: Date;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  rawPayload: any;
  signature?: string; // For verification
  processingDurationMs?: number;
  entity?: string;
  operation?: "upsert" | "delete";
  recordId?: string;
  applyStatus?: "pending" | "applied" | "failed" | "dropped";
  appliedAt?: Date;
  applyAttempts?: number;
  applyError?: {
    message: string;
    code?: string;
  };
}

/**
 * WebhookEvent Schema
 */
const WebhookEventSchema = new Schema<IWebhookEvent>(
  {
    flowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    receivedAt: { type: Date, required: true, default: Date.now },
    processedAt: Date,
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      required: true,
    },
    attempts: { type: Number, default: 0 },
    error: {
      message: String,
      stack: String,
      code: String,
    },
    rawPayload: { type: Schema.Types.Mixed, required: true },
    signature: String,
    processingDurationMs: Number,
    entity: String,
    operation: {
      type: String,
      enum: ["upsert", "delete"],
    },
    recordId: String,
    applyStatus: {
      type: String,
      enum: ["pending", "applied", "failed", "dropped"],
      default: "pending",
      required: true,
    },
    appliedAt: Date,
    applyAttempts: { type: Number, default: 0 },
    applyError: {
      message: String,
      code: String,
    },
  },
  {
    timestamps: false,
  },
);

// Indexes
WebhookEventSchema.index({ flowId: 1, eventId: 1 }, { unique: true });
WebhookEventSchema.index({ flowId: 1, status: 1, receivedAt: 1 });
WebhookEventSchema.index({ flowId: 1, applyStatus: 1, receivedAt: 1 });
// Supports the GLOBAL cron-ingest query in cdcMaterializeSchedulerFunction:
// find({ status: "pending" }).sort({ receivedAt: 1 }). Without a flowId-free
// index this query does a COLLSCAN + in-memory sort over the whole collection.
WebhookEventSchema.index({ status: 1, receivedAt: 1 });
WebhookEventSchema.index({ workspaceId: 1, receivedAt: -1 });
// Tiered retention by applyStatus (anchored on receivedAt, which is required on
// every doc so the four partial TTLs fully cover the collection). MongoDB allows
// multiple TTL indexes on the same key when they differ by partialFilterExpression
// (same pattern as cdc_change_events applied-vs-dropped). Successfully processed
// events are purged quickly; errors are retained longer for debugging.
/** Successfully processed -> short retention. */
WebhookEventSchema.index(
  { receivedAt: 1 },
  {
    name: "webhookevents_applied_ttl_3d",
    expireAfterSeconds: 3 * 24 * 60 * 60,
    partialFilterExpression: { applyStatus: "applied" },
  },
);
/** Awaiting destination apply -> safety net (matches prior flat behavior). */
WebhookEventSchema.index(
  { receivedAt: 1 },
  {
    name: "webhookevents_pending_ttl_7d",
    expireAfterSeconds: 7 * 24 * 60 * 60,
    partialFilterExpression: { applyStatus: "pending" },
  },
);
/** Intentionally skipped -> keep longer for audit. */
WebhookEventSchema.index(
  { receivedAt: 1 },
  {
    name: "webhookevents_dropped_ttl_7d",
    expireAfterSeconds: 7 * 24 * 60 * 60,
    partialFilterExpression: { applyStatus: "dropped" },
  },
);
/** Errors -> retained longest for debugging. */
WebhookEventSchema.index(
  { receivedAt: 1 },
  {
    name: "webhookevents_failed_ttl_30d",
    expireAfterSeconds: 30 * 24 * 60 * 60,
    partialFilterExpression: { applyStatus: "failed" },
  },
);

export const WebhookEvent = mongoose.model<IWebhookEvent>(
  "WebhookEvent",
  WebhookEventSchema,
);
