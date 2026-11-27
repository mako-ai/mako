/**
 * The shared PGlite harness: reset speed and completeness, idempotent
 * FK-safe seeds, and no rows leaking from one test to the next.
 */
import { eq } from "drizzle-orm";
import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPgDb, hasPostgresConfig } from "../database/pg/client";
import { objectIdToUuid } from "../database/pg/id-codec";
import { workspaceMembers, workspaces } from "../database/pg/schema";
import { authRepo } from "../repositories/auth";
import { connectionsRepo } from "../repositories/connections";
import { workspaceRepo } from "../repositories/workspaces";
import {
  ensureTestDatabaseConnection,
  ensureTestMember,
  ensureTestSourceConnection,
  ensureTestUser,
  ensureTestWorkspace,
  resetPgTestTables,
  setupPgTestDb,
  type PgTestDb,
} from "./pg-test";

let h: PgTestDb;

beforeAll(async () => {
  h = await setupPgTestDb();
});

beforeEach(() => h.reset());

afterAll(async () => {
  await h.close();
});

async function countRows(table: string): Promise<number> {
  const res = await h.pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return res.rows[0]?.n ?? -1;
}

describe("setupPgTestDb", () => {
  it("injects the PGlite db into getPgDb()", () => {
    expect(hasPostgresConfig()).toBe(true);
    expect(getPgDb()).toBe(h.db);
  });

  it("applies every migration (59 public tables)", async () => {
    const res = await h.pg.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
    );
    expect(res.rows[0]?.n).toBeGreaterThanOrEqual(59);
  });

  it("a second call in the same file shares the instance", async () => {
    const again = await setupPgTestDb();
    expect(again.pg).toBe(h.pg);
    await again.close();
    // The first holder is still open.
    expect(getPgDb()).toBe(h.db);
    expect((await h.pg.query("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
  });
});

describe("resetPgTestTables", () => {
  it("empties every seeded table and keeps the schema", async () => {
    const ws = await ensureTestWorkspace(h.db, {
      ownerUserId: "luciaUser00001",
    });
    await ensureTestDatabaseConnection(h.db, { workspaceId: ws.id });
    await ensureTestSourceConnection(h.db, { workspaceId: ws.id });
    expect(await countRows("workspaces")).toBe(1);

    await resetPgTestTables(h.pg);
    for (const t of [
      "users",
      "workspaces",
      "workspace_members",
      "database_connections",
      "source_connections",
    ]) {
      expect(await countRows(t)).toBe(0);
    }
  });

  it("restarts identities on empty tables and preserves migration history", async () => {
    await h.pg.exec(`
      CREATE TABLE reset_probe (id integer GENERATED ALWAYS AS IDENTITY);
      CREATE SCHEMA IF NOT EXISTS drizzle;
      CREATE TABLE drizzle.__drizzle_migrations (id integer);
      INSERT INTO drizzle.__drizzle_migrations VALUES (1);
      INSERT INTO reset_probe DEFAULT VALUES;
      DELETE FROM reset_probe;
    `);
    await h.reset();
    expect(
      (await h.pg.query("INSERT INTO reset_probe DEFAULT VALUES RETURNING id"))
        .rows,
    ).toEqual([{ id: 1 }]);
    expect(await countRows("drizzle.__drizzle_migrations")).toBe(1);
  }, 2_000);
});

describe("FK-safe seeds", () => {
  it("ensureTestUser is idempotent and resolvable by legacy id", async () => {
    const a = await ensureTestUser(h.db, { id: "abcdefghijklmno" });
    const b = await ensureTestUser(h.db, { id: "abcdefghijklmno" });
    expect(b).toEqual(a);
    expect(a.legacyId).toBe("abcdefghijklmno");
    expect(await authRepo.resolveUserUuid("abcdefghijklmno")).toBe(a.id);
    expect(await countRows("users")).toBe(1);
  });

  it("ensureTestUser keeps a UUID id as is", async () => {
    const id = "0190f5c3-7d2a-7b4e-8c1d-2e3f4a5b6c7d";
    const u = await ensureTestUser(h.db, { id, email: "Ada@Example.com" });
    expect(u.id).toBe(id);
    expect(u.email).toBe("ada@example.com");
    expect(await ensureTestUser(h.db, { email: u.email })).toEqual(u);
  });

  it("ensureTestWorkspace maps an ObjectId and adds the owner once", async () => {
    const oid = new Types.ObjectId().toString();
    const first = await ensureTestWorkspace(h.db, {
      id: oid,
      ownerUserId: "ownerUser000001",
    });
    const second = await ensureTestWorkspace(h.db, {
      id: oid,
      ownerUserId: "ownerUser000001",
    });
    expect(first.id).toBe(oid);
    expect(first.uuid).toBe(objectIdToUuid(oid));
    expect(second).toEqual(first);
    expect((await ensureTestWorkspace(h.db, { slug: first.slug })).uuid).toBe(
      first.uuid,
    );

    const members = await h.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, first.uuid));
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe("owner");

    // The production repository reads the seeded rows.
    const ws = await workspaceRepo.findById(oid);
    expect(ws?.id).toBe(oid);
    const member = await workspaceRepo.findMember(oid, "ownerUser000001");
    expect(member?.role).toBe("owner");
  });

  it("ensureTestMember adds a second member with its role", async () => {
    const ws = await ensureTestWorkspace(h.db);
    await ensureTestMember(h.db, {
      workspaceId: ws.id,
      userId: "viewerUser00001",
      role: "viewer",
    });
    const member = await workspaceRepo.findMember(ws.id, "viewerUser00001");
    expect(member?.role).toBe("viewer");
  });

  it("connection seeds create the workspace and are readable by the repo", async () => {
    const wsId = new Types.ObjectId().toString();
    const dbConn = await ensureTestDatabaseConnection(h.db, {
      workspaceId: wsId,
      name: "warehouse",
      type: "postgresql",
    });
    const again = await ensureTestDatabaseConnection(h.db, {
      workspaceId: wsId,
      id: dbConn.id,
    });
    expect(again.id).toBe(dbConn.id);
    expect(await countRows("users")).toBe(1);
    const src = await ensureTestSourceConnection(h.db, {
      workspaceId: wsId,
      type: "stripe",
    });

    const readDb = await connectionsRepo.findDatabaseConnectionById(
      dbConn.id,
      wsId,
    );
    expect(readDb?.name).toBe("warehouse");
    const readSrc = await connectionsRepo.findSourceConnectionById(
      src.id,
      wsId,
    );
    expect(readSrc?.type).toBe("stripe");
    expect(await countRows("workspaces")).toBe(1);
  });

  it("a connection id taken by another workspace throws", async () => {
    const a = await ensureTestDatabaseConnection(h.db, {
      workspaceId: new Types.ObjectId().toString(),
    });
    await expect(
      ensureTestDatabaseConnection(h.db, {
        workspaceId: new Types.ObjectId().toString(),
        id: a.id,
      }),
    ).rejects.toThrow(/another workspace/);
  });
});

describe("no cross-test leakage", () => {
  const oid = new Types.ObjectId().toString();

  it("writes a workspace", async () => {
    await ensureTestWorkspace(h.db, { id: oid, slug: "leak-check" });
    expect(await workspaceRepo.findBySlug("leak-check")).not.toBeNull();
  });

  it("sees nothing after a reset", async () => {
    expect(await workspaceRepo.findBySlug("leak-check")).toBeNull();
    const rows = await h.db.select().from(workspaces);
    expect(rows).toHaveLength(0);
  });
});
