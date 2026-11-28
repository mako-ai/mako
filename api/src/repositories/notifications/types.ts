/**
 * Notifications domain repository contract (`notification_rules`,
 * `notification_deliveries`). Every ID is a wire ID: a 24-hex ObjectId for rows
 * in the ObjectId subspace, a lowercase UUID for native UUIDv7 rows.
 */
import type {
  INotificationRuleChannel,
  NotificationChannelType,
  NotificationDeliveryStatus,
  NotificationResourceType,
  NotificationTrigger,
} from "../../database/models/notifications";

export type {
  INotificationRuleChannel,
  NotificationChannelType,
  NotificationDeliveryStatus,
  NotificationResourceType,
  NotificationTrigger,
};

export interface NotificationRuleRecord {
  id: string;
  workspaceId: string;
  resourceType: NotificationResourceType;
  resourceId: string;
  enabled: boolean;
  triggers: NotificationTrigger[];
  /** Encrypted channel, exactly as stored. */
  channel: INotificationRuleChannel;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateNotificationRuleInput {
  /** Optional explicit ID (backfill). New rules get a `newDualId()`. */
  id?: string;
  workspaceId: string;
  resourceType: NotificationResourceType;
  resourceId: string;
  enabled: boolean;
  triggers: NotificationTrigger[];
  /** Already encrypted. */
  channel: INotificationRuleChannel;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UpdateNotificationRuleInput {
  enabled?: boolean;
  triggers?: NotificationTrigger[];
  /** Already encrypted. */
  channel?: INotificationRuleChannel;
}

export interface NotificationDeliveryRecord {
  id: string;
  workspaceId: string;
  ruleId: string;
  resourceType: NotificationResourceType;
  resourceId: string;
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

export interface CreateNotificationDeliveryInput {
  workspaceId: string;
  ruleId: string;
  resourceType: NotificationResourceType;
  resourceId: string;
  runId: string;
  trigger: NotificationTrigger;
  channelType: NotificationChannelType;
  idempotencyKey: string;
}

export interface CompleteNotificationDeliveryInput {
  status: Exclude<NotificationDeliveryStatus, "pending">;
  lastError?: string;
  sentAt?: Date;
  completedAt: Date;
  /** Add one to `attempts` atomically. */
  countAttempt: boolean;
}

export interface NotificationsRepository {
  /** A resource's rules, oldest first. */
  listRulesForResource(
    workspaceId: string,
    resourceType: NotificationResourceType,
    resourceId: string,
  ): Promise<NotificationRuleRecord[]>;
  /** A resource's enabled rules that fire on `trigger`. */
  listEnabledRulesForTrigger(
    workspaceId: string,
    resourceType: NotificationResourceType,
    resourceId: string,
    trigger: NotificationTrigger,
  ): Promise<NotificationRuleRecord[]>;
  findRuleInWorkspace(
    workspaceId: string,
    ruleId: string,
  ): Promise<NotificationRuleRecord | null>;
  createRule(
    input: CreateNotificationRuleInput,
  ): Promise<NotificationRuleRecord>;
  updateRule(
    workspaceId: string,
    ruleId: string,
    patch: UpdateNotificationRuleInput,
  ): Promise<NotificationRuleRecord | null>;
  deleteRule(workspaceId: string, ruleId: string): Promise<boolean>;

  /**
   * Create a pending delivery unless one with the same idempotency key exists.
   * Returns a new or existing pending delivery, or null once it is closed.
   */
  ensurePendingDelivery(
    input: CreateNotificationDeliveryInput,
  ): Promise<NotificationDeliveryRecord | null>;
  /** Close a delivery by idempotency key. Returns whether a row changed. */
  completeDelivery(
    idempotencyKey: string,
    input: CompleteNotificationDeliveryInput,
  ): Promise<boolean>;
  /** A resource's deliveries, latest completed first, then latest created. */
  listDeliveriesForResource(
    workspaceId: string,
    resourceType: NotificationResourceType,
    resourceId: string,
    limit: number,
  ): Promise<NotificationDeliveryRecord[]>;
}
