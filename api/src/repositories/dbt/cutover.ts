import { setTimeout as delay } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { extractRows, getPgDb, type MakoPgDb } from "../../database/pg/client";
import { migrationDomainState } from "../../database/pg/schema";
import type { Db } from "mongodb";
import {
  dbtWriterGeneration,
  drainDbtWriters,
  generationChanged,
  withDbtWriteFence,
} from "./mongo-fence";
import type { DbtRepository } from "./types";

// Only known read-only calls bypass the Mongo mutation transaction.
const reads = new Set<PropertyKey>([
  "findProjectById",
  "listProjectsByWorkspace",
  "workspaceHasProject",
  "findEnvPreference",
  "listEnvPreferencesForUser",
  "findJobById",
  "findJobBySlug",
  "listJobsByProject",
  "listJobsByIds",
  "jobSlugExists",
  "findDueScheduledJobs",
  "findRunById",
  "findRunWithLogs",
  "findLatestArtifactRun",
  "findLatestRun",
  "listRuns",
  "runExists",
  "findRunSlotHolder",
  "listActiveRunsWithLogTail",
] satisfies (keyof DbtRepository)[]);

const domain = "dbt";
const lock = sql`hashtextextended('mako:dbt:store-cutover', 0)`;

export async function dbtUsesPostgres(db: MakoPgDb) {
  const [row] = await db
    .select({ mode: migrationDomainState.mode })
    .from(migrationDomainState)
    .where(
      and(
        eq(migrationDomainState.domain, domain),
        eq(migrationDomainState.scopeKey, "global"),
      ),
    );
  if (!row || row.mode === "mongo_only") return false;
  if (row.mode === "pg_only") return true;
  throw new Error("Unexpected dbt cutover mode");
}

// A pre-copy can overlap normal Mongo calls but cannot cross activation.
export async function precopyDbtStore<T>(
  db: MakoPgDb,
  copy: (tx: MakoPgDb) => Promise<T>,
) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${lock})`);
    if (await dbtUsesPostgres(tx)) {
      throw new Error("dbt is already on Postgres; use --verify");
    }
    return copy(tx);
  });
}

// A successful activation and its parity checks commit in the same transaction.
// The Mongo generation drains admitted mutations independently of their PG sessions.
export async function activateDbtStore<T>(
  db: MakoPgDb,
  source: Db,
  reconcile: (tx: MakoPgDb) => Promise<T>,
) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${lock})`);
    if (await dbtUsesPostgres(tx)) {
      throw new Error("dbt is already on Postgres; use --verify");
    }
    await drainDbtWriters(source);
    const result = await reconcile(tx);
    await tx
      .insert(migrationDomainState)
      .values({ domain, scopeKey: "global", mode: "pg_only" })
      .onConflictDoUpdate({
        target: [migrationDomainState.domain, migrationDomainState.scopeKey],
        set: { mode: "pg_only", updatedAt: new Date() },
      });
    return result;
  });
}

export function createDbtCutoverRepo(
  pg: DbtRepository,
  mongo: DbtRepository,
  getDb = getPgDb,
): DbtRepository {
  let activated = false;
  return new Proxy(pg, {
    get(target, key) {
      const method = Reflect.get(target, key);
      if (typeof method !== "function") return method;
      return async (...args: unknown[]) => {
        const call = (repo: DbtRepository): Promise<unknown> =>
          Reflect.apply(Reflect.get(repo, key), repo, args);
        while (!activated) {
          const db = getDb();
          // A fresh instance after cutover can route without contacting Mongo.
          if (await dbtUsesPostgres(db)) {
            activated = true;
            break;
          }
          // Capture the generation BEFORE admission. An activator between the
          // two steps makes this ticket stale even if its PG connection dies.
          const generation = reads.has(key)
            ? null
            : await dbtWriterGeneration();
          const store = await db.transaction(async tx => {
            const [{ acquired }] = extractRows<{ acquired: boolean }>(
              await tx.execute(
                sql`select pg_try_advisory_xact_lock_shared(${lock}) as acquired`,
              ),
            );
            if (!acquired) return "wait";
            return (await dbtUsesPostgres(tx)) ? "pg" : "mongo";
          });
          if (store === "pg") {
            activated = true;
            break;
          }
          if (store === "mongo") {
            if (generation === null) return call(mongo);
            const result = await withDbtWriteFence(generation, call);
            if (result !== generationChanged) return result;
          }
          await delay(500 + Math.random() * 500);
        }
        // Activation is one-way. Normal Postgres traffic pays no routing query.
        return Reflect.apply(method, target, args);
      };
    },
  });
}
