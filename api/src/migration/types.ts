/**
 * Shared types for the incremental MongoDB -> Neon Postgres dual-run migration engine.
 */
import type {
  BackfillJobStatus,
  MigrationMode,
} from "../database/pg/schema/control-plane";

export {
  BACKFILL_JOB_STATUSES,
  GLOBAL_SCOPE_KEY,
  MIGRATION_MODES,
  type BackfillJobStatus,
  type MigrationMode,
} from "../database/pg/schema/control-plane";

/** Canonical migration domain identifiers across Phases 1–4. */
export const KNOWN_MIGRATION_DOMAINS = [
  "auth",
  "workspaces_core",
  "connections",
  "consoles_charts",
  "apps_metadata",
  "usage_stats",
  "mcp",
  "chat",
  "dbt",
  "notifications",
] as const;

export type KnownMigrationDomain = (typeof KNOWN_MIGRATION_DOMAINS)[number];
export type MigrationDomain = KnownMigrationDomain | (string & {});

export interface ResolvedDomainState {
  domain: string;
  scopeKey: string;
  workspaceId: string | null;
  mode: MigrationMode;
  shadowSampleRate: number;
}

export interface SyncRetryEventData {
  target: "pg" | "mongo";
  domain: string;
  operation: string;
  entityId: string;
  workspaceId?: string;
  payload?: Record<string, unknown>;
  /** Unique idempotency key for this logical write so replays can deduplicate (e.g. `$inc` rollups). */
  idempotencyKey?: string;
  /** ISO-8601 timestamp captured when the write began so delayed replays never overwrite newer writes. */
  updatedAt?: string;
  /** True when the original secondary write timed out and its AbortSignal was aborted. */
  timedOut?: boolean;
  failedAt: string;
  errorMessage: string;
}

export interface SecondaryWriteFailureContext {
  target: "pg" | "mongo";
  domain: string;
  operation: string;
  entityId?: string;
  workspaceId?: string;
  payload?: Record<string, unknown>;
  /** Unique idempotency key for this logical write (caller-supplied or generated UUIDv7). */
  idempotencyKey?: string;
  /** ISO-8601 timestamp captured when the write began for stale-replay protection. */
  updatedAt?: string;
  /** True when the failure was a timeout (in-flight secondary write was signalled to abort). */
  timedOut?: boolean;
  error: unknown;
}

export interface ShadowCompareOptions {
  /** Additional object key names to redact (logged as SHA-256 hash only). */
  redactKeys?: Iterable<string>;
  /** Treat `null` and omitted/`undefined` object properties as equal (default: true). */
  treatNullAsUndefined?: boolean;
  /** Numeric tolerance for floating-point comparisons such as USD costs (default: 1e-8). */
  floatEpsilon?: number;
  /** Maximum diff entries recorded per comparison (default: 25). */
  maxDiffs?: number;
}

export interface BackfillProgressSummary {
  domain: string;
  scopeKey: string;
  status: BackfillJobStatus;
  lastCursor: string | null;
  batchesRun: number;
  rowsProcessed: number;
  rowsUpserted: number;
  rowsSkippedTombstone: number;
  rowsQuarantined: number;
  dryRun: boolean;
}
