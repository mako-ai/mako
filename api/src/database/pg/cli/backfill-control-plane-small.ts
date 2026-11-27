/**
 * CLI: one-shot idempotent copy of the small app control-plane collections
 * from MongoDB into Postgres (migration `0012`).
 *
 *   notification_rules, notification_deliveries,
 *   workflow_recorded_runs, workflow_recorded_writes,
 *   modelcatalogsnapshots -> model_catalog_snapshots, apps_box_policy
 *
 * Dry run by default: prints per-table counts only (never a document body,
 * channel, URL or secret). `--apply` writes. Safe to re-run:
 *   - rules, deliveries, recorded writes: `ON CONFLICT DO NOTHING`
 *   - recorded runs: `count = GREATEST(count, excluded.count)`
 *   - box policy: preserve the earliest tracking start
 *   - snapshots: overwritten only when Mongo's `fetchedAt` is newer
 * Rows whose workspace (or rule) is missing in Postgres, or that the TTL
 * would reap anyway, are skipped and counted.
 *
 * Usage:
 *   pnpm --filter api exec tsx src/database/pg/cli/backfill-control-plane-small.ts
 *   pnpm --filter api exec tsx src/database/pg/cli/backfill-control-plane-small.ts --apply
 */
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import dotenv from "dotenv";
import { inArray, sql } from "drizzle-orm";
import mongoose from "mongoose";
import { PgUsageStatsRepository } from "../../../repositories/usage-stats/pg.repo";
import { closePgConnections, getPgDirectDb, type MakoPgDb } from "../client";
import { parseEntityId } from "../id-codec";
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

interface TableReport {
  source: number;
  candidates: number;
  written: number;
  skipped: Record<string, number>;
}

function newReport(): TableReport {
  return { source: 0, candidates: 0, written: 0, skipped: {} };
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

async function readCollection(name: string): Promise<MongoDoc[]> {
  return mongoose.connection
    .collection<MongoDoc>(name)
    .find({})
    .toArray() as Promise<MongoDoc[]>;
}

async function existingWorkspaceIds(
  db: MakoPgDb,
  ids: string[],
): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(inArray(workspaces.id, unique));
  return new Set(rows.map(r => r.id.toLowerCase()));
}

async function backfillNotifications(
  db: MakoPgDb,
  apply: boolean,
  now: Date,
): Promise<{ rules: TableReport; deliveries: TableReport }> {
  const rules = newReport();
  const deliveries = newReport();
  const users = new PgUsageStatsRepository({ getDb: () => db });

  const ruleDocs = await readCollection("notification_rules");
  const deliveryDocs = await readCollection("notification_deliveries");
  rules.source = ruleDocs.length;
  deliveries.source = deliveryDocs.length;

  const wsIds = await existingWorkspaceIds(
    db,
    [...ruleDocs, ...deliveryDocs]
      .map(d => toPgUuid(d.workspaceId))
      .filter((v): v is string => v !== null),
  );

  const ruleWorkspaces = new Map<string, string>();
  for (const doc of ruleDocs) {
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
    ruleWorkspaces.set(id, ws);
    rules.candidates++;
    if (!apply) continue;

    const createdBy = idString(doc.createdBy) ?? "unknown";
    const createdAt = toDate(doc.createdAt) ?? now;
    const inserted = await db
      .insert(notificationRules)
      .values({
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
        updatedAt: toDate(doc.updatedAt) ?? createdAt,
      })
      .onConflictDoNothing()
      .returning({ id: notificationRules.id });
    rules.written += inserted.length;
  }

  // Rules already in Postgres (a re-run, or created there after cutover).
  if (deliveryDocs.length > 0) {
    const wanted = deliveryDocs
      .map(d => toPgUuid(d.ruleId))
      .filter((v): v is string => v !== null);
    if (wanted.length > 0) {
      const rows = await db
        .select({
          id: notificationRules.id,
          workspaceId: notificationRules.workspaceId,
        })
        .from(notificationRules)
        .where(inArray(notificationRules.id, [...new Set(wanted)]));
      for (const row of rows) ruleWorkspaces.set(row.id, row.workspaceId);
    }
  }

  for (const doc of deliveryDocs) {
    const id = toPgUuid(doc._id);
    const ws = toPgUuid(doc.workspaceId);
    const ruleId = toPgUuid(doc.ruleId);
    const resource = toPgUuid(doc.resourceId);
    const createdAt = toDate(doc.createdAt) ?? now;
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
    if (ruleWorkspaces.get(ruleId) !== ws) {
      skip(deliveries, "rule missing (deleted or skipped)");
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
    if (doc.resourceType !== "scheduled_query" && doc.resourceType !== "flow") {
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
    if (!apply) continue;

    const inserted = await db
      .insert(notificationDeliveries)
      .values({
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
      })
      // Either the id or the idempotency key already present: keep Postgres.
      .onConflictDoNothing()
      .returning({ id: notificationDeliveries.id });
    deliveries.written += inserted.length;
  }

  return { rules, deliveries };
}

async function backfillRecordedWrites(
  db: MakoPgDb,
  apply: boolean,
  now: Date,
): Promise<{ runs: TableReport; writes: TableReport }> {
  const runs = newReport();
  const writes = newReport();
  const runDocs = await readCollection("workflow_recorded_runs");
  const writeDocs = await readCollection("workflow_recorded_writes");
  runs.source = runDocs.length;
  writes.source = writeDocs.length;

  const wsIds = await existingWorkspaceIds(
    db,
    [...runDocs, ...writeDocs]
      .map(d => toPgUuid(d.workspaceId))
      .filter((v): v is string => v !== null),
  );

  for (const doc of runDocs) {
    const id = toPgUuid(doc._id);
    const ws = toPgUuid(doc.workspaceId);
    const at = toDate(doc.at) ?? now;
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
    if (!apply) continue;
    const count = typeof doc.count === "number" ? doc.count : 0;
    const result = await db
      .insert(workflowRecordedRuns)
      .values({ id, workspaceId: ws, runId: doc.runId, count, at })
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

  for (const doc of writeDocs) {
    const id = toPgUuid(doc._id);
    const ws = toPgUuid(doc.workspaceId);
    const connectionId = toPgUuid(doc.connectionId);
    const at = toDate(doc.at) ?? now;
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
    if (!apply) continue;
    const inserted = await db
      .insert(workflowRecordedWrites)
      .values({
        id,
        workspaceId: ws,
        runId: doc.runId,
        userId: typeof doc.userId === "string" ? doc.userId : null,
        connectionId,
        connection: String(doc.connection ?? ""),
        step: typeof doc.step === "string" ? doc.step : null,
        request: doc.request as Record<string, unknown>,
        seq: doc.seq,
        bodyCut: typeof doc.bodyCut === "boolean" ? doc.bodyCut : null,
        wouldSend: typeof doc.wouldSend === "boolean" ? doc.wouldSend : null,
        at,
      })
      .onConflictDoNothing()
      .returning({ id: workflowRecordedWrites.id });
    writes.written += inserted.length;
  }

  return { runs, writes };
}

async function backfillGlobalConfig(
  db: MakoPgDb,
  apply: boolean,
): Promise<{ snapshots: TableReport; boxPolicy: TableReport }> {
  const snapshots = newReport();
  const boxPolicy = newReport();
  const snapshotDocs = await readCollection("modelcatalogsnapshots");
  const policyDocs = await readCollection("apps_box_policy");
  snapshots.source = snapshotDocs.length;
  boxPolicy.source = policyDocs.length;

  const knownIds = new Set<string>(MODEL_CATALOG_SNAPSHOT_IDS);
  for (const doc of snapshotDocs) {
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
    if (!apply) continue;
    const data = doc.data === undefined ? [] : doc.data;
    const itemCount = typeof doc.itemCount === "number" ? doc.itemCount : 0;
    const result = await db
      .insert(modelCatalogSnapshots)
      .values({
        id: id as ModelCatalogSnapshotIdPg,
        data,
        fetchedAt,
        itemCount,
      })
      .onConflictDoUpdate({
        target: modelCatalogSnapshots.id,
        set: { data, fetchedAt, itemCount },
        // Never let a stale Mongo copy overwrite a fresher Postgres refresh.
        setWhere: sql`${modelCatalogSnapshots.fetchedAt} < excluded."fetched_at"`,
      })
      .returning({ id: modelCatalogSnapshots.id });
    snapshots.written += result.length;
  }

  for (const doc of policyDocs) {
    const id = idString(doc._id);
    const since = toDate(doc.since);
    if (!id || !since) {
      skip(boxPolicy, "invalid row");
      continue;
    }
    boxPolicy.candidates++;
    if (!apply) continue;
    const inserted = await db
      .insert(appsBoxPolicy)
      .values({ id, since })
      .onConflictDoUpdate({
        target: appsBoxPolicy.id,
        set: { since },
        setWhere: sql`${appsBoxPolicy.since} > excluded.since`,
      })
      .returning({ id: appsBoxPolicy.id });
    boxPolicy.written += inserted.length;
  }

  return { snapshots, boxPolicy };
}

export async function backfillControlPlaneSmall(options: {
  db: MakoPgDb;
  apply: boolean;
  now?: Date;
}): Promise<Record<string, TableReport>> {
  const now = options.now ?? new Date();
  const { rules, deliveries } = await backfillNotifications(
    options.db,
    options.apply,
    now,
  );
  const { runs, writes } = await backfillRecordedWrites(
    options.db,
    options.apply,
    now,
  );
  const { snapshots, boxPolicy } = await backfillGlobalConfig(
    options.db,
    options.apply,
  );
  return {
    notification_rules: rules,
    notification_deliveries: deliveries,
    workflow_recorded_runs: runs,
    workflow_recorded_writes: writes,
    model_catalog_snapshots: snapshots,
    apps_box_policy: boxPolicy,
  };
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
    .option("--apply", "Write to Postgres (default is a dry run)");
  program.parse(argv);
  const { apply = false } = program.opts<{ apply?: boolean }>();

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
      apply,
    });
    process.stdout.write(
      `${apply ? "APPLY" : "DRY RUN (pass --apply to write)"}\n`,
    );
    for (const [table, r] of Object.entries(reports)) {
      const skipped = Object.entries(r.skipped)
        .map(([reason, n]) => `${reason}=${n}`)
        .join(", ");
      process.stdout.write(
        `${table}: source=${r.source} candidates=${r.candidates}` +
          `${apply ? ` written=${r.written}` : ""}` +
          `${skipped ? ` skipped[${skipped}]` : ""}\n`,
      );
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
