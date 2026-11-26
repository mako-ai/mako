import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MakoPgDb } from "../database/pg/client";
import { newDualId } from "../database/pg/id-codec";
import { runPgliteMigrations } from "../database/pg/migrate";
import * as schema from "../database/pg/schema";
import { createTestPglite } from "../database/pg/test-pglite";
import { recordMigrationTombstone } from "./router";
import {
  clearVerifierRegistryForTests,
  runParityVerification,
  type VerifierDomainHandler,
} from "./verifier";

describe("parity verifier", () => {
  let pg: PGlite;
  let db: MakoPgDb;

  beforeAll(async () => {
    pg = createTestPglite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema }) as unknown as MakoPgDb;
  });

  beforeEach(async () => {
    clearVerifierRegistryForTests();
    await pg.exec("DELETE FROM migration_tombstones;");
  });

  afterAll(async () => {
    await pg.close();
  });

  it("detects missing, mismatched, and extra rows, excludes tombstones, and repairs drift", async () => {
    const idMatch = newDualId();
    const idMissing = newDualId();
    const idDrift = newDualId();
    const idTombstone = newDualId();
    const idExtra = newDualId();

    await recordMigrationTombstone("sample_tbl", idTombstone.uuid, db);

    const mongoStore = new Map<string, { id: string; name: string }>([
      [idMatch.uuid, { id: idMatch.oid, name: "Exact" }],
      [idMissing.uuid, { id: idMissing.oid, name: "Missing" }],
      [idDrift.uuid, { id: idDrift.oid, name: "Canonical" }],
      [idTombstone.uuid, { id: idTombstone.oid, name: "Deleted" }],
    ]);

    const pgStore = new Map<string, { id: string; name: string }>([
      [idMatch.uuid, { id: idMatch.oid, name: "Exact" }],
      [idDrift.uuid, { id: idDrift.oid, name: "Stale" }],
      [idExtra.uuid, { id: idExtra.oid, name: "Zombie" }],
    ]);

    const sortedKeys = [...mongoStore.keys()].sort();

    const handler: VerifierDomainHandler = {
      domain: "workspaces_core",
      targetTable: "sample_tbl",
      async fetchMongoBatch({ afterCursor, limit }) {
        return sortedKeys
          .filter(k => (afterCursor ? k > afterCursor : true))
          .slice(0, limit)
          .map(k => ({
            cursor: k,
            entityId: k,
            record: mongoStore.get(k),
          }));
      },
      async fetchPgByIds(ids) {
        const out = new Map<string, unknown>();
        for (const id of ids) {
          if (pgStore.has(id)) out.set(id, pgStore.get(id));
        }
        return out;
      },
      async findExtraPgIds({ seenEntityIds }) {
        return [...pgStore.keys()].filter(k => !seenEntityIds.has(k));
      },
      async repair({ entityIds }) {
        let count = 0;
        for (const id of entityIds) {
          const src = mongoStore.get(id);
          if (src) {
            pgStore.set(id, { ...src });
            count += 1;
          }
        }
        return count;
      },
    };

    // First run with repair: true
    const report1 = await runParityVerification({
      domain: "workspaces_core",
      batchSize: 2,
      repair: true,
      db,
      handler,
    });

    expect(report1.ok).toBe(false);
    expect(report1.checked).toBe(3); // 4 mongo rows minus 1 tombstoned
    expect(report1.skippedTombstone).toBe(1);
    expect(report1.matched).toBe(1);
    expect(report1.missingInPg).toBe(1);
    expect(report1.mismatched).toBe(1);
    expect(report1.extraInPg).toBe(1);
    expect(report1.repaired).toBe(2);

    // Delete zombie extra row and re-verify -> clean 100% parity!
    pgStore.delete(idExtra.uuid);
    const report2 = await runParityVerification({
      domain: "workspaces_core",
      batchSize: 2,
      db,
      handler,
    });
    expect(report2.ok).toBe(true);
    expect(report2.checked).toBe(3);
    expect(report2.matched).toBe(3);
    expect(report2.missingInPg).toBe(0);
    expect(report2.mismatched).toBe(0);
    expect(report2.extraInPg).toBe(0);
  });

  it("preserves case-sensitive base64url text PKs (e.g. desktop_auth_codes) during verify and repair", async () => {
    const code1 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AaBbC";
    const code2 = "ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-XxYyZ";

    const mongoStore = new Map<string, { id: string; userId: string }>([
      [code1, { id: code1, userId: "u_1" }],
      [code2, { id: code2, userId: "u_2" }],
    ]);
    const pgStore = new Map<string, { id: string; userId: string }>([
      [code1, { id: code1, userId: "u_1" }],
    ]);

    const repairedIds: string[] = [];

    const handler: VerifierDomainHandler = {
      domain: "auth",
      targetTable: "desktop_auth_codes",
      async fetchMongoBatch({ afterCursor }) {
        if (afterCursor) return [];
        return [...mongoStore.entries()].map(([id, rec]) => ({
          cursor: id,
          entityId: id,
          record: rec,
        }));
      },
      async fetchPgByIds(ids) {
        const out = new Map<string, unknown>();
        for (const id of ids) {
          if (pgStore.has(id)) out.set(id, pgStore.get(id));
        }
        return out;
      },
      async repair({ entityIds }) {
        repairedIds.push(...entityIds);
        for (const id of entityIds) {
          const src = mongoStore.get(id);
          if (src) pgStore.set(id, { ...src });
        }
        return entityIds.length;
      },
    };

    const report1 = await runParityVerification({
      domain: "auth",
      repair: true,
      db,
      handler,
    });
    expect(report1.checked).toBe(2);
    expect(report1.matched).toBe(1);
    expect(report1.missingInPg).toBe(1);
    expect(repairedIds).toEqual([code2]);

    const report2 = await runParityVerification({
      domain: "auth",
      db,
      handler,
    });
    expect(report2.ok).toBe(true);
    expect(report2.matched).toBe(2);
  });
});
