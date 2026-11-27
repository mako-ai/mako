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
import {
  generateUuidv7,
  normalizeEntityId,
  parseEntityId,
} from "../database/pg/id-codec";
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
  type PubSubPublisher,
  type PubSubSubscriber,
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
  /**
   * Eagerly subscribe to pub/sub invalidation in the constructor when `enablePubSub`
   * and Postgres are enabled (default `true`). Set `false` for module-level singletons
   * whose lifecycle is managed explicitly at server boot/shutdown so importing the
   * module never opens a Redis socket in CLI scripts.
   */
  autoSubscribe?: boolean;
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
  /** Optional caller-supplied idempotency key for retry deduplication (defaults to a fresh UUIDv7). */
  idempotencyKey?: string;
  /** Optional monotonic write timestamp (`Date` or ISO string) carried to retry handlers for stale-write guards. */
  updatedAt?: Date | string;
}

export interface ExecuteReadHandlers<T> {
  mongo: () => Promise<T>;
  pg: () => Promise<T>;
  canonicalize?: (value: T) => unknown;
  shadowOptions?: ShadowCompareOptions;
}

export interface ExecuteWriteHandlers<T> {
  mongo: (signal?: AbortSignal) => Promise<T>;
  pg: (signal?: AbortSignal) => Promise<T>;
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

class SecondaryWriteTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "SecondaryWriteTimeoutError";
  }
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
    idempotencyKey: ctx.idempotencyKey,
    updatedAt: ctx.updatedAt,
    timedOut: ctx.timedOut,
    failedAt: new Date().toISOString(),
    errorMessage:
      ctx.error instanceof Error ? ctx.error.message : String(ctx.error),
  };

  try {
    await inngest.send({
      ...(data.idempotencyKey ? { id: data.idempotencyKey } : {}),
      name: eventName,
      data,
    });
  } catch (sendError) {
    logger.error("Failed to enqueue migration sync-retry event", {
      eventName,
      domain: ctx.domain,
      operation: ctx.operation,
      entityId: ctx.entityId,
      idempotencyKey: data.idempotencyKey,
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
  private readonly domainGenerations = new Map<string, number>();
  private nextGeneration = 0;
  private globalGeneration = 0;
  private readonly cacheTtlMs: number;
  private readonly secondaryTimeoutMs: number;
  private readonly shadowRunner: ShadowCompareRunner;
  private readonly rng: () => number;
  private readonly getDb: () => MakoPgDb;
  private readonly hasPg: () => boolean;
  private readonly isForceMongoOnly: () => boolean;
  private readonly enablePubSub: boolean;
  private readonly autoSubscribe: boolean;
  private readonly onSecondaryFailure: (
    ctx: SecondaryWriteFailureContext,
  ) => Promise<void>;

  private publisher: PubSubPublisher | null = null;
  private subscriber: PubSubSubscriber | null = null;
  private pubSubReady = false;
  private pubSubInitPromise: Promise<void> | null = null;
  private lastPubSubAttemptAt = 0;
  private stopped = false;

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
    this.autoSubscribe = options.autoSubscribe ?? true;
    this.onSecondaryFailure =
      options.onSecondaryFailure ?? defaultDispatchSyncRetry;

    // Eagerly establish cross-instance invalidation subscription whenever
    // Postgres is configured so entries cannot be cached before the listener
    // is active.
    if (this.enablePubSub && this.autoSubscribe && this.hasPg()) {
      void this.startInvalidationListener();
    }
  }

  private cacheKey(domain: string, scopeKey: string): string {
    return `${domain}::${scopeKey}`;
  }

  private getDomainGeneration(domain: string): number {
    return Math.max(
      this.globalGeneration,
      this.domainGenerations.get(domain) ?? 0,
    );
  }

  /** Subscribe once to cross-instance invalidation broadcasts. */
  async startInvalidationListener(): Promise<void> {
    if (!this.enablePubSub) return;
    this.stopped = false;
    if (this.pubSubReady) return;
    if (this.pubSubInitPromise) return this.pubSubInitPromise;

    this.lastPubSubAttemptAt = Date.now();
    this.pubSubInitPromise = (async () => {
      let sub: PubSubSubscriber | null = null;
      try {
        sub = createPubSubSubscriber();
        await sub.connect();
        await sub.subscribe(MIGRATION_STATE_CHANNEL, raw => {
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
        if (this.stopped) {
          await sub.unsubscribe(MIGRATION_STATE_CHANNEL).catch(() => undefined);
          await sub.quit?.().catch(() => undefined);
          return;
        }
        this.subscriber = sub;
        this.pubSubReady = true;
        // Invalidate any entries cached or queries started before subscription
        // became active so a missed broadcast during startup cannot linger.
        this.invalidateCache();
      } catch (error) {
        await sub?.quit?.().catch(() => undefined);
        logger.warn(
          "Migration state pub/sub listener unavailable; using TTL cache only",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      } finally {
        this.pubSubInitPromise = null;
      }
    })();

    return this.pubSubInitPromise;
  }

  async stopInvalidationListener(): Promise<void> {
    this.stopped = true;
    if (this.pubSubInitPromise) {
      await this.pubSubInitPromise.catch(() => undefined);
    }
    if (this.subscriber) {
      const sub = this.subscriber;
      this.subscriber = null;
      try {
        await sub.unsubscribe(MIGRATION_STATE_CHANNEL);
      } catch {
        // Ignore teardown errors
      }
      try {
        await sub.quit?.();
      } catch {
        // Ignore teardown errors
      }
    }
    if (this.publisher) {
      const pub = this.publisher;
      this.publisher = null;
      try {
        await pub.quit?.();
      } catch {
        // Ignore teardown errors
      }
    }
    this.pubSubReady = false;
  }

  /**
   * Mark cached rollout state stale (for one domain or all domains) and bump
   * the generation counter so any in-flight SELECT cannot re-cache stale state.
   *
   * Entries are kept with `expiresAt = 0` rather than deleted so a transient PG
   * blip immediately after an invalidation still serves last-known-good state
   * instead of failing closed or split-braining back to Mongo.
   */
  invalidateCache(domain?: string): void {
    const nextGen = ++this.nextGeneration;
    if (!domain) {
      this.globalGeneration = nextGen;
      for (const entry of this.cache.values()) {
        entry.expiresAt = 0;
      }
      return;
    }
    this.domainGenerations.set(domain, nextGen);
    const prefix = `${domain}::`;
    for (const [key, entry] of this.cache.entries()) {
      if (key.startsWith(prefix)) {
        entry.expiresAt = 0;
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

    if (
      this.enablePubSub &&
      !this.stopped &&
      !this.pubSubReady &&
      !this.pubSubInitPromise &&
      now - this.lastPubSubAttemptAt >= 30_000
    ) {
      // Retry subscription if PG became configured after construction or Redis recovered
      void this.startInvalidationListener();
    }

    const scopeKeysToFetch =
      scopeKey === GLOBAL_SCOPE_KEY
        ? [GLOBAL_SCOPE_KEY]
        : [GLOBAL_SCOPE_KEY, scopeKey];

    // Capture per-domain generation BEFORE executing the SELECT so an invalidation
    // arriving while this query is in flight prevents re-caching stale stage state.
    const generationBefore = this.getDomainGeneration(domain);

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

      if (this.getDomainGeneration(domain) === generationBefore) {
        const expiresAt = Date.now() + this.cacheTtlMs;
        this.cache.set(key, {
          state: resolved,
          expiresAt,
        });
        // Also remember the domain's global default whenever we fetched it so
        // previously unseen workspaces can still fall back on a transient PG blip.
        if (scopeKey !== GLOBAL_SCOPE_KEY && globalRow) {
          const globalKey = this.cacheKey(domain, GLOBAL_SCOPE_KEY);
          this.cache.set(globalKey, {
            state: {
              domain,
              scopeKey: globalRow.scopeKey,
              workspaceId: globalRow.workspaceId,
              mode: globalRow.mode,
              shadowSampleRate: globalRow.shadowSampleRate,
            },
            expiresAt,
          });
        }
      }
      return resolved;
    } catch (error) {
      // Preserve last known state on transient PG blips (avoid split-brain back into
      // frozen Mongo once a domain has advanced to dual_write_pg_read / pg_only).
      // On a true cold cache miss (no known state for this scope or domain global),
      // fail closed by rethrowing rather than silently routing to Mongo.
      const staleFallback =
        cached ??
        (scopeKey !== GLOBAL_SCOPE_KEY
          ? this.cache.get(this.cacheKey(domain, GLOBAL_SCOPE_KEY))
          : undefined);
      if (staleFallback) {
        logger.error(
          "Failed to refresh migration_domain_state; serving stale cached state",
          {
            domain,
            scopeKey,
            staleScopeKey: staleFallback.state.scopeKey,
            staleMode: staleFallback.state.mode,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return staleFallback.state;
      }
      logger.error(
        "Failed to read migration_domain_state on cold cache; failing closed",
        {
          domain,
          scopeKey,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      throw error;
    }
  }

  /**
   * Upsert rollout stage in `migration_domain_state` and broadcast invalidation
   * to all API instances.
   *
   * Omitting `shadowSampleRate` preserves any existing `shadow_sample_rate` on
   * conflict instead of silently resetting it to `0`. Entering
   * `dual_write_shadow_compare` requires an effective `shadowSampleRate > 0`.
   */
  async setDomainState(
    input: SetDomainStateInput,
  ): Promise<ResolvedDomainState> {
    if (input.shadowSampleRate !== undefined) {
      if (
        input.shadowSampleRate < 0 ||
        input.shadowSampleRate > 1 ||
        Number.isNaN(input.shadowSampleRate)
      ) {
        throw new Error(
          `shadowSampleRate must be within [0, 1], got ${input.shadowSampleRate}`,
        );
      }
      if (
        input.mode === "dual_write_shadow_compare" &&
        input.shadowSampleRate <= 0
      ) {
        throw new Error(
          "dual_write_shadow_compare requires shadowSampleRate > 0",
        );
      }
    }

    const { scopeKey, workspaceUuid } = normalizeScopeKey(input.workspaceId);
    const now = new Date();
    const db = this.getDb();

    const persisted = await db.transaction(async tx => {
      if (
        input.mode === "dual_write_shadow_compare" &&
        input.shadowSampleRate === undefined
      ) {
        const existing = await tx
          .select({ shadowSampleRate: migrationDomainState.shadowSampleRate })
          .from(migrationDomainState)
          .where(
            and(
              eq(migrationDomainState.domain, input.domain),
              eq(migrationDomainState.scopeKey, scopeKey),
            ),
          );
        if (!existing[0] || existing[0].shadowSampleRate <= 0) {
          throw new Error(
            "dual_write_shadow_compare requires shadowSampleRate > 0 " +
              "(pass shadowSampleRate explicitly or preserve an existing positive rate)",
          );
        }
      }

      const conflictSet: {
        mode: MigrationMode;
        shadowSampleRate?: number;
        updatedBy: string | null;
        notes: string | null;
        updatedAt: Date;
      } = {
        mode: input.mode,
        updatedBy: input.updatedBy ?? null,
        notes: input.notes ?? null,
        updatedAt: now,
      };
      if (input.shadowSampleRate !== undefined) {
        conflictSet.shadowSampleRate = input.shadowSampleRate;
      }

      const [row] = await tx
        .insert(migrationDomainState)
        .values({
          domain: input.domain,
          scopeKey,
          workspaceId: workspaceUuid,
          mode: input.mode,
          shadowSampleRate: input.shadowSampleRate ?? 0,
          updatedBy: input.updatedBy ?? null,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [migrationDomainState.domain, migrationDomainState.scopeKey],
          set: conflictSet,
        })
        .returning();

      if (
        input.mode === "dual_write_shadow_compare" &&
        row.shadowSampleRate <= 0
      ) {
        throw new Error(
          "dual_write_shadow_compare requires shadowSampleRate > 0",
        );
      }
      return row;
    });

    const resolved: ResolvedDomainState = {
      domain: persisted.domain,
      scopeKey: persisted.scopeKey,
      workspaceId: persisted.workspaceId,
      mode: persisted.mode,
      shadowSampleRate: persisted.shadowSampleRate,
    };

    this.invalidateCache(input.domain);
    // Keep the newly persisted state as an already-expired fallback entry so
    // the next read refreshes from PG while an immediate PG blip won't cold-miss
    // or revert to a superseded stage.
    const exactKey = this.cacheKey(input.domain, scopeKey);
    this.cache.set(exactKey, { state: resolved, expiresAt: 0 });
    if (scopeKey === GLOBAL_SCOPE_KEY) {
      const prefix = `${input.domain}::`;
      for (const [entryKey, entry] of this.cache.entries()) {
        if (
          entryKey.startsWith(prefix) &&
          entry.state.scopeKey === GLOBAL_SCOPE_KEY
        ) {
          entry.state = resolved;
          entry.expiresAt = 0;
        }
      }
    }

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

    return resolved;
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
    const writeUpdatedAt =
      ctx.updatedAt instanceof Date
        ? ctx.updatedAt.toISOString()
        : (ctx.updatedAt ?? new Date().toISOString());

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
          writeUpdatedAt,
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
          writeUpdatedAt,
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
    writeFn: (signal?: AbortSignal) => Promise<unknown>,
    timeoutMs: number,
    onFailure: (ctx: SecondaryWriteFailureContext) => Promise<void>,
    updatedAt: string,
  ): Promise<void> {
    const controller = new AbortController();
    const label = `Secondary ${target} write (${ctx.domain}.${ctx.operation})`;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const writePromise = Promise.resolve().then(() =>
      writeFn(controller.signal),
    );
    // Avoid unhandled rejections if the underlying driver rejects after timeout
    // aborts the signal and wins the race.
    writePromise.catch(() => undefined);

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const timeoutError = new SecondaryWriteTimeoutError(label, timeoutMs);
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      await Promise.race([writePromise, timeoutPromise]);
    } catch (error) {
      const timedOut = error instanceof SecondaryWriteTimeoutError;
      const idempotencyKey = ctx.idempotencyKey ?? generateUuidv7();
      recordWriteError(ctx.domain, target, ctx.operation);
      logger.error("Secondary dual-write failed (primary succeeded)", {
        target,
        domain: ctx.domain,
        operation: ctx.operation,
        entityId: ctx.entityId,
        workspaceId: ctx.workspaceId ?? undefined,
        idempotencyKey,
        updatedAt,
        timedOut,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await onFailure({
          target,
          domain: ctx.domain,
          operation: ctx.operation,
          entityId: ctx.entityId,
          workspaceId: ctx.workspaceId ?? undefined,
          payload: ctx.retryPayload,
          idempotencyKey,
          updatedAt,
          timedOut,
          error,
        });
      } catch (hookError) {
        logger.error("Secondary failure hook threw (primary still succeeded)", {
          target,
          domain: ctx.domain,
          operation: ctx.operation,
          entityId: ctx.entityId,
          idempotencyKey,
          hookError:
            hookError instanceof Error ? hookError.message : String(hookError),
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
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
      entityId: normalizeEntityId(entityId),
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

// Module-level singleton: `autoSubscribe: false` prevents opening a Redis
// subscriber socket on bare module import (CLI scripts / tests); the API server
// starts the listener eagerly at boot in `api/src/index.ts`.
export const migrationRouter = new MigrationRouter({ autoSubscribe: false });
