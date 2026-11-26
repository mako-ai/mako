/**
 * Per-domain and per-workspace incremental rollout router (5-stage state machine).
 *
 * Rollout stages:
 *   1. `mongo_only`               — read Mongo, write Mongo
 *   2. `dual_write_mongo_read`    — read Mongo, write Mongo (primary) + PG (secondary)
 *   3. `dual_write_shadow_compare`— read Mongo + sampled async PG diff, write Mongo + PG
 *   4. `dual_write_pg_read`       — read PG (+ optional reverse shadow), write PG (primary) + Mongo (secondary)
 *   5. `pg_only`                  — read PG, write PG
 *
 * Control plane & caching:
 *   - State is persisted in Postgres `migration_domain_state`.
 *   - Workspace override takes precedence over global domain default; missing rows default to `mongo_only`.
 *   - Cached in-memory for 5s and invalidated across Cloud Run replicas in <1s via Mako's
 *     shared pub/sub service (`REDIS_URL` in prod, in-process EventEmitter locally).
 *   - `MIGRATION_FORCE_MONGO_ONLY=true` short-circuits immediately to `mongo_only` without
 *     touching Postgres.
 */
import { and, eq, inArray, lt } from "drizzle-orm";
import {
  getPgDb,
  hasPostgresConfig,
  type MakoPgDb,
} from "../database/pg/client";
import { parseEntityId } from "../database/pg/id-codec";
import {
  GLOBAL_SCOPE_KEY,
  migrationDomainState,
  migrationTombstones,
  type MigrationMode,
} from "../database/pg/schema/control-plane";
import { inngest } from "../inngest/client";
import { loggers } from "../logging";
import {
  createPubSubPublisher,
  createPubSubSubscriber,
  type Publisher,
  type Subscriber,
} from "../services/pubsub.service";
import {
  ShadowCompareRunner,
  recordReadLatency,
  recordWriteError,
  shadowCompareRunner,
} from "./shadow-compare";
import type {
  MigrationDomain,
  ResolvedDomainState,
  SecondaryWriteFailureContext,
  ShadowCompareOptions,
  SyncRetryEventData,
} from "./types";

const logger = loggers.db("migration-router");

export const MIGRATION_STATE_CHANNEL = "mako:migration:state-changed";
export const DEFAULT_STATE_CACHE_TTL_MS = 5_000;
export const DEFAULT_SECONDARY_WRITE_TIMEOUT_MS = 1_500;

interface CacheEntry {
  state: ResolvedDomainState;
  expiresAt: number;
}

export interface MigrationRouterOptions {
  cacheTtlMs?: number;
  secondaryTimeoutMs?: number;
  shadowRunner?: ShadowCompareRunner;
  rng?: () => number;
  getDb?: () => MakoPgDb;
  hasPg?: () => boolean;
  isForceMongoOnly?: () => boolean;
  enablePubSub?: boolean;
  onSecondaryFailure?: (ctx: SecondaryWriteFailureContext) => Promise<void>;
}

export interface SetDomainStateInput {
  domain: MigrationDomain;
  /** Optional workspace ID (accepts 24-hex ObjectId or 36-char UUID); omit/null for global default. */
  workspaceId?: string | null;
  mode: MigrationMode;
  shadowSampleRate?: number;
  updatedBy?: string;
  notes?: string;
}

export interface RouterOperationContext {
  domain: MigrationDomain;
  operation: string;
  /** Optional workspace ID (accepts 24-hex ObjectId or 36-char UUID). */
  workspaceId?: string | null;
  entityId?: string;
  /** Metadata attached to dead-letter retry events on secondary write failure. */
  retryPayload?: Record<string, unknown>;
}

export interface ExecuteReadHandlers<T> {
  mongo: () => Promise<T>;
  pg: () => Promise<T>;
  canonicalize?: (value: T) => unknown;
  shadowOptions?: ShadowCompareOptions;
}

export interface ExecuteWriteHandlers<T> {
  mongo: () => Promise<T>;
  pg: () => Promise<T>;
  secondaryTimeoutMs?: number;
  onSecondaryFailure?: (ctx: SecondaryWriteFailureContext) => Promise<void>;
}

function normalizeScopeKey(workspaceId: string | null | undefined): {
  scopeKey: string;
  workspaceUuid: string | null;
} {
  if (!workspaceId) {
    return { scopeKey: GLOBAL_SCOPE_KEY, workspaceUuid: null };
  }
  const parsed = parseEntityId(workspaceId);
  if (!parsed) {
    throw new Error(
      `Invalid workspaceId for migration scope: ${JSON.stringify(workspaceId)}`,
    );
  }
  return { scopeKey: parsed.uuid, workspaceUuid: parsed.uuid };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function defaultDispatchSyncRetry(
  ctx: SecondaryWriteFailureContext,
): Promise<void> {
  const eventName =
    ctx.target === "pg"
      ? "migration/pg-sync-retry"
      : "migration/mongo-sync-retry";

  const data: SyncRetryEventData = {
    target: ctx.target,
    domain: ctx.domain,
    operation: ctx.operation,
    entityId: ctx.entityId ?? "unknown",
    workspaceId: ctx.workspaceId,
    payload: ctx.payload,
    failedAt: new Date().toISOString(),
    errorMessage:
      ctx.error instanceof Error ? ctx.error.message : String(ctx.error),
  };

  try {
    await inngest.send({ name: eventName, data });
  } catch (sendError) {
    logger.error("Failed to enqueue migration sync-retry event", {
      eventName,
      domain: ctx.domain,
      operation: ctx.operation,
      entityId: ctx.entityId,
      sendError:
        sendError instanceof Error ? sendError.message : String(sendError),
    });
  }
}

export function isMigrationForceMongoOnly(): boolean {
  return (
    process.env.MIGRATION_FORCE_MONGO_ONLY?.trim().toLowerCase() === "true"
  );
}

export class MigrationRouter {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly secondaryTimeoutMs: number;
  private readonly shadowRunner: ShadowCompareRunner;
  private readonly rng: () => number;
  private readonly getDb: () => MakoPgDb;
  private readonly hasPg: () => boolean;
  private readonly isForceMongoOnly: () => boolean;
  private readonly enablePubSub: boolean;
  private readonly onSecondaryFailure: (
    ctx: SecondaryWriteFailureContext,
  ) => Promise<void>;

  private publisher: Publisher | null = null;
  private subscriber: Subscriber | null = null;
  private pubSubSubscribed = false;

  constructor(options: MigrationRouterOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_STATE_CACHE_TTL_MS;
    this.secondaryTimeoutMs =
      options.secondaryTimeoutMs ?? DEFAULT_SECONDARY_WRITE_TIMEOUT_MS;
    this.shadowRunner = options.shadowRunner ?? shadowCompareRunner;
    this.rng = options.rng ?? Math.random;
    this.getDb = options.getDb ?? getPgDb;
    this.hasPg = options.hasPg ?? hasPostgresConfig;
    this.isForceMongoOnly =
      options.isForceMongoOnly ?? isMigrationForceMongoOnly;
    this.enablePubSub = options.enablePubSub ?? true;
    this.onSecondaryFailure =
      options.onSecondaryFailure ?? defaultDispatchSyncRetry;
  }

  private cacheKey(domain: string, scopeKey: string): string {
    return `${domain}::${scopeKey}`;
  }

  /** Subscribe once to cross-instance invalidation broadcasts. */
  async startInvalidationListener(): Promise<void> {
    if (!this.enablePubSub || this.pubSubSubscribed) return;
    this.pubSubSubscribed = true;
    try {
      this.subscriber = createPubSubSubscriber();
      await this.subscriber.connect();
      await this.subscriber.subscribe(MIGRATION_STATE_CHANNEL, raw => {
        try {
          const msg = JSON.parse(raw) as { domain?: string };
          if (msg.domain) {
            this.invalidateCache(msg.domain);
          } else {
            this.invalidateCache();
          }
        } catch {
          this.invalidateCache();
        }
      });
    } catch (error) {
      this.pubSubSubscribed = false;
      logger.warn(
        "Migration state pub/sub listener unavailable; using TTL cache only",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  async stopInvalidationListener(): Promise<void> {
    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe(MIGRATION_STATE_CHANNEL);
      } catch {
        // Ignore teardown errors
      }
      this.subscriber = null;
    }
    this.publisher = null;
    this.pubSubSubscribed = false;
  }

  /** Clear cached rollout state (for one domain or all domains). */
  invalidateCache(domain?: string): void {
    if (!domain) {
      this.cache.clear();
      return;
    }
    const prefix = `${domain}::`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Resolve the effective rollout state for `(domain, workspaceId?)`.
   * Resolution order: kill switch -> workspace override -> domain default -> `mongo_only`.
   */
  async getState(
    domain: MigrationDomain,
    workspaceId?: string | null,
  ): Promise<ResolvedDomainState> {
    if (this.isForceMongoOnly() || !this.hasPg()) {
      return {
        domain,
        scopeKey: GLOBAL_SCOPE_KEY,
        workspaceId: null,
        mode: "mongo_only",
        shadowSampleRate: 0,
      };
    }

    const { scopeKey, workspaceUuid } = normalizeScopeKey(workspaceId);
    const key = this.cacheKey(domain, scopeKey);
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.state;
    }

    if (this.enablePubSub && !this.pubSubSubscribed) {
      // Lazy listener activation without blocking reads if Redis is slow
      void this.startInvalidationListener();
    }

    const scopeKeysToFetch =
      scopeKey === GLOBAL_SCOPE_KEY
        ? [GLOBAL_SCOPE_KEY]
        : [GLOBAL_SCOPE_KEY, scopeKey];

    try {
      const db = this.getDb();
      const rows = await db
        .select()
        .from(migrationDomainState)
        .where(
          and(
            eq(migrationDomainState.domain, domain),
            inArray(migrationDomainState.scopeKey, scopeKeysToFetch),
          ),
        );

      const wsRow =
        scopeKey !== GLOBAL_SCOPE_KEY
          ? rows.find(r => r.scopeKey === scopeKey)
          : undefined;
      const globalRow = rows.find(r => r.scopeKey === GLOBAL_SCOPE_KEY);
      const chosen = wsRow ?? globalRow;

      const resolved: ResolvedDomainState = chosen
        ? {
            domain,
            scopeKey: chosen.scopeKey,
            workspaceId: chosen.workspaceId,
            mode: chosen.mode,
            shadowSampleRate: chosen.shadowSampleRate,
          }
        : {
            domain,
            scopeKey,
            workspaceId: workspaceUuid,
            mode: "mongo_only",
            shadowSampleRate: 0,
          };

      this.cache.set(key, {
        state: resolved,
        expiresAt: now + this.cacheTtlMs,
      });
      return resolved;
    } catch (error) {
      // Fail safe to mongo_only if control-plane lookup errors while PG is degraded
      logger.error(
        "Failed to read migration_domain_state; failing safe to mongo_only",
        {
          domain,
          scopeKey,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return {
        domain,
        scopeKey: GLOBAL_SCOPE_KEY,
        workspaceId: null,
        mode: "mongo_only",
        shadowSampleRate: 0,
      };
    }
  }

  /**
   * Upsert rollout stage in `migration_domain_state` and broadcast invalidation
   * to all API instances.
   */
  async setDomainState(
    input: SetDomainStateInput,
  ): Promise<ResolvedDomainState> {
    const sampleRate = input.shadowSampleRate ?? 0;
    if (sampleRate < 0 || sampleRate > 1 || Number.isNaN(sampleRate)) {
      throw new Error(
        `shadowSampleRate must be within [0, 1], got ${sampleRate}`,
      );
    }

    const { scopeKey, workspaceUuid } = normalizeScopeKey(input.workspaceId);
    const now = new Date();
    const db = this.getDb();

    await db
      .insert(migrationDomainState)
      .values({
        domain: input.domain,
        scopeKey,
        workspaceId: workspaceUuid,
        mode: input.mode,
        shadowSampleRate: sampleRate,
        updatedBy: input.updatedBy ?? null,
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [migrationDomainState.domain, migrationDomainState.scopeKey],
        set: {
          mode: input.mode,
          shadowSampleRate: sampleRate,
          updatedBy: input.updatedBy ?? null,
          notes: input.notes ?? null,
          updatedAt: now,
        },
      });

    this.invalidateCache(input.domain);

    if (this.enablePubSub) {
      try {
        if (!this.publisher) {
          this.publisher = createPubSubPublisher();
          await this.publisher.connect();
        }
        await this.publisher.publish(
          MIGRATION_STATE_CHANNEL,
          JSON.stringify({ domain: input.domain, scopeKey, mode: input.mode }),
        );
      } catch (error) {
        logger.warn("Failed to publish migration state invalidation", {
          domain: input.domain,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      domain: input.domain,
      scopeKey,
      workspaceId: workspaceUuid,
      mode: input.mode,
      shadowSampleRate: sampleRate,
    };
  }

  /**
   * Execute a read operation routed by the domain/workspace rollout stage.
   * Shadow reads in Stage 3 (and optional reverse shadow reads in Stage 4) run
   * asynchronously off the request critical path.
   */
  async executeRead<T>(
    ctx: RouterOperationContext,
    handlers: ExecuteReadHandlers<T>,
  ): Promise<T> {
    const state = await this.getState(ctx.domain, ctx.workspaceId);

    switch (state.mode) {
      case "mongo_only":
      case "dual_write_mongo_read": {
        const start = performance.now();
        const result = await handlers.mongo();
        recordReadLatency(ctx.domain, "mongo", performance.now() - start);
        return result;
      }

      case "dual_write_shadow_compare": {
        const start = performance.now();
        const result = await handlers.mongo();
        const durationMs = performance.now() - start;
        recordReadLatency(ctx.domain, "mongo", durationMs);

        if (state.shadowSampleRate > 0 && this.rng() < state.shadowSampleRate) {
          this.shadowRunner.schedule({
            domain: ctx.domain,
            operation: ctx.operation,
            entityId: ctx.entityId,
            workspaceId: ctx.workspaceId ?? undefined,
            primaryStore: "mongo",
            primaryResult: result,
            primaryDurationMs: durationMs,
            readShadow: handlers.pg,
            canonicalize: handlers.canonicalize,
            options: handlers.shadowOptions,
          });
        }
        return result;
      }

      case "dual_write_pg_read": {
        const start = performance.now();
        const result = await handlers.pg();
        const durationMs = performance.now() - start;
        recordReadLatency(ctx.domain, "pg", durationMs);

        if (state.shadowSampleRate > 0 && this.rng() < state.shadowSampleRate) {
          this.shadowRunner.schedule({
            domain: ctx.domain,
            operation: ctx.operation,
            entityId: ctx.entityId,
            workspaceId: ctx.workspaceId ?? undefined,
            primaryStore: "pg",
            primaryResult: result,
            primaryDurationMs: durationMs,
            readShadow: handlers.mongo,
            canonicalize: handlers.canonicalize,
            options: handlers.shadowOptions,
          });
        }
        return result;
      }

      case "pg_only": {
        const start = performance.now();
        const result = await handlers.pg();
        recordReadLatency(ctx.domain, "pg", performance.now() - start);
        return result;
      }
    }
  }

  /**
   * Execute a write operation routed by the domain/workspace rollout stage.
   * Secondary store failures or timeouts NEVER fail the primary user request;
   * they are logged, counted, and handed to the dead-letter sync-retry hook.
   */
  async executeWrite<T>(
    ctx: RouterOperationContext,
    handlers: ExecuteWriteHandlers<T>,
  ): Promise<T> {
    const state = await this.getState(ctx.domain, ctx.workspaceId);
    const timeoutMs = handlers.secondaryTimeoutMs ?? this.secondaryTimeoutMs;
    const onFailure = handlers.onSecondaryFailure ?? this.onSecondaryFailure;

    switch (state.mode) {
      case "mongo_only":
        return handlers.mongo();

      case "dual_write_mongo_read":
      case "dual_write_shadow_compare": {
        const primaryResult = await handlers.mongo();
        await this.runSecondaryWrite(
          "pg",
          ctx,
          handlers.pg,
          timeoutMs,
          onFailure,
        );
        return primaryResult;
      }

      case "dual_write_pg_read": {
        const primaryResult = await handlers.pg();
        await this.runSecondaryWrite(
          "mongo",
          ctx,
          handlers.mongo,
          timeoutMs,
          onFailure,
        );
        return primaryResult;
      }

      case "pg_only":
        return handlers.pg();
    }
  }

  private async runSecondaryWrite(
    target: "pg" | "mongo",
    ctx: RouterOperationContext,
    writeFn: () => Promise<unknown>,
    timeoutMs: number,
    onFailure: (ctx: SecondaryWriteFailureContext) => Promise<void>,
  ): Promise<void> {
    try {
      await withTimeout(
        writeFn(),
        timeoutMs,
        `Secondary ${target} write (${ctx.domain}.${ctx.operation})`,
      );
    } catch (error) {
      recordWriteError(ctx.domain, target, ctx.operation);
      logger.error("Secondary dual-write failed (primary succeeded)", {
        target,
        domain: ctx.domain,
        operation: ctx.operation,
        entityId: ctx.entityId,
        workspaceId: ctx.workspaceId ?? undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      await onFailure({
        target,
        domain: ctx.domain,
        operation: ctx.operation,
        entityId: ctx.entityId,
        workspaceId: ctx.workspaceId ?? undefined,
        payload: ctx.retryPayload,
        error,
      });
    }
  }
}

/**
 * Record a delete tombstone inside Postgres so an in-flight backfill cannot
 * resurrect an entity deleted during Stage 2 (`dual_write_mongo_read`).
 */
export async function recordMigrationTombstone(
  tableName: string,
  entityId: string,
  db: MakoPgDb = getPgDb(),
): Promise<void> {
  const now = new Date();
  await db
    .insert(migrationTombstones)
    .values({
      tableName,
      entityId: entityId.toLowerCase(),
      deletedAt: now,
    })
    .onConflictDoUpdate({
      target: [migrationTombstones.tableName, migrationTombstones.entityId],
      set: { deletedAt: now },
    });
}

/** Purge tombstones older than `olderThan` once backfill + parity check completes. */
export async function purgeMigrationTombstones(
  tableName: string,
  olderThan: Date,
  db: MakoPgDb = getPgDb(),
): Promise<void> {
  await db
    .delete(migrationTombstones)
    .where(
      and(
        eq(migrationTombstones.tableName, tableName),
        lt(migrationTombstones.deletedAt, olderThan),
      ),
    );
}

export const migrationRouter = new MigrationRouter();
