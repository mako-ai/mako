/**
 * Platform Postgres / Neon Drizzle client.
 *
 * Supports three connection modes behind one unified Drizzle API:
 *   1. Default runtime (`postgres.js` over Neon PgBouncer `-pooler` URL):
 *      - `prepare: false` (required for PgBouncer transaction pooling)
 *      - `ssl: "verify-full"` for remote hosts; SSL disabled for localhost/127.0.0.1/::1
 *      - Full interactive transactions + native TCP TLS latency on Cloud Run
 *   2. WebSocket fallback (`PG_DRIVER=neon-ws` over `@neondatabase/serverless` Pool):
 *      - Tunnels Postgres over WSS port 443 using Node 24 native `globalThis.WebSocket`
 *      - Use if Cloud Run `mako-vpc` egress restricts outbound TCP 5432
 *   3. In-process test injection (`setPgTestDb()` with `@electric-sql/pglite`):
 *      - ~50ms startup, zero Docker or network required for unit/contract suites
 *
 * Separate direct connection (`getPgDirectDb()`) uses `POSTGRES_DIRECT_URL`
 * (falling back to `POSTGRES_URL`) for Drizzle migrations and bulk backfills
 * that require session-level DDL locks or prepared statements.
 */
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzleNeonWs } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { loggers } from "../../logging";
import * as schema from "./schema";

const logger = loggers.db("postgres");

export type MakoPgSchema = typeof schema;
export type MakoPgDb = PgDatabase<PgQueryResultHKT, MakoPgSchema>;
export type PgDriverKind = "postgres" | "neon-ws";

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "postgres-platform",
]);

/** Detect whether a Postgres URL targets a local/container instance (no Neon SSL/WSS). */
export function isLocalPostgres(url: string | undefined): boolean {
  if (!url) return false;
  try {
    // Strip IPv6 brackets (`[::1]` -> `::1`) returned by WHATWG URL.hostname
    const normalizedHost = new URL(url).hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
    return LOCAL_HOSTNAMES.has(normalizedHost);
  } catch {
    return false;
  }
}

/**
 * Resolve the `postgres.js` `ssl` option for `url`.
 *
 * Local/container hosts disable TLS (`false`). All remote hosts (e.g. Neon)
 * enforce `"verify-full"` so server certificates and hostnames are always
 * verified (in `postgres.js`, `"require"` sets `rejectUnauthorized: false` and
 * overrides URL `sslmode`, leaving connections vulnerable to MITM).
 */
export function resolvePgSslOption(
  url: string | undefined,
): false | "verify-full" {
  return isLocalPostgres(url) ? false : "verify-full";
}

/** Resolve which runtime driver to use for `url`. Local hosts always use `postgres.js`. */
export function resolvePgDriver(
  url: string | undefined,
  driverEnv: string | undefined = process.env.PG_DRIVER,
): PgDriverKind {
  if (isLocalPostgres(url)) {
    return "postgres";
  }
  if (driverEnv?.trim().toLowerCase() === "neon-ws") {
    return "neon-ws";
  }
  return "postgres";
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

let runtimeSql: Sql | null = null;
let runtimeNeonPool: NeonPool | null = null;
let runtimeDb: MakoPgDb | null = null;

let directSql: Sql | null = null;
let directDb: MakoPgDb | null = null;

let testDbOverride: MakoPgDb | null = null;

export function hasInjectedPgTestDb(): boolean {
  return testDbOverride !== null;
}

/**
 * True when the runtime Postgres client (`getPgDb()`) is usable — i.e., either
 * `POSTGRES_URL` is configured or a test PGlite database is injected via `setPgTestDb()`.
 * Intentionally does NOT treat `POSTGRES_DIRECT_URL` alone as runtime-configured
 * so callers like `MigrationRouter` and `migrationPgTtlReaperFunction` never crash in `getPgDb()`.
 */
export function hasPostgresConfig(): boolean {
  return Boolean(testDbOverride || process.env.POSTGRES_URL?.trim());
}

/** True when `getPgDirectDb()` is usable (`POSTGRES_DIRECT_URL` or `POSTGRES_URL` or test override). */
export function hasDirectPostgresConfig(): boolean {
  return Boolean(
    testDbOverride ||
    process.env.POSTGRES_DIRECT_URL?.trim() ||
    process.env.POSTGRES_URL?.trim(),
  );
}

/**
 * Inject an in-process Drizzle instance (typically backed by PGlite) for tests.
 * Both `getPgDb()` and `getPgDirectDb()` return this instance while set.
 */
export function setPgTestDb(db: MakoPgDb): void {
  testDbOverride = db;
}

/** Clear the injected test Drizzle instance. */
export function resetPgTestDb(): void {
  testDbOverride = null;
}

/**
 * Return the runtime Drizzle database instance (pooled PgBouncer or Neon WS pool).
 * Lazily constructed on first call; safe to import when `POSTGRES_URL` is unset.
 */
export function getPgDb(): MakoPgDb {
  if (testDbOverride) {
    return testDbOverride;
  }
  if (runtimeDb) {
    return runtimeDb;
  }

  const connectionString = process.env.POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error(
      "POSTGRES_URL is not set. Configure POSTGRES_URL (or inject a test DB via setPgTestDb).",
    );
  }

  const local = isLocalPostgres(connectionString);
  const driver = resolvePgDriver(connectionString);
  const maxPool = positiveIntEnv("PG_POOL_MAX", 10);
  const idleTimeoutSec = positiveIntEnv("PG_IDLE_TIMEOUT_SEC", 30);
  const connectTimeoutSec = positiveIntEnv("PG_CONNECT_TIMEOUT_SEC", 10);

  if (driver === "neon-ws") {
    // Node 22+ exposes a native WebSocket global — no `ws` wrapper required.
    neonConfig.webSocketConstructor = globalThis.WebSocket;
    runtimeNeonPool = new NeonPool({
      connectionString,
      max: maxPool,
      idleTimeoutMillis: idleTimeoutSec * 1000,
      connectionTimeoutMillis: connectTimeoutSec * 1000,
    });
    runtimeDb = drizzleNeonWs(runtimeNeonPool, {
      schema,
    }) as unknown as MakoPgDb;
    logger.info("Initialized platform Postgres client (Neon WebSocket Pool)", {
      driver,
      maxPool,
    });
    return runtimeDb;
  }

  runtimeSql = postgres(connectionString, {
    max: maxPool,
    idle_timeout: idleTimeoutSec,
    connect_timeout: connectTimeoutSec,
    // Neon's pooled endpoint uses PgBouncer in transaction pooling mode,
    // which rejects named prepared statements across pooled sessions.
    prepare: false,
    ssl: resolvePgSslOption(connectionString),
  });
  runtimeDb = drizzlePostgresJs(runtimeSql, { schema }) as unknown as MakoPgDb;
  logger.info("Initialized platform Postgres client (postgres.js)", {
    driver,
    local,
    maxPool,
  });
  return runtimeDb;
}

/**
 * Return a direct (non-PgBouncer) Drizzle instance for migrations, bulk backfills,
 * and parity verification scripts. Uses `POSTGRES_DIRECT_URL` with fallback to `POSTGRES_URL`.
 */
export function getPgDirectDb(): MakoPgDb {
  if (testDbOverride) {
    return testDbOverride;
  }
  if (directDb) {
    return directDb;
  }

  const connectionString =
    process.env.POSTGRES_DIRECT_URL?.trim() || process.env.POSTGRES_URL?.trim();
  if (!connectionString) {
    throw new Error(
      "POSTGRES_DIRECT_URL (or POSTGRES_URL) is not set for direct Postgres access.",
    );
  }

  const local = isLocalPostgres(connectionString);
  const maxPool = positiveIntEnv("PG_DIRECT_POOL_MAX", 4);
  const connectTimeoutSec = positiveIntEnv("PG_CONNECT_TIMEOUT_SEC", 15);

  directSql = postgres(connectionString, {
    max: maxPool,
    idle_timeout: 30,
    connect_timeout: connectTimeoutSec,
    prepare: !connectionString.includes("-pooler"),
    ssl: resolvePgSslOption(connectionString),
  });
  directDb = drizzlePostgresJs(directSql, { schema }) as unknown as MakoPgDb;
  logger.info("Initialized direct platform Postgres client", {
    local,
    maxPool,
  });
  return directDb;
}

/**
 * Normalize raw SQL `db.execute(...)` results across `postgres.js` (returns RowList array),
 * `@neondatabase/serverless` (`{ rows }`), and `@electric-sql/pglite` (`{ rows }`).
 */
export function extractRows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/**
 * Gracefully close all open platform Postgres pools/clients. Safe no-op if never opened.
 */
export async function closePgConnections(): Promise<void> {
  const closers: Array<Promise<unknown>> = [];

  if (runtimeSql) {
    const sqlClient = runtimeSql;
    runtimeSql = null;
    closers.push(sqlClient.end({ timeout: 5 }));
  }
  if (runtimeNeonPool) {
    const pool = runtimeNeonPool;
    runtimeNeonPool = null;
    closers.push(pool.end());
  }
  runtimeDb = null;

  if (directSql) {
    const sqlClient = directSql;
    directSql = null;
    closers.push(sqlClient.end({ timeout: 5 }));
  }
  directDb = null;

  if (closers.length > 0) {
    await Promise.all(closers);
    logger.info("Closed platform Postgres connections");
  }
}
