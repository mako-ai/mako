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

/** Canonical migration domain identifiers across Phases 1–3. */
export const KNOWN_MIGRATION_DOMAINS = [
  "auth",
  "workspaces_core",
  "consoles_charts",
  "apps_metadata",
  "usage_stats",
  "chat",
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
