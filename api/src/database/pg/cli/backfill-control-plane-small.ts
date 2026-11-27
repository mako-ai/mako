/**
 * CLI: one-shot idempotent copy of the small app control-plane collections
 * from MongoDB into Postgres (migration `0012`).
 *
 *   notification_rules, notification_deliveries,
 *   workflow_recorded_runs, workflow_recorded_writes,
 *   modelcatalogsnapshots -> model_catalog_snapshots, apps_box_policy
 *
 * Use --apply before cutover and --replay for read-only content parity.
 * Deletion reconciliation only reports missing imported rules.
 *
 * Usage:
 *   pnpm --filter api exec tsx src/database/pg/cli/backfill-control-plane-small.ts
 *   pnpm --filter api exec tsx src/database/pg/cli/backfill-control-plane-small.ts --apply
 */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Command } from "commander";
import dotenv from "dotenv";
import { and, asc, eq, gt, gte, inArray, or, sql } from "drizzle-orm";
import mongoose, { Types } from "mongoose";
import { PgModelCatalogSnapshotsRepository } from "../../../repositories/control-plane-app/pg.repo";
import { sanitizePgJsonValue } from "../../../utils/message-sanitizer";
import { PgUsageStatsRepository } from "../../../repositories/usage-stats/pg.repo";
import { closePgConnections, getPgDirectDb, type MakoPgDb } from "../client";
import { parseEntityId, toWireId } from "../id-codec";
import {
  MODEL_CATALOG_SNAPSHOT_IDS,
  appsBoxPolicy,
  modelCatalogSnapshots,
  notificationDeliveries,
  notificationRules,
  workflowRecordedRuns,
  workflowRecordedWrites,
  type ModelCatalogSnapshotIdPg,
} from "../schema/control-plane-app";
import { workspaces } from "../schema/workspaces";

const BATCH_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const DELIVERY_TTL_MS = 90 * DAY_MS;
const RECORDED_TTL_MS = 7 * DAY_MS;

function loadCliEnv(): void {
  const candidates = [
    path.resolve(__dirname, "../../../../../.env"), // repo root
    path.resolve(__dirname, "../../../../.env"), // api/.env fallback
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, quiet: true });
    }
  }
}

type MongoDoc = Record<string, unknown> & { _id: unknown };

type Mode = "dry-run" | "apply" | "replay";

interface Parity {
  matched: number;
  different: number;
  missingInPg: number;
  pgOnly: number;
  differentFields: Record<string, number>;
}

interface TableReport {
  source: number;
  candidates: number;
  written: number;
  skipped: Record<string, number>;
  missingInMongo?: number;
  parity?: Parity;
}

function newReport(mode: Mode): TableReport {
  return {
    source: 0,
    candidates: 0,
    written: 0,
    skipped: {},
    ...(mode === "replay"
      ? {
          parity: {
            matched: 0,
            different: 0,
            missingInPg: 0,
            pgOnly: 0,
            differentFields: {},
          },
        }
      : {}),
  };
}

// Compare the JSON representation persisted by the drivers, including UTC
// timestamps and nested JSON values. Only column names and counts leave memory.
function compareRows<Row extends object>(
  report: TableReport,
  expected: Row[],
  actual: Row[],
  key: (row: Row) => string,
) {
  const parity = report.parity;
  if (!parity) throw new Error("Comparison requires replay mode");
  const target = new Map(actual.map(row => [key(row), row]));
  for (const row of expected) {
    const found = target.get(key(row));
    if (!found) {
      parity.missingInPg++;
      continue;
    }
    const sourceValues = JSON.parse(JSON.stringify(row)) as Record<
      string,
      unknown
    >;
    const targetValues = JSON.parse(JSON.stringify(found)) as Record<
      string,
      unknown
    >;
    const changed = Object.keys(sourceValues).filter(
      field => !isDeepStrictEqual(sourceValues[field], targetValues[field]),
    );
    if (!changed.length) {
      parity.matched++;
      continue;
    }
    parity.different++;
    for (const field of changed) {
      parity.differentFields[field] = (parity.differentFields[field] ?? 0) + 1;
    }
  }
}

function skip(report: TableReport, reason: string): void {
  report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
}

function idString(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value);
  return s.length > 0 ? s : null;
}

/** Mongo id (ObjectId or wire string) -> Postgres UUID, or null. */
function toPgUuid(value: unknown): string | null {
  return parseEntityId(idString(value))?.uuid ?? null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

type Retention = { field: "createdAt" | "at"; cutoff: Date; reason: string };

async function* readBatches(
  name: string,
  report: TableReport,
  retention?: Retention,
) {
  const collection = mongoose.connection.collection<MongoDoc>(name);
  // Compare BSON dates on the server, including the boundary. Read legacy
  // non-date values separately through the same cursor so they are accounted for.
  const filter = retention
    ? {
        $or: [
          { [retention.field]: { $gte: retention.cutoff } },
          { [retention.field]: { $not: { $type: "date" } } },
        ],
      }
    : {};
  if (retention) {
    const expired = await collection.countDocuments({
      [retention.field]: { $lt: retention.cutoff },
    });
    report.source += expired;
    if (expired) report.skipped[retention.reason] = expired;
  }
  const cursor = collection.find(filter).batchSize(BATCH_SIZE);
  try {
    let batch: MongoDoc[] = [];
    for await (const doc of cursor) {
      report.source++;
      batch.push(doc);
      if (batch.length === BATCH_SIZE) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length) yield batch;
  } finally {
    await cursor.close();
  }
}

async function existingWorkspaceIds(
  db: MakoPgDb,
  docs: MongoDoc[],
): Promise<Set<string>> {
  const unique = [
    ...new Set(
      docs.map(doc => toPgUuid(doc.workspaceId)).filter(id => id !== null),
    ),
  ];
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(inArray(workspaces.id, unique));
  return new Set(rows.map(r => r.id.toLowerCase()));
}

// Mongo stores notification rule IDs as ObjectIds. Accept wire strings from
// legacy imports as well when checking a bounded set of known IDs.
async function sourceRuleWorkspaces(
  ids: string[],
): Promise<Map<string, string | null>> {
  const keys: (Types.ObjectId | string)[] = [];
  for (const uuid of new Set(ids)) {
    const wire = toWireId(uuid);
    keys.push(uuid);
    if (Types.ObjectId.isValid(wire)) keys.push(wire, new Types.ObjectId(wire));
  }
  const found = new Map<string, string | null>();
  const rules = mongoose.connection.collection<{
    _id: Types.ObjectId | string;
    workspaceId: unknown;
  }>("notification_rules");
  for await (const rule of rules.find(
    { _id: { $in: keys } },
    { projection: { workspaceId: 1 } },
  )) {
    const id = toPgUuid(rule._id);
    if (id) found.set(id, toPgUuid(rule.workspaceId));
  }
  return found;
}

async function auditDeletedRules(db: MakoPgDb, report: TableReport) {
  report.missingInMongo = 0;
  let after: string | undefined;
  for (;;) {
    const imported: { id: string }[] = await db
      .select({ id: notificationRules.id })
      .from(notificationRules)
      .where(
        and(
          eq(notificationRules.importedFromMongo, true),
          after ? gt(notificationRules.id, after) : undefined,
        ),
      )
      .orderBy(asc(notificationRules.id))
      .limit(BATCH_SIZE);
    if (!imported.length) return;
    const ids = imported.map(r => r.id);
    const found = await sourceRuleWorkspaces(ids);
    const missing = ids.filter(id => !found.has(id));
    report.missingInMongo += missing.length;
    after = ids[ids.length - 1];
  }
}

async function backfillNotifications(
  db: MakoPgDb,
  mode: Mode,
  now: Date,
): Promise<{ rules: TableReport; deliveries: TableReport }> {
  const rules = newReport(mode);
  const deliveries = newReport(mode);
  const users = new PgUsageStatsRepository({ getDb: () => db });

  for await (const docs of readBatches("notification_rules", rules)) {
    const wsIds = await existingWorkspaceIds(db, docs);
    const rows: (typeof notificationRules.$inferSelect)[] = [];
    for (const doc of docs) {
      const id = toPgUuid(doc._id);
      const ws = toPgUuid(doc.workspaceId);
      const resource = toPgUuid(doc.resourceId);
      const resourceType = doc.resourceType;
      const triggers = Array.isArray(doc.triggers)
        ? doc.triggers.filter(
            (t): t is string => t === "success" || t === "failure",
          )
        : [];
      if (!id || !ws || !resource) {
        skip(rules, "invalid id");
        continue;
      }
      if (!wsIds.has(ws)) {
        skip(rules, "workspace missing in Postgres");
        continue;
      }
      if (resourceType !== "scheduled_query" && resourceType !== "flow") {
        skip(rules, "invalid resourceType");
        continue;
      }
      if (triggers.length === 0 || !doc.channel) {
        skip(rules, "invalid triggers or channel");
        continue;
      }
      const createdAt = toDate(doc.createdAt);
      const updatedAt = toDate(doc.updatedAt) ?? createdAt;
      if (!createdAt || !updatedAt) {
        skip(rules, "invalid timestamp");
        continue;
      }
      rules.candidates++;
      if (mode === "dry-run") continue;

      const createdBy = idString(doc.createdBy) ?? "unknown";
      rows.push({
        importedFromMongo: true,
        id,
        workspaceId: ws,
        resourceType,
        resourceId: resource,
        enabled: doc.enabled !== false,
        triggers,
        // Encrypted fields copied verbatim: never decrypt or re-encrypt.
        channel: doc.channel as Record<string, unknown>,
        createdByUserId: await users.resolveNullableUserUuid(createdBy, db),
        createdBy,
        createdAt,
        updatedAt,
      });
    }
    if (mode === "replay" && rows.length) {
      const actual = await db
        .select()
        .from(notificationRules)
        .where(
          inArray(
            notificationRules.id,
            rows.map(r => r.id),
          ),
        );
      compareRows(rules, rows, actual, r => r.id);
    } else if (rows.length) {
      const changed = await db
        .insert(notificationRules)
        .values(rows)
        .onConflictDoUpdate({
          target: notificationRules.id,
          set: {
            enabled: sql`excluded.enabled`,
            triggers: sql`excluded.triggers`,
            channel: sql`excluded.channel`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`notification_rules.imported_from_mongo
          AND notification_rules.workspace_id = excluded.workspace_id
          AND notification_rules.updated_at <= excluded.updated_at
          AND (notification_rules.enabled, notification_rules.triggers, notification_rules.channel, notification_rules.updated_at)
              IS DISTINCT FROM (excluded.enabled, excluded.triggers, excluded.channel, excluded.updated_at)`,
        })
        .returning({ id: notificationRules.id });
      rules.written += changed.length;
    }
  }

  const retention = {
    field: "createdAt",
    cutoff: new Date(now.getTime() - DELIVERY_TTL_MS),
    reason: "older than 90d TTL",
  } as const;
  for await (const docs of readBatches(
    "notification_deliveries",
    deliveries,
    retention,
  )) {
    const wsIds = await existingWorkspaceIds(db, docs);
    const ruleWorkspaces = await sourceRuleWorkspaces(
      docs.map(d => toPgUuid(d.ruleId)).filter(id => id !== null),
    );
    const rows: (typeof notificationDeliveries.$inferSelect)[] = [];
    for (const doc of docs) {
      const id = toPgUuid(doc._id);
      const ws = toPgUuid(doc.workspaceId);
      const ruleId = toPgUuid(doc.ruleId);
      const resource = toPgUuid(doc.resourceId);
      const createdAt = toDate(doc.createdAt);
      if (!createdAt) {
        skip(deliveries, "invalid createdAt");
        continue;
      }
      const status = doc.status;
      if (!id || !ws || !ruleId || !resource) {
        skip(deliveries, "invalid id");
        continue;
      }
      if (now.getTime() - createdAt.getTime() > DELIVERY_TTL_MS) {
        skip(deliveries, "older than 90d TTL");
        continue;
      }
      if (!wsIds.has(ws)) {
        skip(deliveries, "workspace missing in Postgres");
        continue;
      }
      if (ruleWorkspaces.has(ruleId) && ruleWorkspaces.get(ruleId) !== ws) {
        skip(deliveries, "rule belongs to another workspace");
        continue;
      }
      if (
        status !== "pending" &&
        status !== "sent" &&
        status !== "failed" &&
        status !== "skipped"
      ) {
        skip(deliveries, "invalid status");
        continue;
      }
      if (
        doc.resourceType !== "scheduled_query" &&
        doc.resourceType !== "flow"
      ) {
        skip(deliveries, "invalid resourceType");
        continue;
      }
      if (
        typeof doc.runId !== "string" ||
        !doc.runId ||
        typeof doc.idempotencyKey !== "string" ||
        !doc.idempotencyKey ||
        (doc.trigger !== "success" && doc.trigger !== "failure") ||
        (doc.channelType !== "email" &&
          doc.channelType !== "slack" &&
          doc.channelType !== "webhook")
      ) {
        skip(deliveries, "invalid delivery details");
        continue;
      }
      deliveries.candidates++;
      if (mode === "dry-run") continue;

      rows.push({
        id,
        workspaceId: ws,
        ruleId,
        resourceType: doc.resourceType,
        resourceId: resource,
        runId: doc.runId,
        trigger: doc.trigger,
        channelType: doc.channelType,
        idempotencyKey: doc.idempotencyKey,
        status,
        attempts: typeof doc.attempts === "number" ? doc.attempts : 0,
        lastError: typeof doc.lastError === "string" ? doc.lastError : null,
        httpStatus: typeof doc.httpStatus === "number" ? doc.httpStatus : null,
        sentAt: toDate(doc.sentAt),
        completedAt: toDate(doc.completedAt),
        createdAt,
      });
    }
    if (mode === "replay" && rows.length) {
      const actual = await db
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            inArray(
              notificationDeliveries.idempotencyKey,
              rows.map(r => r.idempotencyKey),
            ),
            gte(notificationDeliveries.createdAt, retention.cutoff),
          ),
        );
      compareRows(deliveries, rows, actual, r => r.idempotencyKey);
    } else if (rows.length) {
      const changed = await db
        .insert(notificationDeliveries)
        .values(rows)
        .onConflictDoUpdate({
          target: notificationDeliveries.idempotencyKey,
          set: {
            status: sql`excluded.status`,
            attempts: sql`excluded.attempts`,
            lastError: sql`excluded.last_error`,
            httpStatus: sql`excluded.http_status`,
            sentAt: sql`excluded.sent_at`,
            completedAt: sql`excluded.completed_at`,
          },
          setWhere: sql`notification_deliveries.workspace_id = excluded.workspace_id
          AND (notification_deliveries.status = 'pending' OR (excluded.status <> 'pending'
            AND (coalesce(excluded.completed_at, '-infinity'), excluded.attempts)
             >= (coalesce(notification_deliveries.completed_at, '-infinity'), notification_deliveries.attempts)))
          AND (notification_deliveries.status, notification_deliveries.attempts, notification_deliveries.last_error,
               notification_deliveries.http_status, notification_deliveries.sent_at, notification_deliveries.completed_at)
            IS DISTINCT FROM (excluded.status, excluded.attempts, excluded.last_error, excluded.http_status, excluded.sent_at, excluded.completed_at)`,
        })
        .returning({ id: notificationDeliveries.id });
      deliveries.written += changed.length;
    }
  }

  return { rules, deliveries };
}

async function backfillRecordedWrites(
  db: MakoPgDb,
  mode: Mode,
  now: Date,
): Promise<{ runs: TableReport; writes: TableReport }> {
  const runs = newReport(mode);
  const writes = newReport(mode);
  const retention = {
    field: "at",
    cutoff: new Date(now.getTime() - RECORDED_TTL_MS),
    reason: "older than 7d TTL",
  } as const;
  for await (const docs of readBatches(
    "workflow_recorded_runs",
    runs,
    retention,
  )) {
    const wsIds = await existingWorkspaceIds(db, docs);
    const rows: (typeof workflowRecordedRuns.$inferSelect)[] = [];
    for (const doc of docs) {
      const id = toPgUuid(doc._id);
      const ws = toPgUuid(doc.workspaceId);
      const at = toDate(doc.at);
      if (!at) {
        skip(runs, "invalid at");
        continue;
      }
      if (!id || !ws || typeof doc.runId !== "string") {
        skip(runs, "invalid id");
        continue;
      }
      if (now.getTime() - at.getTime() > RECORDED_TTL_MS) {
        skip(runs, "older than 7d TTL");
        continue;
      }
      if (!wsIds.has(ws)) {
        skip(runs, "workspace missing in Postgres");
        continue;
      }
      runs.candidates++;
      if (mode === "dry-run") continue;
      const count = typeof doc.count === "number" ? doc.count : 0;
      rows.push({ id, workspaceId: ws, runId: doc.runId, count, at });
    }
    if (!rows.length) continue;
    if (mode === "replay") {
      const actual = await db
        .select()
        .from(workflowRecordedRuns)
        .where(
          and(
            gte(workflowRecordedRuns.at, retention.cutoff),
            or(
              ...rows.map(r =>
                and(
                  eq(workflowRecordedRuns.workspaceId, r.workspaceId),
                  eq(workflowRecordedRuns.runId, r.runId),
                ),
              ),
            ),
          ),
        );
      compareRows(runs, rows, actual, r =>
        JSON.stringify([r.workspaceId, r.runId]),
      );
      continue;
    }
    const result = await db
      .insert(workflowRecordedRuns)
      .values(rows)
      .onConflictDoUpdate({
        target: [workflowRecordedRuns.workspaceId, workflowRecordedRuns.runId],
        set: {
          count: sql`GREATEST(${workflowRecordedRuns.count}, excluded."count")`,
        },
        setWhere: sql`${workflowRecordedRuns.count} < excluded."count"`,
      })
      .returning({ id: workflowRecordedRuns.id });
    runs.written += result.length;
  }

  for await (const docs of readBatches(
    "workflow_recorded_writes",
    writes,
    retention,
  )) {
    const wsIds = await existingWorkspaceIds(db, docs);
    const rows: (typeof workflowRecordedWrites.$inferSelect)[] = [];
    for (const doc of docs) {
      const id = toPgUuid(doc._id);
      const ws = toPgUuid(doc.workspaceId);
      const connectionId = toPgUuid(doc.connectionId);
      const at = toDate(doc.at);
      if (!at) {
        skip(writes, "invalid at");
        continue;
      }
      if (
        !id ||
        !ws ||
        !connectionId ||
        typeof doc.runId !== "string" ||
        typeof doc.seq !== "number" ||
        !doc.request
      ) {
        skip(writes, "invalid row");
        continue;
      }
      if (now.getTime() - at.getTime() > RECORDED_TTL_MS) {
        skip(writes, "older than 7d TTL");
        continue;
      }
      if (!wsIds.has(ws)) {
        skip(writes, "workspace missing in Postgres");
        continue;
      }
      writes.candidates++;
      if (mode === "dry-run") continue;
      rows.push({
        id,
        workspaceId: ws,
        runId: doc.runId,
        userId: typeof doc.userId === "string" ? doc.userId : null,
        connectionId,
        connection: String(doc.connection ?? ""),
        step: typeof doc.step === "string" ? doc.step : null,
        request: sanitizePgJsonValue(doc.request as Record<string, unknown>),
        seq: doc.seq,
        bodyCut: typeof doc.bodyCut === "boolean" ? doc.bodyCut : null,
        wouldSend: typeof doc.wouldSend === "boolean" ? doc.wouldSend : null,
        at,
      });
    }
    if (!rows.length) continue;
    if (mode === "replay") {
      const actual = await db
        .select()
        .from(workflowRecordedWrites)
        .where(
          and(
            gte(workflowRecordedWrites.at, retention.cutoff),
            or(
              ...rows.map(r =>
                and(
                  eq(workflowRecordedWrites.workspaceId, r.workspaceId),
                  eq(workflowRecordedWrites.runId, r.runId),
                  eq(workflowRecordedWrites.seq, r.seq),
                ),
              ),
            ),
          ),
        );
      compareRows(writes, rows, actual, r =>
        JSON.stringify([r.workspaceId, r.runId, r.seq]),
      );
      continue;
    }
    const inserted = await db
      .insert(workflowRecordedWrites)
      .values(rows)
      .onConflictDoNothing({ target: workflowRecordedWrites.id })
      .returning({ id: workflowRecordedWrites.id });
    writes.written += inserted.length;
  }

  return { runs, writes };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function backfillGlobalConfig(
  db: MakoPgDb,
  mode: Mode,
): Promise<{ snapshots: TableReport; boxPolicy: TableReport }> {
  const snapshots = newReport(mode);
  const boxPolicy = newReport(mode);
  const repo = new PgModelCatalogSnapshotsRepository({ getDb: () => db });
  const knownIds = new Set<string>(MODEL_CATALOG_SNAPSHOT_IDS);
  for await (const docs of readBatches("modelcatalogsnapshots", snapshots)) {
    for (const doc of docs) {
      const id = idString(doc._id);
      if (!id || !knownIds.has(id)) {
        skip(snapshots, "unknown snapshot id");
        continue;
      }
      const fetchedAt = toDate(doc.fetchedAt);
      if (!fetchedAt) {
        skip(snapshots, "invalid fetchedAt");
        continue;
      }
      snapshots.candidates++;
      if (mode === "dry-run") continue;
      const data = doc.data === undefined ? [] : doc.data;
      const itemCount = typeof doc.itemCount === "number" ? doc.itemCount : 0;
      if (mode === "replay") {
        const expected = {
          id: id as ModelCatalogSnapshotIdPg,
          data,
          fetchedAt,
          itemCount,
        };
        const actual = await db
          .select()
          .from(modelCatalogSnapshots)
          .where(eq(modelCatalogSnapshots.id, expected.id));
        compareRows(snapshots, [expected], actual, r => r.id);
        continue;
      }
      if (id === "capabilities") {
        // Use the same transaction lock as the runtime thinking-mode probe.
        const written = await repo.mutateSnapshot(id, current => {
          if (!current) return { data, fetchedAt, itemCount };
          const sourceIsNewer = fetchedAt >= current.fetchedAt;
          const older = asObject(sourceIsNewer ? current.data : data);
          const newer = asObject(sourceIsNewer ? data : current.data);
          const thinkingModes = {
            ...asObject(older.thinkingModes),
            ...asObject(newer.thinkingModes),
          };
          const merged = { ...older, ...newer, thinkingModes };
          const count = Object.keys(thinkingModes).length;
          const latest = sourceIsNewer ? fetchedAt : current.fetchedAt;
          if (
            isDeepStrictEqual(merged, current.data) &&
            count === current.itemCount &&
            latest.getTime() === current.fetchedAt.getTime()
          ) {
            return null;
          }
          return { data: merged, itemCount: count, fetchedAt: latest };
        });
        if (written) snapshots.written++;
        continue;
      }

      // An admin refresh before import can create an empty curation with just
      // lastRefreshError. Recover its settings and retain the latest error.
      const target = modelCatalogSnapshots;
      const restoreCuration = sql`excluded.id = 'curation' AND excluded.fetched_at < ${target.fetchedAt}
        AND coalesce(${target.data}->'models', '[]'::jsonb) = '[]'::jsonb
        AND ${target.data}->>'defaultChatModelId' IS NULL
        AND ${target.data}->>'defaultFreeChatModelId' IS NULL
        AND ${target.data}->>'utilityModelId' IS NULL`;
      const mergedData = sql`CASE WHEN ${restoreCuration}
        THEN excluded.data || jsonb_build_object('lastRefreshError', ${target.data}->'lastRefreshError')
        ELSE excluded.data END`;
      const changed = await db
        .insert(target)
        .values({
          id: id as ModelCatalogSnapshotIdPg,
          data,
          itemCount,
          fetchedAt,
        })
        .onConflictDoUpdate({
          target: target.id,
          set: {
            data: mergedData,
            itemCount: sql`excluded.item_count`,
            fetchedAt: sql`greatest(${target.fetchedAt}, excluded.fetched_at)`,
          },
          setWhere: sql`(excluded.fetched_at >= ${target.fetchedAt} OR ${restoreCuration})
            AND (excluded.fetched_at > ${target.fetchedAt} OR (${target.data}, ${target.itemCount})
              IS DISTINCT FROM (${mergedData}, excluded.item_count))`,
        })
        .returning({ id: target.id });
      snapshots.written += changed.length;
    }
  }

  for await (const docs of readBatches("apps_box_policy", boxPolicy)) {
    const rows: (typeof appsBoxPolicy.$inferSelect)[] = [];
    for (const doc of docs) {
      const id = idString(doc._id);
      const since = toDate(doc.since);
      if (!id || !since) {
        skip(boxPolicy, "invalid row");
        continue;
      }
      boxPolicy.candidates++;
      if (mode === "dry-run") continue;
      rows.push({ id, since });
    }
    if (!rows.length) continue;
    if (mode === "replay") {
      const actual = await db
        .select()
        .from(appsBoxPolicy)
        .where(
          inArray(
            appsBoxPolicy.id,
            rows.map(r => r.id),
          ),
        );
      compareRows(boxPolicy, rows, actual, r => r.id);
      continue;
    }
    const inserted = await db
      .insert(appsBoxPolicy)
      .values(rows)
      .onConflictDoUpdate({
        target: appsBoxPolicy.id,
        set: { since: sql`excluded.since` },
        setWhere: sql`${appsBoxPolicy.since} > excluded.since`,
      })
      .returning({ id: appsBoxPolicy.id });
    boxPolicy.written += inserted.length;
  }

  return { snapshots, boxPolicy };
}

async function runBackfill(
  db: MakoPgDb,
  mode: Mode,
  now: Date,
  checkDeleted: boolean,
): Promise<Record<string, TableReport>> {
  const { rules, deliveries } = await backfillNotifications(db, mode, now);
  if (checkDeleted || mode === "replay") await auditDeletedRules(db, rules);
  const { runs, writes } = await backfillRecordedWrites(db, mode, now);
  const { snapshots, boxPolicy } = await backfillGlobalConfig(db, mode);

  if (mode === "replay") {
    const deliveryCutoff = new Date(now.getTime() - DELIVERY_TTL_MS);
    const recordedCutoff = new Date(now.getTime() - RECORDED_TTL_MS);
    const counts = [
      [rules, await db.$count(notificationRules)],
      [
        deliveries,
        await db.$count(
          notificationDeliveries,
          gte(notificationDeliveries.createdAt, deliveryCutoff),
        ),
      ],
      [
        runs,
        await db.$count(
          workflowRecordedRuns,
          gte(workflowRecordedRuns.at, recordedCutoff),
        ),
      ],
      [
        writes,
        await db.$count(
          workflowRecordedWrites,
          gte(workflowRecordedWrites.at, recordedCutoff),
        ),
      ],
      [snapshots, await db.$count(modelCatalogSnapshots)],
      [boxPolicy, await db.$count(appsBoxPolicy)],
    ] as const;
    for (const [report, total] of counts) {
      const parity = report.parity;
      if (parity) parity.pgOnly = total - parity.matched - parity.different;
    }
  }
  return {
    notification_rules: rules,
    notification_deliveries: deliveries,
    workflow_recorded_runs: runs,
    workflow_recorded_writes: writes,
    model_catalog_snapshots: snapshots,
    apps_box_policy: boxPolicy,
  };
}

export async function backfillControlPlaneSmall(options: {
  db: MakoPgDb;
  apply: boolean;
  replay?: boolean;
  now?: Date;
  reconcileDeletedRules?: boolean;
}): Promise<Record<string, TableReport>> {
  const now = options.now ?? new Date();
  if (options.replay) {
    if (options.apply) {
      throw new Error("--replay and --apply are mutually exclusive");
    }
    // One consistent target snapshot even while the new revision accepts writes.
    // The database itself rejects any accidental write on this path.
    return options.db.transaction(
      tx => runBackfill(tx as unknown as MakoPgDb, "replay", now, true),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  return runBackfill(
    options.db,
    options.apply ? "apply" : "dry-run",
    now,
    Boolean(options.reconcileDeletedRules),
  );
}

async function main(): Promise<void> {
  loadCliEnv();
  const argv =
    process.argv[2] === "--"
      ? [process.argv[0], process.argv[1], ...process.argv.slice(3)]
      : process.argv;
  const program = new Command()
    .name("backfill-control-plane-small")
    .description(
      "Copy notifications, workflow recorded writes and global config from MongoDB to Postgres",
    )
    .option(
      "--reconcile-deleted-rules",
      "Audit imported rules missing from Mongo (always read-only for deletions)",
    )
    .option(
      "--as-of <timestamp>",
      "Fixed ISO timestamp for retention cutoffs during replay and parity checks",
    )
    .option(
      "--replay",
      "Read-only content comparison against Postgres; exit 2 on differences",
    )
    .option(
      "--apply",
      "Copy eligible rows before switching traffic (default is a dry run)",
    );
  program.parse(argv);
  const {
    apply = false,
    replay = false,
    reconcileDeletedRules = false,
    asOf,
  } = program.opts<{
    asOf?: string;
    apply?: boolean;
    replay?: boolean;
    reconcileDeletedRules?: boolean;
  }>();

  if (apply && replay) {
    process.stderr.write("--replay and --apply are mutually exclusive.\n");
    process.exitCode = 1;
    return;
  }
  const now = asOf === undefined ? new Date() : toDate(asOf);
  if (!now) {
    process.stderr.write("Invalid --as-of timestamp.\n");
    process.exitCode = 1;
    return;
  }
  const mongoUri = process.env.DATABASE_URL;
  if (
    !mongoUri ||
    !(process.env.POSTGRES_DIRECT_URL || process.env.POSTGRES_URL)
  ) {
    process.stderr.write(
      "Set DATABASE_URL and either POSTGRES_DIRECT_URL or POSTGRES_URL.\n",
    );
    process.exitCode = 1;
    return;
  }
  await mongoose.connect(mongoUri, { autoCreate: false, autoIndex: false });
  try {
    const reports = await backfillControlPlaneSmall({
      db: getPgDirectDb(),
      now,
      apply,
      replay,
      reconcileDeletedRules,
    });
    process.stdout.write(
      `${replay ? "READ-ONLY REPLAY" : apply ? "PRE-CUTOVER APPLY" : "DRY RUN (pass --apply to write)"} as_of=${now.toISOString()}\n`,
    );
    for (const [table, r] of Object.entries(reports)) {
      const skipped = Object.entries(r.skipped)
        .map(([reason, n]) => `${reason}=${n}`)
        .join(", ");
      process.stdout.write(
        `${table}: source=${r.source} candidates=${r.candidates}` +
          `${apply ? ` written=${r.written}` : ""}` +
          `${r.missingInMongo === undefined ? "" : ` missingInMongo=${r.missingInMongo}`}` +
          `${r.parity ? ` parity=${JSON.stringify(r.parity)}` : ""}` +
          `${skipped ? ` skipped[${skipped}]` : ""}\n`,
      );
      if (
        r.parity &&
        (r.parity.different ||
          r.parity.missingInPg ||
          r.parity.pgOnly ||
          r.missingInMongo ||
          Object.keys(r.skipped).some(
            reason =>
              reason !== "older than 7d TTL" && reason !== "older than 90d TTL",
          ))
      ) {
        process.exitCode = 2;
      }
    }
  } finally {
    await mongoose.disconnect();
    await closePgConnections();
  }
}

if (require.main === module) {
  main().catch(error => {
    // Driver messages may include connection strings and bound channel or request data.
    const name = error instanceof Error ? error.name : "unknown error";
    process.stderr.write(`backfill-control-plane-small failed (${name}).\n`);
    process.exitCode = 1;
  });
}
