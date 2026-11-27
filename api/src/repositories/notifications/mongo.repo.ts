import { controlPlaneSession } from "../control-plane-fence";
import { Types } from "mongoose";
import {
  NotificationDelivery,
  NotificationRule,
  type INotificationDelivery,
  type INotificationRule,
} from "../../database/models/notifications";
import type {
  CompleteNotificationDeliveryInput,
  CreateNotificationDeliveryInput,
  CreateNotificationRuleInput,
  NotificationDeliveryRecord,
  NotificationResourceType,
  NotificationRuleRecord,
  NotificationTrigger,
  NotificationsRepository,
  UpdateNotificationRuleInput,
} from "./types";

type LeanRule = Pick<
  INotificationRule,
  | "_id"
  | "workspaceId"
  | "resourceType"
  | "resourceId"
  | "enabled"
  | "triggers"
  | "channel"
  | "createdBy"
  | "createdAt"
  | "updatedAt"
>;

function oid(id: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id)
    ? new Types.ObjectId(id)
    : null;
}

function mongoRuleToRecord(doc: LeanRule): NotificationRuleRecord {
  return {
    id: doc._id.toString(),
    workspaceId: doc.workspaceId.toString(),
    resourceType: doc.resourceType,
    resourceId: doc.resourceId.toString(),
    enabled: doc.enabled,
    triggers: [...doc.triggers],
    channel: doc.channel,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function mongoDeliveryToRecord(
  doc: INotificationDelivery,
): NotificationDeliveryRecord {
  return {
    id: doc._id.toString(),
    workspaceId: doc.workspaceId.toString(),
    ruleId: doc.ruleId.toString(),
    resourceType: doc.resourceType,
    resourceId: doc.resourceId.toString(),
    runId: doc.runId,
    trigger: doc.trigger,
    channelType: doc.channelType,
    idempotencyKey: doc.idempotencyKey,
    status: doc.status,
    attempts: doc.attempts ?? 0,
    ...(doc.lastError != null ? { lastError: doc.lastError } : {}),
    ...(doc.httpStatus != null ? { httpStatus: doc.httpStatus } : {}),
    ...(doc.sentAt ? { sentAt: doc.sentAt } : {}),
    ...(doc.completedAt ? { completedAt: doc.completedAt } : {}),
    createdAt: doc.createdAt,
  };
}

export class MongoNotificationsRepository implements NotificationsRepository {
  private resourceFilter(
    workspaceId: string,
    resourceType: NotificationResourceType,
    resourceId: string,
  ) {
    const ws = oid(workspaceId);
    const resource = oid(resourceId);
    if (!ws || !resource) return null;
    return { workspaceId: ws, resourceType, resourceId: resource };
  }

  async listRulesForResource(
    workspaceId: string,
    resourceType: NotificationResourceType,
    resourceId: string,
  ): Promise<NotificationRuleRecord[]> {
    const filter = this.resourceFilter(workspaceId, resourceType, resourceId);
    if (!filter) return [];
    const docs = await NotificationRule.find(filter)
      .sort({ createdAt: 1 })
      .lean<LeanRule[]>();
    return docs.map(mongoRuleToRecord);
  }

  async listEnabledRulesForTrigger(
    workspaceId: string,
    resourceType: NotificationResourceType,
    resourceId: string,
    trigger: NotificationTrigger,
  ): Promise<NotificationRuleRecord[]> {
    const filter = this.resourceFilter(workspaceId, resourceType, resourceId);
    if (!filter) return [];
    const docs = await NotificationRule.find({
      ...filter,
      enabled: true,
      triggers: trigger,
    })
      .sort({ createdAt: 1 })
      .lean<LeanRule[]>();
    return docs.map(mongoRuleToRecord);
  }

  async findRuleInWorkspace(
    workspaceId: string,
    ruleId: string,
  ): Promise<NotificationRuleRecord | null> {
    const ws = oid(workspaceId);
    const id = oid(ruleId);
    if (!ws || !id) return null;
    const doc = await NotificationRule.findOne({
      _id: id,
      workspaceId: ws,
    }).lean<LeanRule>();
    return doc ? mongoRuleToRecord(doc) : null;
  }

  async createRule(
    input: CreateNotificationRuleInput,
  ): Promise<NotificationRuleRecord> {
    const doc = await new NotificationRule({
      ...(input.id ? { _id: new Types.ObjectId(input.id) } : {}),
      workspaceId: new Types.ObjectId(input.workspaceId),
      resourceType: input.resourceType,
      resourceId: new Types.ObjectId(input.resourceId),
      enabled: input.enabled,
      triggers: input.triggers,
      channel: input.channel,
      createdBy: input.createdBy,
    }).save({ session: controlPlaneSession() });
    return mongoRuleToRecord(doc.toObject() as LeanRule);
  }

  async updateRule(
    workspaceId: string,
    ruleId: string,
    patch: UpdateNotificationRuleInput,
  ): Promise<NotificationRuleRecord | null> {
    const ws = oid(workspaceId);
    const id = oid(ruleId);
    if (!ws || !id) return null;
    const set: Record<string, unknown> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.triggers !== undefined) set.triggers = patch.triggers;
    if (patch.channel !== undefined) set.channel = patch.channel;
    const doc = await NotificationRule.findOneAndUpdate(
      { _id: id, workspaceId: ws },
      { $set: set },
      { returnDocument: "after", session: controlPlaneSession() },
    ).lean<LeanRule>();
    return doc ? mongoRuleToRecord(doc) : null;
  }

  async deleteRule(workspaceId: string, ruleId: string): Promise<boolean> {
    const ws = oid(workspaceId);
    const id = oid(ruleId);
    if (!ws || !id) return false;
    const result = await NotificationRule.deleteOne(
      {
        _id: id,
        workspaceId: ws,
      },
      { session: controlPlaneSession() },
    );
    return result.deletedCount > 0;
  }

  async ensurePendingDelivery(
    input: CreateNotificationDeliveryInput,
  ): Promise<NotificationDeliveryRecord | null> {
    const session = controlPlaneSession();
    if (session) {
      const existing = await NotificationDelivery.findOne({
        idempotencyKey: input.idempotencyKey,
      })
        .session(session)
        .lean<INotificationDelivery>();
      if (existing) {
        return existing.status === "pending" &&
          existing.workspaceId.toString() === input.workspaceId
          ? mongoDeliveryToRecord(existing)
          : null;
      }
    }
    try {
      const doc = await new NotificationDelivery({
        workspaceId: new Types.ObjectId(input.workspaceId),
        ruleId: new Types.ObjectId(input.ruleId),
        resourceType: input.resourceType,
        resourceId: new Types.ObjectId(input.resourceId),
        runId: input.runId,
        trigger: input.trigger,
        channelType: input.channelType,
        idempotencyKey: input.idempotencyKey,
        status: "pending",
        attempts: 0,
      }).save({ session });
      return mongoDeliveryToRecord(doc.toObject() as INotificationDelivery);
    } catch (error) {
      if (
        !session &&
        error instanceof Error &&
        "code" in error &&
        error.code === 11000
      ) {
        const pending = await NotificationDelivery.findOne({
          idempotencyKey: input.idempotencyKey,
          workspaceId: input.workspaceId,
          status: "pending",
        }).lean<INotificationDelivery>();
        return pending ? mongoDeliveryToRecord(pending) : null;
      }
      throw error;
    }
  }

  async completeDelivery(
    idempotencyKey: string,
    input: CompleteNotificationDeliveryInput,
  ): Promise<boolean> {
    const set: Record<string, unknown> = {
      status: input.status,
      completedAt: input.completedAt,
    };
    if (input.lastError !== undefined) set.lastError = input.lastError;
    if (input.sentAt !== undefined) set.sentAt = input.sentAt;
    const result = await NotificationDelivery.updateOne(
      { idempotencyKey },
      {
        $set: set,
        ...(input.countAttempt ? { $inc: { attempts: 1 } } : {}),
      },
      { session: controlPlaneSession() },
    );
    return result.modifiedCount > 0;
  }

  async listDeliveriesForResource(
    workspaceId: string,
    resourceType: NotificationResourceType,
    resourceId: string,
    limit: number,
  ): Promise<NotificationDeliveryRecord[]> {
    const filter = this.resourceFilter(workspaceId, resourceType, resourceId);
    if (!filter) return [];
    const docs = await NotificationDelivery.find(filter)
      .sort({ completedAt: -1, createdAt: -1 })
      .limit(limit)
      .lean<INotificationDelivery[]>();
    return docs.map(mongoDeliveryToRecord);
  }
}
