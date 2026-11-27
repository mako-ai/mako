/**
 * Test-only: one migrated PGlite per test file, wired into `getPgDb()`.
 *
 * Replaces the `MongoMemoryServer` + `mongoose.connect` rig in suites whose
 * data lives in Postgres (`api/src/repositories/*`). Core repositories use the
 * injected database.
 *
 *   let h: PgTestDb;
 *   beforeAll(async () => { h = await setupPgTestDb(); });
 *   afterEach(() => h.reset());
 *   afterAll(() => h.close());
 *
 * Vitest isolates modules per file, and each tsx suite runs in its own
 * process. Tests within a file share the database until the last close.
 *
 * Postgres enforces the foreign keys Mongo never had. A row that names a
 * workspace or user needs the parent first: `ensureTestWorkspace`,
 * `ensureTestUser` and the connection helpers seed them idempotently.
 *
 * Works under vitest and under `node --import tsx` (no vitest import here).
 * Excluded from the production build because PGlite is a dev dependency.
 */
import type { PGlite } from "@electric-sql/pglite";
import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  resetPgTestDb,
  setPgTestDb,
  type MakoPgDb,
} from "../database/pg/client";
import {
  generateObjectIdHex,
  generateUuidv7,
  isUuidString,
  legacyUserIdToUuidv7,
  parseEntityId,
  toWireId,
} from "../database/pg/id-codec";
import { runPgliteMigrations } from "../database/pg/migrate";
import * as schema from "../database/pg/schema";
import {
  databaseConnections,
  sourceConnections,
  users,
  workspaceMembers,
  workspaces,
  type WorkspaceMemberRole,
} from "../database/pg/schema";
import { createTestPglite } from "../database/pg/test-pglite";

export interface PgTestDb {
  pg: PGlite;
  db: MakoPgDb;
  /** Truncate all domain tables and restart their owned sequences. Schema and extensions stay. */
  reset(): Promise<void>;
  /** Detach from `getPgDb()`; closes PGlite once the last holder closes. */
  close(): Promise<void>;
}

interface Shared {
  pg: PGlite;
  db: MakoPgDb;
  holders: number;
}

let shared: Promise<Shared> | null = null;

async function bootShared(): Promise<Shared> {
  const pg = createTestPglite();
  try {
    await runPgliteMigrations(pg);
    const db = drizzle(pg, { schema });
    return { pg, db, holders: 0 };
  } catch (error) {
    await pg.close();
    throw error;
  }
}

/** Reset only domain tables. Drizzle stores its journal in the drizzle schema. */
export async function resetPgTestTables(pg: PGlite): Promise<void> {
  await pg.exec(`
    DO $$
    DECLARE tables text;
    BEGIN
      SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
        INTO tables FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations';
      IF tables IS NOT NULL THEN
        EXECUTE 'TRUNCATE TABLE ' || tables || ' RESTART IDENTITY CASCADE';
      END IF;
    END $$;
  `);
}

/**
 * A migrated PGlite injected into `getPgDb()`. Calls within one file share
 * the instance. Each call gets its own `close()`.
 */
export async function setupPgTestDb(): Promise<PgTestDb> {
  if (!shared) {
    shared = bootShared();
    shared.catch(() => {
      shared = null;
    });
  }
  const s = await shared;
  s.holders += 1;
  setPgTestDb(s.db);
  let closed = false;
  return {
    pg: s.pg,
    db: s.db,
    reset: () => resetPgTestTables(s.pg),
    close: async () => {
      if (closed) return;
      closed = true;
      s.holders -= 1;
      if (s.holders > 0) return;
      resetPgTestDb();
      shared = null;
      await s.pg.close();
    },
  };
}

// ── FK-safe seeds ──────────────────────────────────────────────────────────

function toUuid(id: string, what: string): string {
  const parsed = parseEntityId(id);
  if (!parsed) throw new Error(`${what}: invalid id ${JSON.stringify(id)}`);
  return parsed.uuid;
}

export interface TestUser {
  /** Postgres `users.id` (UUIDv7). */
  id: string;
  /** `users.legacy_id`: the id the caller passed, or `id`. */
  legacyId: string;
  email: string;
}

/**
 * Seed a user, or return the one already there. `id` may be a UUID or a
 * legacy 15-char Lucia id; a legacy id maps through `legacyUserIdToUuidv7`
 * and stays resolvable via `authRepo.resolveUserUuid(legacyId)`.
 */
export async function ensureTestUser(
  db: MakoPgDb,
  opts: { id?: string; email?: string; name?: string } = {},
): Promise<TestUser> {
  const legacyId = opts.id ?? generateUuidv7();
  const id = isUuidString(legacyId)
    ? legacyId.toLowerCase()
    : legacyUserIdToUuidv7(legacyId);
  const email = (opts.email ?? `user-${id}@test.mako.local`)
    .trim()
    .toLowerCase();

  await db
    .insert(users)
    .values({
      id,
      legacyId,
      email,
      name: opts.name ?? null,
      emailVerified: true,
    })
    .onConflictDoNothing();

  const [row] = await db
    .select({ id: users.id, legacyId: users.legacyId, email: users.email })
    .from(users)
    .where(
      opts.id
        ? or(eq(users.id, id), eq(users.legacyId, legacyId))
        : eq(users.email, email),
    )
    .limit(1);
  if (!row) {
    throw new Error(
      `ensureTestUser: email ${email} belongs to another user id than ${legacyId}`,
    );
  }
  return { id: row.id, legacyId: row.legacyId ?? row.id, email: row.email };
}

export interface TestWorkspace {
  /** Wire id the API uses (24-hex ObjectId for ObjectId-born rows). */
  id: string;
  /** Postgres `workspaces.id`. */
  uuid: string;
  slug: string;
  ownerUserId?: string;
}

/**
 * Seed a workspace, or keep the one already there. `id` may be a 24-hex
 * ObjectId (mapped with `objectIdToUuid`) or a UUID; omitted, a fresh
 * ObjectId is minted so wire ids look like production's. With
 * `ownerUserId`, also seeds the user and a `workspace_members` row.
 */
export async function ensureTestWorkspace(
  db: MakoPgDb,
  opts: {
    id?: string;
    name?: string;
    slug?: string;
    ownerUserId?: string;
    role?: WorkspaceMemberRole;
  } = {},
): Promise<TestWorkspace> {
  const uuid = toUuid(opts.id ?? generateObjectIdHex(), "ensureTestWorkspace");
  const wire = toWireId(uuid);
  const slug = (opts.slug ?? `test-${wire}`).toLowerCase();

  let ownerUuid: string | undefined;
  if (opts.ownerUserId) {
    ownerUuid = (await ensureTestUser(db, { id: opts.ownerUserId })).id;
  }

  await db
    .insert(workspaces)
    .values({
      id: uuid,
      name: opts.name ?? "Test workspace",
      slug,
      createdBy: ownerUuid ?? null,
    })
    .onConflictDoNothing({ target: opts.id ? workspaces.id : workspaces.slug });

  const [row] = await db
    .select({ uuid: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .where(opts.id ? eq(workspaces.id, uuid) : eq(workspaces.slug, slug));

  if (ownerUuid) {
    await db
      .insert(workspaceMembers)
      .values({
        workspaceId: row.uuid,
        userId: ownerUuid,
        role: opts.role ?? "owner",
      })
      .onConflictDoNothing();
  }

  return {
    id: toWireId(row.uuid),
    uuid: row.uuid,
    slug: row.slug,
    ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
  };
}

/** Add (or keep) a member row. Seeds the user if missing. */
export async function ensureTestMember(
  db: MakoPgDb,
  opts: { workspaceId: string; userId: string; role?: WorkspaceMemberRole },
): Promise<void> {
  const wsUuid = toUuid(opts.workspaceId, "ensureTestMember");
  const user = await ensureTestUser(db, { id: opts.userId });
  await db
    .insert(workspaceMembers)
    .values({
      workspaceId: wsUuid,
      userId: user.id,
      role: opts.role ?? "member",
    })
    .onConflictDoNothing();
}

export interface TestConnection {
  /** Wire id (24-hex ObjectId for ObjectId-born rows). */
  id: string;
  uuid: string;
  workspaceId: string;
}

async function ensureCreator(
  db: MakoPgDb,
  createdBy: string | undefined,
): Promise<string> {
  return (
    await ensureTestUser(db, { id: createdBy ?? "test-connection-creator" })
  ).id;
}

/**
 * Seed a database connection row (and its workspace). The `connection`
 * object is stored as given: pass already-encrypted values when a test
 * decrypts them, or use the repository's `createDatabaseConnection`.
 */
export async function ensureTestDatabaseConnection(
  db: MakoPgDb,
  opts: {
    workspaceId: string;
    id?: string;
    name?: string;
    type?: (typeof databaseConnections.$inferInsert)["type"];
    connection?: Record<string, unknown>;
    createdBy?: string;
  },
): Promise<TestConnection> {
  const ws = await ensureTestWorkspace(db, { id: opts.workspaceId });
  const uuid = toUuid(
    opts.id ?? generateObjectIdHex(),
    "ensureTestDatabaseConnection",
  );
  const createdBy = await ensureCreator(db, opts.createdBy);
  await db
    .insert(databaseConnections)
    .values({
      id: uuid,
      workspaceId: ws.uuid,
      name: opts.name ?? `db-${toWireId(uuid).slice(-6)}`,
      type: opts.type ?? "postgresql",
      connectionEncrypted: opts.connection ?? {},
      createdBy,
    })
    .onConflictDoNothing({ target: databaseConnections.id });
  await assertOwnedBy(db, "database", uuid, ws.uuid);
  return { id: toWireId(uuid), uuid, workspaceId: ws.id };
}

/** Seed a source connection row (and its workspace). */
export async function ensureTestSourceConnection(
  db: MakoPgDb,
  opts: {
    workspaceId: string;
    id?: string;
    name?: string;
    type?: string;
    config?: Record<string, unknown>;
    isActive?: boolean;
    createdBy?: string;
  },
): Promise<TestConnection> {
  const ws = await ensureTestWorkspace(db, { id: opts.workspaceId });
  const uuid = toUuid(
    opts.id ?? generateObjectIdHex(),
    "ensureTestSourceConnection",
  );
  const createdBy = await ensureCreator(db, opts.createdBy);
  await db
    .insert(sourceConnections)
    .values({
      id: uuid,
      workspaceId: ws.uuid,
      name: opts.name ?? `src-${toWireId(uuid).slice(-6)}`,
      type: opts.type ?? "rest",
      configEncrypted: opts.config ?? {},
      isActive: opts.isActive ?? true,
      createdBy,
    })
    .onConflictDoNothing({ target: sourceConnections.id });
  await assertOwnedBy(db, "source", uuid, ws.uuid);
  return { id: toWireId(uuid), uuid, workspaceId: ws.id };
}

async function assertOwnedBy(
  db: MakoPgDb,
  kind: "database" | "source",
  uuid: string,
  wsUuid: string,
): Promise<void> {
  const table = kind === "database" ? databaseConnections : sourceConnections;
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, uuid), eq(table.workspaceId, wsUuid)))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(
      `ensureTest${kind === "database" ? "Database" : "Source"}Connection: ${uuid} exists in another workspace`,
    );
  }
}
