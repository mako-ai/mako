import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { extractRows, type MakoPgDb } from "../database/pg/client";
import { newDualId } from "../database/pg/id-codec";
import { runPgliteMigrations } from "../database/pg/migrate";
import * as schema from "../database/pg/schema";
import {
  clearBackfillRegistryForTests,
  currentUtcDay,
  isClosedUtcDay,
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
    pg = new PGlite();
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
            VALUES (${item.doc.uuid}::uuid, ${item.doc.title}, ${item.doc.updatedAt.toISOString()}::timestamptz)
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
});
