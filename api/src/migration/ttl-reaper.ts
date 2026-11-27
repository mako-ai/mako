/**
 * Batched `ctid` TTL reaper for Postgres tables replacing MongoDB's 16 non-CDC TTL indexes.
 *
 * Deletes expired rows in bounded batches using `WHERE ctid IN (SELECT ctid ... LIMIT $batch)`
 * so large expirations (e.g. 90-day `query_executions` or 400-day `app_usage_events`) never
 * hold long locks or bloat WAL in a single transaction.
 *
 * Security-sensitive tables (sessions, email verifications, desktop auth codes, invites,
 * MCP OAuth codes/tokens, ACP grants) must ALSO enforce `expires_at > now()` on read queries.
 */
import { sql } from "drizzle-orm";
import { extractRows, getPgDb, type MakoPgDb } from "../database/pg/client";
import { loggers } from "../logging";

const logger = loggers.migration();

/** Strict PostgreSQL unquoted identifier pattern preventing SQL injection via dynamic table/column names. */
const SAFE_SQL_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export const DEFAULT_TTL_BATCH_SIZE = 5_000;
export const DEFAULT_TTL_MAX_BATCHES = 20;

export interface TtlTableRule {
  /** Snake-case Postgres table name (validated against SAFE_SQL_IDENT_RE). */
  tableName: string;
  /** Timestamp column checked against cutoff (e.g. `expires_at`, `created_at`, `last_at`). */
  timestampColumn: string;
  /**
   * Optional retention window in milliseconds:
   *   - Omitted / 0: delete rows where `timestampColumn < now()` (explicit expiry timestamp).
   *   - Positive ms: delete rows where `timestampColumn < now() - olderThanMs` (age-based TTL).
   */
  olderThanMs?: number;
  batchSize?: number;
  maxBatchesPerRun?: number;
}

export interface TtlReapTableResult {
  tableName: string;
  deleted: number;
  batches: number;
  hitBatchCap: boolean;
  cutoffIso: string;
}

const ttlRules = new Map<string, TtlTableRule>();

export function assertSafeSqlIdentifier(ident: string, label: string): void {
  if (!SAFE_SQL_IDENT_RE.test(ident)) {
    throw new Error(
      `Unsafe SQL ${label} identifier: ${JSON.stringify(ident)}. Must match ${SAFE_SQL_IDENT_RE}.`,
    );
  }
}

export function registerTtlRule(rule: TtlTableRule): void {
  assertSafeSqlIdentifier(rule.tableName, "tableName");
  assertSafeSqlIdentifier(rule.timestampColumn, "timestampColumn");
  ttlRules.set(rule.tableName, { ...rule });
}

export function listTtlRules(): TtlTableRule[] {
  return [...ttlRules.values()];
}

export function clearTtlRegistryForTests(): void {
  ttlRules.clear();
}

/**
 * Reap expired rows from one table using bounded `ctid` sub-select batches.
 */
export async function reapExpiredRows(
  rule: TtlTableRule,
  options: { db?: MakoPgDb; now?: Date } = {},
): Promise<TtlReapTableResult> {
  assertSafeSqlIdentifier(rule.tableName, "tableName");
  assertSafeSqlIdentifier(rule.timestampColumn, "timestampColumn");

  const db = options.db ?? getPgDb();
  const now = options.now ?? new Date();
  const batchSize = Math.max(1, rule.batchSize ?? DEFAULT_TTL_BATCH_SIZE);
  const maxBatches = Math.max(
    1,
    rule.maxBatchesPerRun ?? DEFAULT_TTL_MAX_BATCHES,
  );
  const cutoff = new Date(now.getTime() - (rule.olderThanMs ?? 0));
  const cutoffIso = cutoff.toISOString();

  const tableIdent = sql.raw(`"${rule.tableName}"`);
  const colIdent = sql.raw(`"${rule.timestampColumn}"`);

  let totalDeleted = 0;
  let batches = 0;
  let hitBatchCap = false;

  while (batches < maxBatches) {
    batches += 1;
    const rawResult = await db.execute(sql`
      WITH doomed AS (
        SELECT ctid
        FROM ${tableIdent}
        WHERE ${colIdent} IS NOT NULL
          AND ${colIdent} < ${cutoffIso}::timestamptz
        LIMIT ${batchSize}
      ),
      deleted AS (
        DELETE FROM ${tableIdent} t
        USING doomed d
        WHERE t.ctid = d.ctid
        RETURNING 1
      )
      SELECT count(*)::int AS deleted_count FROM deleted
    `);

    const rows = extractRows<{ deleted_count: number | string }>(rawResult);
    const deletedInBatch = Number(rows[0]?.deleted_count ?? 0);
    totalDeleted += deletedInBatch;

    if (deletedInBatch < batchSize) {
      break;
    }
    if (batches >= maxBatches) {
      hitBatchCap = true;
    }
  }

  return {
    tableName: rule.tableName,
    deleted: totalDeleted,
    batches,
    hitBatchCap,
    cutoffIso,
  };
}

/**
 * Reap all tables currently registered with `registerTtlRule()`.
 * Errors on one table are logged and do not block remaining tables.
 */
export async function reapAllRegisteredTables(
  options: { db?: MakoPgDb; now?: Date } = {},
): Promise<{ results: TtlReapTableResult[]; errors: Record<string, string> }> {
  const results: TtlReapTableResult[] = [];
  const errors: Record<string, string> = {};

  for (const rule of listTtlRules()) {
    try {
      const res = await reapExpiredRows(rule, options);
      results.push(res);
      if (res.deleted > 0) {
        logger.info("Reaped expired Postgres rows", { ...res });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors[rule.tableName] = msg;
      logger.error("Failed to reap expired Postgres rows", {
        tableName: rule.tableName,
        error: msg,
      });
    }
  }

  return { results, errors };
}

/**
 * Reap all registered tables and throw an aggregated error if any table failed.
 * Remaining tables still reap before throwing so one broken table never blocks
 * healthy tables, while Inngest retries and alerts on the failure.
 */
export async function reapAllRegisteredTablesOrThrow(
  options: { db?: MakoPgDb; now?: Date } = {},
): Promise<{ results: TtlReapTableResult[]; errors: Record<string, string> }> {
  const outcome = await reapAllRegisteredTables(options);
  const failedEntries = Object.entries(outcome.errors);
  if (failedEntries.length > 0) {
    const details = failedEntries
      .map(([table, msg]) => `${table}: ${msg}`)
      .join("; ");
    throw new Error(
      `TTL reaper failed for ${failedEntries.length} table(s): ${details}`,
    );
  }
  return outcome;
}
