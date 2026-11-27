/**
 * Postgres (Neon / Drizzle) implementations of the small app control-plane
 * repositories.
 *
 *   - `appendWrite` reserves the next sequence and saves the request in one statement.
 *   - `mutateSnapshot` serializes read-modify-write on one snapshot id with a
 *     transaction-scoped advisory lock, even when the row does not exist yet.
 *   - `ensureSince` is `INSERT ... ON CONFLICT DO NOTHING` + `SELECT`.
 */
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { RecordedRequest } from "../../connections/forward";
import { extractRows, getPgDb, type MakoPgDb } from "../../database/pg/client";
import { parseEntityId } from "../../database/pg/id-codec";
import {
  appsBoxPolicy,
  modelCatalogSnapshots,
  workflowRecordedWrites,
} from "../../database/pg/schema/control-plane-app";
import type {
  AppsBoxPolicyRepository,
  ModelCatalogSnapshotId,
  ModelCatalogSnapshotRecord,
  ModelCatalogSnapshotWrite,
  ModelCatalogSnapshotsRepository,
  RecordedWriteInput,
  RecordedWriteRow,
  RecordedWritesFilter,
  WorkflowRecordedWritesRepository,
} from "./types";

function requirePgUuid(id: string, label: string): string {
  const parsed = parseEntityId(id);
  if (!parsed) throw new Error(`Invalid ${label}: ${JSON.stringify(id)}`);
  return parsed.uuid;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

// ── Workflow recorded writes ────────────────────────────────────────────

export class PgWorkflowRecordedWritesRepository implements WorkflowRecordedWritesRepository {
  private readonly getDb: () => MakoPgDb;

  constructor(options: { getDb?: () => MakoPgDb } = {}) {
    this.getDb = options.getDb ?? getPgDb;
  }

  async appendWrite(
    input: RecordedWriteInput,
    max: number,
  ): Promise<number | null> {
    const workspace = requirePgUuid(input.workspaceId, "workspace id");
    const connection = requirePgUuid(input.connectionId, "connection id");
    const result = await this.getDb().execute(sql`
      WITH place AS (
        INSERT INTO workflow_recorded_runs (workspace_id, run_id, count)
        VALUES (${workspace}::uuid, ${input.runId}, 1)
        ON CONFLICT (workspace_id, run_id) DO UPDATE
          SET count = workflow_recorded_runs.count + 1
          WHERE workflow_recorded_runs.count < ${max}
        RETURNING workspace_id, run_id, count - 1 AS seq
      )
      INSERT INTO workflow_recorded_writes
        (workspace_id, run_id, seq, user_id, connection_id, connection, step,
         request, body_cut, would_send)
      SELECT workspace_id, run_id, seq, ${input.userId ?? null},
             ${connection}::uuid, ${input.connection}, ${input.step ?? null},
             ${JSON.stringify(input.request)}::jsonb, ${input.bodyCut ?? null},
             ${input.wouldSend ?? null}
        FROM place
      RETURNING seq
    `);
    return extractRows<{ seq: number }>(result)[0]?.seq ?? null;
  }

  private where(filter: RecordedWritesFilter) {
    const ws = parseEntityId(filter.workspaceId)?.uuid;
    if (!ws) return null;
    return and(
      eq(workflowRecordedWrites.workspaceId, ws),
      eq(workflowRecordedWrites.runId, filter.runId),
      ...(filter.userId !== undefined
        ? [eq(workflowRecordedWrites.userId, filter.userId)]
        : []),
    );
  }

  async countWrites(filter: RecordedWritesFilter): Promise<number> {
    const where = this.where(filter);
    if (!where) return 0;
    const rows = await this.getDb()
      .select({ n: count() })
      .from(workflowRecordedWrites)
      .where(where);
    return Number(rows[0]?.n ?? 0);
  }

  async listWrites(
    filter: RecordedWritesFilter,
    page: { offset: number; limit: number },
  ): Promise<RecordedWriteRow[]> {
    const where = this.where(filter);
    if (!where) return [];
    const rows = await this.getDb()
      .select()
      .from(workflowRecordedWrites)
      .where(where)
      .orderBy(asc(workflowRecordedWrites.seq))
      .offset(page.offset)
      .limit(page.limit);
    return rows.map(row => ({
      connection: row.connection,
      ...(row.step != null ? { step: row.step } : {}),
      request: row.request as unknown as RecordedRequest,
      seq: row.seq,
      ...(row.bodyCut != null ? { bodyCut: row.bodyCut } : {}),
      ...(row.wouldSend != null ? { wouldSend: row.wouldSend } : {}),
      at: row.at,
    }));
  }
}

// ── Model catalog snapshots ─────────────────────────────────────────────

type SnapshotRow = typeof modelCatalogSnapshots.$inferSelect;

function pgSnapshotToRecord(row: SnapshotRow): ModelCatalogSnapshotRecord {
  return {
    id: row.id,
    data: row.data,
    fetchedAt: toDate(row.fetchedAt),
    itemCount: row.itemCount,
  };
}

export class PgModelCatalogSnapshotsRepository implements ModelCatalogSnapshotsRepository {
  private readonly getDb: () => MakoPgDb;

  constructor(options: { getDb?: () => MakoPgDb } = {}) {
    this.getDb = options.getDb ?? getPgDb;
  }

  async findSnapshot(
    id: ModelCatalogSnapshotId,
    db: MakoPgDb = this.getDb(),
  ): Promise<ModelCatalogSnapshotRecord | null> {
    const rows = await db
      .select()
      .from(modelCatalogSnapshots)
      .where(eq(modelCatalogSnapshots.id, id))
      .limit(1);
    return rows[0] ? pgSnapshotToRecord(rows[0]) : null;
  }

  async findSnapshots(
    ids: readonly ModelCatalogSnapshotId[],
  ): Promise<ModelCatalogSnapshotRecord[]> {
    if (ids.length === 0) return [];
    const rows = await this.getDb()
      .select()
      .from(modelCatalogSnapshots)
      .where(inArray(modelCatalogSnapshots.id, [...ids]));
    return rows.map(pgSnapshotToRecord);
  }

  async upsertSnapshot(
    id: ModelCatalogSnapshotId,
    write: ModelCatalogSnapshotWrite,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    // `data ?? []` mirrors the Mongo schema default; jsonb NOT NULL.
    const data = write.data === undefined ? [] : write.data;
    await db
      .insert(modelCatalogSnapshots)
      .values({
        id,
        data,
        fetchedAt: write.fetchedAt,
        itemCount: write.itemCount,
      })
      .onConflictDoUpdate({
        target: modelCatalogSnapshots.id,
        set: {
          data,
          fetchedAt: write.fetchedAt,
          itemCount: write.itemCount,
        },
      });
  }

  async mutateSnapshot(
    id: ModelCatalogSnapshotId,
    mutate: (
      current: ModelCatalogSnapshotRecord | null,
    ) => ModelCatalogSnapshotWrite | null,
  ): Promise<boolean> {
    return this.getDb().transaction(async tx => {
      const txDb = tx as unknown as MakoPgDb;
      await txDb.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`model_catalog_snapshots:${id}`}))`,
      );
      const current = await this.findSnapshot(id, txDb);
      const next = mutate(current);
      if (!next) return false;
      await this.upsertSnapshot(id, next, txDb);
      return true;
    });
  }
}

// ── Apps box policy ─────────────────────────────────────────────────────

export class PgAppsBoxPolicyRepository implements AppsBoxPolicyRepository {
  private readonly getDb: () => MakoPgDb;

  constructor(options: { getDb?: () => MakoPgDb } = {}) {
    this.getDb = options.getDb ?? getPgDb;
  }

  async ensureSince(id: string, now: Date): Promise<Date> {
    const db = this.getDb();
    await db
      .insert(appsBoxPolicy)
      .values({ id, since: now })
      .onConflictDoNothing({ target: appsBoxPolicy.id });
    return (await this.readSince(id)) ?? now;
  }

  async readSince(id: string): Promise<Date | null> {
    const rows = await this.getDb()
      .select({ since: appsBoxPolicy.since })
      .from(appsBoxPolicy)
      .where(eq(appsBoxPolicy.id, id))
      .limit(1);
    return rows[0] ? toDate(rows[0].since) : null;
  }
}
