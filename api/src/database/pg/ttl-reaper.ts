/**
 * Batched `ctid` TTL reaper for platform Postgres tables.
 *
 * Deletes expired rows in bounded batches using `WHERE ctid IN (SELECT ctid ... LIMIT $batch)`
 * so large expirations (e.g. 90-day `query_executions` or 400-day `app_usage_events`) never
 * hold long locks or bloat WAL in a single transaction.
 *
 * Security-sensitive tables (sessions, email verifications, desktop auth codes, invites,
 * MCP OAuth codes/tokens, ACP grants) must ALSO enforce `expires_at > now()` on read queries.
 *
 * Invariants:
 *   - NEVER register `app_binding_drafts` or `app_binding_jobs` here: they own GCS/artifact
 *     parquet blobs and are pruned exclusively by `pruneExpiredDrafts()` / `pruneExpiredJobs()`.
 *   - NEVER register `llm_usage` (permanent billing ledger), `app_usage_daily`, or
 *     `connection_access_events` (audit log).
 */
import { sql } from "drizzle-orm";
import { loggers } from "../../logging";
import { MCP_OAUTH_FLOW_TTL_MS } from "../../repositories/mcp/types";
import { extractRows, getPgDb, type MakoPgDb } from "./client";

const logger = loggers.db("postgres");

/** Strict PostgreSQL unquoted identifier pattern preventing SQL injection via dynamic table/column names. */
const SAFE_SQL_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Authoritative list of platform Postgres TTL rules across all domains. */
export const DEFAULT_PG_TTL_RULES: readonly TtlTableRule[] = [
  // Auth
  { tableName: "sessions", timestampColumn: "expires_at" },
  { tableName: "email_verifications", timestampColumn: "expires_at" },
  { tableName: "desktop_auth_codes", timestampColumn: "expires_at" },
  // Workspaces & OAuth/ACP grants
  { tableName: "workspace_invites", timestampColumn: "expires_at" },
  { tableName: "mcp_oauth_codes", timestampColumn: "expires_at" },
  { tableName: "mcp_oauth_tokens", timestampColumn: "refresh_expires_at" },
  { tableName: "acp_plan_grants", timestampColumn: "expires_at" },
  // Connections
  {
    tableName: "connection_write_events",
    timestampColumn: "at",
    olderThanMs: 90 * DAY_MS,
  },
  // Consoles & Charts
  {
    tableName: "scheduled_query_runs",
    timestampColumn: "completed_at",
    olderThanMs: 90 * DAY_MS,
  },
  // MCP
  {
    tableName: "mcp_oauth_flows",
    timestampColumn: "created_at",
    olderThanMs: MCP_OAUTH_FLOW_TTL_MS,
  },
  // Usage & telemetry
  {
    tableName: "app_feed_snapshots",
    timestampColumn: "created_at",
    olderThanMs: 1 * DAY_MS,
  },
  {
    tableName: "query_executions",
    timestampColumn: "executed_at",
    olderThanMs: 90 * DAY_MS,
  },
  {
    tableName: "connection_verifications",
    timestampColumn: "verified_at",
    olderThanMs: 90 * DAY_MS,
  },
  {
    tableName: "app_usage_events",
    timestampColumn: "at",
    olderThanMs: 400 * DAY_MS,
  },
  {
    tableName: "skill_usage_daily",
    timestampColumn: "last_at",
    olderThanMs: 400 * DAY_MS,
  },
  // App control plane (notifications, workflow dry-run recorded writes)
  {
    tableName: "notification_deliveries",
    timestampColumn: "created_at",
    olderThanMs: 90 * DAY_MS,
  },
  {
    tableName: "workflow_recorded_writes",
    timestampColumn: "at",
    olderThanMs: 7 * DAY_MS,
  },
  {
    tableName: "workflow_recorded_runs",
    timestampColumn: "at",
    olderThanMs: 7 * DAY_MS,
  },
];

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

export function registerDefaultPgTtlRules(): void {
  for (const rule of DEFAULT_PG_TTL_RULES) {
    registerTtlRule(rule);
  }
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
