import type {
  NotificationChannelType,
  NotificationResourceType,
  NotificationTrigger,
} from "../database/workspace-schema";

/** Persisted run terminal event emitted after DB commit */
export interface FlowRunTerminalEventData {
  workspaceId: string;
  resourceType: NotificationResourceType;
  resourceId: string;
  runId: string;
  /** Raw terminal status from ScheduledQueryRun or FlowExecution */
  status: string;
  success: boolean;
  triggerType?: "schedule" | "manual";
  completedAt: string;
  durationMs?: number;
  rowCount?: number;
  errorMessage?: string;
}

/** Fan-out sends one delivery job per matching rule */
export interface NotificationDeliverJobData {
  workspaceId: string;
  ruleId: string;
  resourceType: NotificationResourceType;
  resourceId: string;
  runId: string;
  trigger: NotificationTrigger;
  channelType: NotificationChannelType;
  idempotencyKey: string;
  /** Serialized snapshot for delivery (no secrets) */
  payload: NotificationOutboundPayload;
}

export interface NotificationOutboundPayload {
  version: 1;
  event: "flow.run.terminal";
  trigger: NotificationTrigger;
  resourceType: NotificationResourceType;
  resourceId: string;
  resourceName: string;
  runId: string;
  completedAt: string;
  durationMs?: number;
  rowCount?: number;
  errorMessage?: string;
  triggerType?: "schedule" | "manual";
  workspaceId: string;
  deepLink?: string;
}
