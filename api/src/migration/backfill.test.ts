import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { extractRows, type MakoPgDb } from "../database/pg/client";
import { newDualId } from "../database/pg/id-codec";
import { runPgliteMigrations } from "../database/pg/migrate";
import * as schema from "../database/pg/schema";
import { createTestPglite } from "../database/pg/test-pglite";
import {
  BackfillJobLockedError,
  BackfillLeaseLostError,
  clearBackfillRegistryForTests,
  currentUtcDay,
  isClosedUtcDay,
  notTombstonedSql,
  registerBackfillDomain,
  runBackfill,
  type BackfillDomainHandler,
} from "./backfill";
import { recordMigrationTombstone } from "./router";

interface SampleDoc {
  oid: string;
  uuid: string;
  title: string;
  updatedAt: Date;
  orphan?: boolean;
}

describe("backfill engine", () => {
  let pg: PGlite;
  let db: MakoPgDb;

  beforeAll(async () => {
    pg = createTestPglite();
    await runPgliteMigrations(pg);
    await pg.exec(`
      CREATE TABLE test_backfill_items (
        id uuid PRIMARY KEY,
        title text NOT NULL,
        updated_at timestamptz NOT NULL
      );
    `);
    db = drizzle(pg, { schema }) as unknown as MakoPgDb;
  });

  beforeEach(async () => {
    clearBackfillRegistryForTests();
    await pg.exec(`
      DELETE FROM test_backfill_items;
      DELETE FROM migration_backfill_jobs;
      DELETE FROM migration_tombstones;
      DELETE FROM migration_quarantine;
    `);
  });

  afterAll(async () => {
    await pg.close();
  });

  function makeDocs(count: number): SampleDoc[] {
    const baseMs = Date.UTC(2026, 10, 20, 12, 0, 0);
    return Array.from({ length: count }, (_, idx) => {
      const id = newDualId(baseMs + idx * 1000);
      return {
        oid: id.oid,
        uuid: id.uuid,
        title: `Item ${idx}`,
        updatedAt: new Date(baseMs + idx * 1000),
      };
    }).sort((a, b) => a.oid.localeCompare(b.oid));
  }

  function buildHandler(docs: SampleDoc[]): BackfillDomainHandler<SampleDoc> {
    return {
      domain: "apps_metadata",
      collectionName: "app_projects",
      targetTable: "test_backfill_items",
      async fetchBatch({ afterCursor, limit }) {
        const slice = docs
          .filter(d => (afterCursor ? d.oid > afterCursor : true))
          .slice(0, limit);
        return slice.map(doc => ({
          cursor: doc.oid,
          entityId: doc.uuid,
          doc,
        }));
      },
      validate(item) {
        if (item.doc.orphan) {
          return {
            ok: false,
            reason: "orphaned_parent_missing",
            sanitizedPayload: { oid: item.doc.oid },
          };
        }
        return { ok: true };
      },
      async upsertBatch(items, targetDb) {
        let upserted = 0;
        for (const item of items) {
          const res = await targetDb.execute(sql`
            INSERT INTO test_backfill_items (id, title, updated_at)
            SELECT
              ${item.doc.uuid}::uuid,
              ${item.doc.title},
              ${item.doc.updatedAt.toISOString()}::timestamptz
            WHERE ${notTombstonedSql("test_backfill_items", item.doc.uuid)}
            ON CONFLICT (id) DO UPDATE SET
              title = EXCLUDED.title,
              updated_at = EXCLUDED.updated_at
            WHERE test_backfill_items.updated_at IS NULL
               OR EXCLUDED.updated_at >= test_backfill_items.updated_at
            RETURNING id
          `);
          upserted += extractRows(res).length;
        }
        return upserted;
      },
    };
  }

  it("pauses and resumes cleanly via migration_backfill_jobs cursor checkpoints", async () => {
    const docs = makeDocs(5);
    registerBackfillDomain(buildHandler(docs));

    // Run 1 batch of 2 -> pauses after cursor = docs[1].oid
    const pass1 = await runBackfill({
      domain: "apps_metadata",
      batchSize: 2,
      maxBatches: 1,
      db,
    });
    expect(pass1.status).toBe("paused");
    expect(pass1.rowsProcessed).toBe(2);
    expect(pass1.rowsUpserted).toBe(2);
    expect(pass1.lastCursor).toBe(docs[1].oid);

    // Resume from saved checkpoint -> finishes remaining 3 docs
    const pass2 = await runBackfill({
      domain: "apps_metadata",
      batchSize: 2,
      db,
    });
    expect(pass2.status).toBe("completed");
    expect(pass2.rowsProcessed).toBe(5);
    expect(pass2.rowsUpserted).toBe(5);
    expect(pass2.lastCursor).toBe(docs[4].oid);

    const rows = await pg.query<{ id: string }>(
      "SELECT id::text FROM test_backfill_items",
    );
    expect(rows.rows).toHaveLength(5);
  });

  it("enforces stale updatedAt guard, skips tombstones, and quarantines orphans", async () => {
    const docs = makeDocs(4);
    docs[2].orphan = true;
    const staleTarget = docs[0];
    const deletedTarget = docs[1];

    // Simulate live dual-write writing a NEWER version of docs[0] before backfill reaches it
    const newerTs = new Date(staleTarget.updatedAt.getTime() + 60_000);
    await pg.query(
      `INSERT INTO test_backfill_items (id, title, updated_at) VALUES ($1::uuid, $2, $3::timestamptz)`,
      [staleTarget.uuid, "Live Newer Title", newerTs.toISOString()],
    );

    // Simulate live delete recording a tombstone for docs[1]
    await recordMigrationTombstone(
      "test_backfill_items",
      deletedTarget.uuid,
      db,
    );

    const summary = await runBackfill({
      domain: "apps_metadata",
      batchSize: 10,
      db,
      handler: buildHandler(docs),
    });

    expect(summary.status).toBe("completed");
    expect(summary.rowsProcessed).toBe(4);
    expect(summary.rowsSkippedTombstone).toBe(1);
    expect(summary.rowsQuarantined).toBe(1);
    // docs[0] skipped by WHERE updated_at guard; only docs[3] inserted!
    expect(summary.rowsUpserted).toBe(1);

    const stored = await pg.query<{ id: string; title: string }>(
      "SELECT id::text, title FROM test_backfill_items ORDER BY title",
    );
    expect(stored.rows).toEqual([
      { id: docs[3].uuid, title: "Item 3" },
      { id: staleTarget.uuid, title: "Live Newer Title" },
    ]);

    // Verify orphan recorded in migration_quarantine
    const quarantined = await db.select().from(schema.migrationQuarantine);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].mongoId).toBe(docs[2].oid);
    expect(quarantined[0].reason).toBe("orphaned_parent_missing");
  });

  it("supports dryRun without mutating Postgres tables or checkpoints", async () => {
    const docs = makeDocs(3);
    const summary = await runBackfill({
      domain: "apps_metadata",
      batchSize: 10,
      dryRun: true,
      db,
      handler: buildHandler(docs),
    });
    expect(summary.dryRun).toBe(true);
    expect(summary.rowsProcessed).toBe(3);

    const items = await pg.query("SELECT * FROM test_backfill_items");
    expect(items.rows).toHaveLength(0);
    expect(await db.select().from(schema.migrationBackfillJobs)).toHaveLength(
      0,
    );
  });

  it("correctly distinguishes closed UTC days for $inc counter rollups", () => {
    const now = new Date("2026-11-26T00:05:00.000Z");
    expect(currentUtcDay(now)).toBe("2026-11-26");
    expect(isClosedUtcDay("2026-11-25", now)).toBe(true);
    expect(isClosedUtcDay("2026-11-26", now)).toBe(false);
    expect(isClosedUtcDay("2026-11-27", now)).toBe(false);
    expect(isClosedUtcDay("invalid", now)).toBe(false);
  });

  it("prevents resurrecting rows tombstoned during validate() or right before SQL INSERT", async () => {
    const docs = makeDocs(3);
    const deletedDuringValidate = docs[0];
    const deletedDuringUpsert = docs[1];
    const survivor = docs[2];

    const base = buildHandler(docs);
    const upsertSeenIds: string[] = [];

    const summary = await runBackfill({
      domain: "apps_metadata",
      batchSize: 10,
      db,
      handler: {
        ...base,
        async validate(item, targetDb) {
          // Simulate a live delete arriving AFTER the initial tombstone scan while validate() runs
          if (item.doc.uuid === deletedDuringValidate.uuid) {
            await recordMigrationTombstone(
              "test_backfill_items",
              deletedDuringValidate.uuid,
              targetDb,
            );
          }
          return { ok: true };
        },
        async upsertBatch(items, targetDb) {
          upsertSeenIds.push(...items.map(i => i.doc.uuid));
          // Simulate a live delete arriving even AFTER transactional pre-upsert re-check,
          // right before the SQL INSERT executes -> notTombstonedSql blocks resurrection atomically!
          await recordMigrationTombstone(
            "test_backfill_items",
            deletedDuringUpsert.uuid,
            targetDb,
          );
          return base.upsertBatch(items, targetDb);
        },
      },
    });

    expect(summary.status).toBe("completed");
    // deletedDuringValidate was filtered out by the transactional re-check before upsertBatch
    expect(upsertSeenIds).not.toContain(deletedDuringValidate.uuid);
    expect(summary.rowsSkippedTombstone).toBe(1);
    // deletedDuringUpsert was blocked atomically by notTombstonedSql inside INSERT ... SELECT
    expect(summary.rowsUpserted).toBe(1);

    const rows = await pg.query<{ id: string }>(
      "SELECT id::text FROM test_backfill_items",
    );
    expect(rows.rows.map(r => r.id)).toEqual([survivor.uuid]);
  });

  it("prevents concurrent backfill runs via atomic lease claim, supports stale lease recovery, and aborts on lease loss", async () => {
    const docs = makeDocs(4);
    const base = buildHandler(docs);

    let batch1Started!: () => void;
    let releaseBatch1!: () => void;
    const batch1StartedPromise = new Promise<void>(resolve => {
      batch1Started = resolve;
    });
    const batch1Gate = new Promise<void>(resolve => {
      releaseBatch1 = resolve;
    });

    // Start run 1 and pause it mid-flight inside fetchBatch
    const run1Promise = runBackfill({
      domain: "apps_metadata",
      batchSize: 2,
      db,
      handler: {
        ...base,
        async fetchBatch(params) {
          if (params.afterCursor === null) {
            batch1Started();
            await batch1Gate;
          }
          return base.fetchBatch(params);
        },
      },
    });

    await batch1StartedPromise;

    // Concurrent run 2 on the same (domain, scope) MUST be rejected without touching run 1's row
    await expect(
      runBackfill({
        domain: "apps_metadata",
        batchSize: 2,
        db,
        handler: base,
      }),
    ).rejects.toThrow(BackfillJobLockedError);

    // Release run 1 -> completes cleanly with exact counters
    releaseBatch1();
    const run1 = await run1Promise;
    expect(run1.status).toBe("completed");
    expect(run1.rowsProcessed).toBe(4);
    expect(run1.rowsUpserted).toBe(4);

    // Stale lease recovery: simulate a crashed worker stuck in `running` 20 minutes ago
    const staleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await pg.query(
      `UPDATE migration_backfill_jobs
       SET status = 'running', lease_token = 'crashed-worker', last_cursor = NULL,
           rows_processed = 0, rows_upserted = 0, updated_at = $1::timestamptz
       WHERE domain = 'apps_metadata' AND scope_key = 'global'`,
      [staleAt],
    );

    const recovered = await runBackfill({
      domain: "apps_metadata",
      batchSize: 10,
      leaseTimeoutMs: 60_000,
      db,
      handler: base,
    });
    expect(recovered.status).toBe("completed");
    expect(recovered.rowsProcessed).toBe(4);

    // Lease loss CAS: if another worker steals lease_token mid-batch, the old worker aborts
    // with BackfillLeaseLostError, rolls back its batch writes, and does NOT clobber the new owner's row
    await pg.exec(
      "DELETE FROM test_backfill_items; DELETE FROM migration_backfill_jobs;",
    );
    let stoleLease = false;
    await expect(
      runBackfill({
        domain: "apps_metadata",
        batchSize: 2,
        db,
        handler: {
          ...base,
          async validate(item, targetDb) {
            if (!stoleLease) {
              stoleLease = true;
              await targetDb.execute(sql`
                UPDATE migration_backfill_jobs
                SET lease_token = 'new-owner-token'
                WHERE domain = 'apps_metadata' AND scope_key = 'global'
              `);
            }
            return { ok: true };
          },
        },
      }),
    ).rejects.toThrow(BackfillLeaseLostError);

    const jobAfterSteal = await db.select().from(schema.migrationBackfillJobs);
    expect(jobAfterSteal[0].status).toBe("running");
    expect(jobAfterSteal[0].leaseToken).toBe("new-owner-token");
    // Batch upserts were rolled back when CAS failed
    const itemsAfterSteal = await pg.query("SELECT * FROM test_backfill_items");
    expect(itemsAfterSteal.rows).toHaveLength(0);
  });

  it("deduplicates unresolved migration_quarantine rows across retries and --reset-cursor runs", async () => {
    const docs = makeDocs(3);
    docs[0].orphan = true;
    const base = buildHandler(docs);

    // First attempt: quarantines docs[0], then upsertBatch fails before cursor checkpoint is saved
    let failOnce = true;
    await expect(
      runBackfill({
        domain: "apps_metadata",
        batchSize: 10,
        db,
        handler: {
          ...base,
          async upsertBatch(items, targetDb) {
            if (failOnce) {
              failOnce = false;
              throw new Error("transient upsert error");
            }
            return base.upsertBatch(items, targetDb);
          },
        },
      }),
    ).rejects.toThrow(/transient upsert error/);

    // Transaction rolled back the failed batch cleanly -> 0 leaked quarantine rows
    expect(await db.select().from(schema.migrationQuarantine)).toHaveLength(0);

    // Resume after failure: quarantines docs[0] once cleanly (rowsQuarantined === 1)
    const resumed = await runBackfill({
      domain: "apps_metadata",
      batchSize: 10,
      db,
      handler: base,
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.rowsQuarantined).toBe(1);
    expect(await db.select().from(schema.migrationQuarantine)).toHaveLength(1);

    // --reset-cursor re-run: partial unique index + onConflictDoNothing keeps 1 row and 0 duplicates
    const resetRun = await runBackfill({
      domain: "apps_metadata",
      batchSize: 10,
      resetCursor: true,
      db,
      handler: base,
    });
    expect(resetRun.status).toBe("completed");
    expect(resetRun.rowsQuarantined).toBe(0);
    expect(await db.select().from(schema.migrationQuarantine)).toHaveLength(1);

    // Once resolved, a subsequent failure for the same doc CAN insert a fresh quarantine row
    await pg.exec(
      "UPDATE migration_quarantine SET resolved_at = now() WHERE resolved_at IS NULL;",
    );
    const afterResolve = await runBackfill({
      domain: "apps_metadata",
      batchSize: 10,
      resetCursor: true,
      db,
      handler: base,
    });
    expect(afterResolve.rowsQuarantined).toBe(1);
    expect(await db.select().from(schema.migrationQuarantine)).toHaveLength(2);
  });
});
