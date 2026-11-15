import mongoose, { Schema, Document, Types } from "mongoose";

export type NotificationResourceType = "scheduled_query" | "flow";

export type NotificationTrigger = "success" | "failure";

export type NotificationChannelType = "email" | "webhook" | "slack";

export interface INotificationRuleChannelEmail {
  type: "email";
  recipients: string[];
}

export interface INotificationRuleChannelWebhook {
  type: "webhook";
  /** Encrypted URL */
  urlEncrypted: string;
  /** Encrypted signing secret (HMAC SHA256 over JSON body) */
  signingSecretEncrypted: string;
}

export interface INotificationRuleChannelSlack {
  type: "slack";
  /** Encrypted incoming webhook URL */
  webhookUrlEncrypted: string;
  /** UI label only, e.g. #alerts */
  displayLabel?: string;
}

export type INotificationRuleChannel =
  | INotificationRuleChannelEmail
  | INotificationRuleChannelWebhook
  | INotificationRuleChannelSlack;

export interface INotificationRule extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  resourceType: NotificationResourceType;
  resourceId: Types.ObjectId;
  enabled: boolean;
  triggers: NotificationTrigger[];
  channel: INotificationRuleChannel;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationRuleSchema = new Schema<INotificationRule>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    resourceType: {
      type: String,
      enum: ["scheduled_query", "flow"],
      required: true,
    },
    resourceId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    triggers: {
      type: [String],
      enum: ["success", "failure"],
      validate: {
        validator: (v: string[]) =>
          Array.isArray(v) &&
          v.length > 0 &&
          v.every(t => t === "success" || t === "failure"),
        message: "At least one trigger required",
      },
      required: true,
    },
    channel: {
      type: Schema.Types.Mixed,
      required: true,
    },
    createdBy: {
      type: String,
      required: true,
    },
  },
  {
    collection: "notification_rules",
    timestamps: true,
  },
);

NotificationRuleSchema.index({
  workspaceId: 1,
  resourceType: 1,
  resourceId: 1,
  enabled: 1,
});

export const NotificationRule = mongoose.model<INotificationRule>(
  "NotificationRule",
  NotificationRuleSchema,
);

export type NotificationDeliveryStatus =
  "pending" | "sent" | "failed" | "skipped";

export interface INotificationDelivery extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  ruleId: Types.ObjectId;
  resourceType: NotificationResourceType;
  resourceId: Types.ObjectId;
  runId: string;
  trigger: NotificationTrigger;
  channelType: NotificationChannelType;
  idempotencyKey: string;
  status: NotificationDeliveryStatus;
  attempts: number;
  lastError?: string;
  httpStatus?: number;
  sentAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

const NotificationDeliverySchema = new Schema<INotificationDelivery>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    ruleId: {
      type: Schema.Types.ObjectId,
      ref: "NotificationRule",
      required: true,
    },
    resourceType: {
      type: String,
      enum: ["scheduled_query", "flow"],
      required: true,
    },
    resourceId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    runId: {
      type: String,
      required: true,
    },
    trigger: {
      type: String,
      enum: ["success", "failure"],
      required: true,
    },
    channelType: {
      type: String,
      enum: ["email", "webhook", "slack"],
      required: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "sent", "failed", "skipped"],
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lastError: String,
    httpStatus: Number,
    sentAt: Date,
    completedAt: Date,
  },
  {
    collection: "notification_deliveries",
    timestamps: { createdAt: true, updatedAt: false },
  },
);

NotificationDeliverySchema.index({
  workspaceId: 1,
  resourceType: 1,
  resourceId: 1,
  completedAt: -1,
});

NotificationDeliverySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 7776000 },
);

export const NotificationDelivery = mongoose.model<INotificationDelivery>(
  "NotificationDelivery",
  NotificationDeliverySchema,
);
