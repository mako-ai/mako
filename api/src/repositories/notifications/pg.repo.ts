/**
 * Postgres (Neon / Drizzle) implementation of `NotificationsRepository`.
 *
 *   - Rules get a `newDualId()` so 24-hex rule IDs keep routing.
 *   - Delivery creation is one `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`,
 *     and fan-out reuses a pending row to retry the same event ID.
 *   - Closing a delivery bumps `attempts = attempts + 1` in the same UPDATE.
 */
import { and, arrayContains, asc, eq, sql } from "drizzle-orm";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import { newDualId, parseEntityId, toWireId } from "../../database/pg/id-codec";
import {
  notificationDeliveries,
  notificationRules,
} from "../../database/pg/schema/control-plane-app";
import { PgUsageStatsRepository } from "../usage-stats/pg.repo";
import type {
  CompleteNotificationDeliveryInput,
  CreateNotificationDeliveryInput,
  CreateNotificationRuleInput,
  INotificationRuleChannel,
  NotificationChannelType,
  NotificationDeliveryRecord,
  NotificationResourceType,
  NotificationRuleRecord,
  NotificationTrigger,
  NotificationsRepository,
  UpdateNotificationRuleInput,
} from "./types";

type RuleRow = typeof notificationRules.$inferSelect;
type DeliveryRow = typeof notificationDeliveries.$inferSelect;

/** Parse a wire ID into its Postgres UUID, or null when it is neither format. */
function wireIdToPgUuid(id: string | null | undefined): string | null {
  return parseEntityId(id)?.uuid ?? null;
}

function requirePgUuid(id: string, label: string): string {
  const uuid = wireIdToPgUuid(id);
  if (!uuid) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(id)}`);
  }
  return uuid;
}

function pgRuleToRecord(row: RuleRow): NotificationRuleRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    resourceType: row.resourceType,
    resourceId: toWireId(row.resourceId),
    enabled: row.enabled,
    triggers: row.triggers as NotificationTrigger[],
    channel: row.channel as unknown as INotificationRuleChannel,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function pgDeliveryToRecord(row: DeliveryRow): NotificationDeliveryRecord {
  return {
    id: toWireId(row.id),
    workspaceId: toWireId(row.workspaceId),
    ruleId: toWireId(row.ruleId),
    resourceType: row.resourceType,
    resourceId: toWireId(row.resourceId),
    runId: row.runId,
    trigger: row.trigger as NotificationTrigger,
    channelType: row.channelType as NotificationChannelType,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    attempts: row.attempts,
    ...(row.lastError != null ? { lastError: row.lastError } : {}),
    ...(row.httpStatus != null ? { httpStatus: row.httpStatus } : {}),
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    createdAt: row.createdAt,
  };
}

export class PgNotificationsRepository implements NotificationsRepository {
  private readonly getDb: () => MakoPgDb;
  private readonly users: PgUsageStatsRepository;

  constructor(options: { getDb?: () => MakoPgDb } = {}) {
    this.getDb = options.getDb ?? getPgDb;
    this.users = new PgUsageStatsRepository({ getDb: this.getDb });
  }

  private resourceFilter(
    workspaceId: string,
    resourceType: NotificationResourceType,
    resourceId: string,
  ) {
    const ws = wireIdToPgUuid(workspaceId);
    const resource = wireIdToPgUuid(resourceId);
    if (!ws || !resource) return null;
    return { ws, resource, resourceType };
  }

  async listRulesForResource(
    workspaceId: string,
    resourceType: NotificationResourceType,
    resourceId: string,
  ): Promise<NotificationRuleRecord[]> {
    const f = this.resourceFilter(workspaceId, resourceType, resourceId);
    if (!f) return [];
    const rows = await this.getDb()
      .select()
      .from(notificationRules)
      .where(
        and(
          eq(notificationRules.workspaceId, f.ws),
          eq(notificationRules.resourceType, f.resourceType),
          eq(notificationRules.resourceId, f.resource),
        ),
      )
      .orderBy(asc(notificationRules.createdAt), asc(notificationRules.id));
    return rows.map(pgRuleToRecord);
  }

  async listEnabledRulesForTrigger(
    workspaceId: string,
    resourceType: NotificationResourceType,
    resourceId: string,
    trigger: NotificationTrigger,
  ): Promise<NotificationRuleRecord[]> {
    const f = this.resourceFilter(workspaceId, resourceType, resourceId);
    if (!f) return [];
    const rows = await this.getDb()
      .select()
      .from(notificationRules)
      .where(
        and(
          eq(notificationRules.workspaceId, f.ws),
          eq(notificationRules.resourceType, f.resourceType),
          eq(notificationRules.resourceId, f.resource),
          eq(notificationRules.enabled, true),
          arrayContains(notificationRules.triggers, [trigger]),
        ),
      )
      .orderBy(asc(notificationRules.createdAt), asc(notificationRules.id));
    return rows.map(pgRuleToRecord);
  }

  async findRuleInWorkspace(
    workspaceId: string,
    ruleId: string,
  ): Promise<NotificationRuleRecord | null> {
    const ws = wireIdToPgUuid(workspaceId);
    const id = wireIdToPgUuid(ruleId);
    if (!ws || !id) return null;
    const rows = await this.getDb()
      .select()
      .from(notificationRules)
      .where(
        and(
          eq(notificationRules.id, id),
          eq(notificationRules.workspaceId, ws),
        ),
      )
      .limit(1);
    return rows[0] ? pgRuleToRecord(rows[0]) : null;
  }

  async createRule(
    input: CreateNotificationRuleInput,
  ): Promise<NotificationRuleRecord> {
    const db = this.getDb();
    const id = input.id ? requirePgUuid(input.id, "rule id") : newDualId().uuid;
    const createdByUserId = await this.users.resolveNullableUserUuid(
      input.createdBy,
      db,
    );
    const now = new Date();
    const [row] = await db
      .insert(notificationRules)
      .values({
        id,
        workspaceId: requirePgUuid(input.workspaceId, "workspace id"),
        resourceType: input.resourceType,
        resourceId: requirePgUuid(input.resourceId, "resource id"),
        enabled: input.enabled,
        triggers: input.triggers,
        channel: input.channel as unknown as Record<string, unknown>,
        createdByUserId,
        createdBy: input.createdBy,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? input.createdAt ?? now,
      })
      .returning();
    return pgRuleToRecord(row);
  }

  async updateRule(
    workspaceId: string,
    ruleId: string,
    patch: UpdateNotificationRuleInput,
  ): Promise<NotificationRuleRecord | null> {
    const ws = wireIdToPgUuid(workspaceId);
    const id = wireIdToPgUuid(ruleId);
    if (!ws || !id) return null;
    const rows = await this.getDb()
      .update(notificationRules)
      .set({
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.triggers !== undefined ? { triggers: patch.triggers } : {}),
        ...(patch.channel !== undefined
          ? { channel: patch.channel as unknown as Record<string, unknown> }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(notificationRules.id, id),
          eq(notificationRules.workspaceId, ws),
        ),
      )
      .returning();
    return rows[0] ? pgRuleToRecord(rows[0]) : null;
  }

  async deleteRule(workspaceId: string, ruleId: string): Promise<boolean> {
    const ws = wireIdToPgUuid(workspaceId);
    const id = wireIdToPgUuid(ruleId);
    if (!ws || !id) return false;
    const rows = await this.getDb()
      .delete(notificationRules)
      .where(
        and(
          eq(notificationRules.id, id),
          eq(notificationRules.workspaceId, ws),
        ),
      )
      .returning({ id: notificationRules.id });
    return rows.length > 0;
  }

  async ensurePendingDelivery(
    input: CreateNotificationDeliveryInput,
  ): Promise<NotificationDeliveryRecord | null> {
    const rows = await this.getDb()
      .insert(notificationDeliveries)
      .values({
        workspaceId: requirePgUuid(input.workspaceId, "workspace id"),
        ruleId: requirePgUuid(input.ruleId, "rule id"),
        resourceType: input.resourceType,
        resourceId: requirePgUuid(input.resourceId, "resource id"),
        runId: input.runId,
        trigger: input.trigger,
        channelType: input.channelType,
        idempotencyKey: input.idempotencyKey,
        status: "pending",
        attempts: 0,
      })
      .onConflictDoNothing({ target: notificationDeliveries.idempotencyKey })
      .returning();
    if (rows[0]) return pgDeliveryToRecord(rows[0]);
    // A previous sender may have crashed after committing the pending row.
    const [pending] = await this.getDb()
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.idempotencyKey, input.idempotencyKey),
          eq(
            notificationDeliveries.workspaceId,
            requirePgUuid(input.workspaceId, "workspace id"),
          ),
          eq(notificationDeliveries.status, "pending"),
        ),
      )
      .limit(1);
    return pending ? pgDeliveryToRecord(pending) : null;
  }

  async completeDelivery(
    idempotencyKey: string,
    input: CompleteNotificationDeliveryInput,
  ): Promise<boolean> {
    const rows = await this.getDb()
      .update(notificationDeliveries)
      .set({
        status: input.status,
        completedAt: input.completedAt,
        ...(input.lastError !== undefined
          ? { lastError: input.lastError }
          : {}),
        ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
        ...(input.countAttempt
          ? { attempts: sql`${notificationDeliveries.attempts} + 1` }
          : {}),
      })
      .where(eq(notificationDeliveries.idempotencyKey, idempotencyKey))
      .returning({ id: notificationDeliveries.id });
    return rows.length > 0;
  }

  async listDeliveriesForResource(
    workspaceId: string,
    resourceType: NotificationResourceType,
    resourceId: string,
    limit: number,
  ): Promise<NotificationDeliveryRecord[]> {
    const f = this.resourceFilter(workspaceId, resourceType, resourceId);
    if (!f) return [];
    const rows = await this.getDb()
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.workspaceId, f.ws),
          eq(notificationDeliveries.resourceType, f.resourceType),
          eq(notificationDeliveries.resourceId, f.resource),
        ),
      )
      .orderBy(
        sql`${notificationDeliveries.completedAt} DESC NULLS LAST`,
        sql`${notificationDeliveries.createdAt} DESC NULLS LAST`,
      )
      .limit(limit);
    return rows.map(pgDeliveryToRecord);
  }
}
