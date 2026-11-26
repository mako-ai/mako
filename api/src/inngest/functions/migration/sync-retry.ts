/**
 * Inngest dead-letter retry handlers for failed secondary dual-writes.
 *
 * When `MigrationRouter.executeWrite()` succeeds on the primary store but the
 * secondary store times out or errors, it dispatches:
 *   - `migration/pg-sync-retry`    (Mongo primary -> Postgres secondary replay)
 *   - `migration/mongo-sync-retry` (Postgres primary -> Mongo secondary replay)
 *
 * Domain repositories register their idempotent replay handlers via
 * `registerSyncRetryHandler(domain, handler)` during Phases 1–3.
 */
import { NonRetriableError } from "inngest";
import { inngest } from "../../client";
import { loggers } from "../../../logging";
import { registerMigrationDomains } from "../../../migration/domains";
import type { SyncRetryEventData } from "../../../migration/types";

const logger = loggers.inngest("migration-sync-retry");

/**
 * Domain replay handler for failed secondary dual-writes.
 *
 * Implementations MUST be idempotent and respect `data.idempotencyKey` and
 * `data.updatedAt` (for example via SQL `updated_at` guards or
 * `isSyncRetryStale()`) so a delayed replay or timed-out original write that
 * eventually committed can never double-apply `$inc` rollups or overwrite a
 * newer record.
 */
export type SyncRetryHandler = (data: SyncRetryEventData) => Promise<void>;

const retryHandlers = new Map<string, SyncRetryHandler>();

function handlerKey(target: "pg" | "mongo", domain: string): string {
  return `${target}:${domain}`;
}

export function registerSyncRetryHandler(
  target: "pg" | "mongo",
  domain: string,
  handler: SyncRetryHandler,
): void {
  retryHandlers.set(handlerKey(target, domain), handler);
}

export function getSyncRetryHandler(
  target: "pg" | "mongo",
  domain: string,
): SyncRetryHandler | undefined {
  return retryHandlers.get(handlerKey(target, domain));
}

export function clearSyncRetryHandlersForTests(): void {
  retryHandlers.clear();
}

/**
 * Return true when a retry event's `updatedAt` timestamp is strictly older than
 * the target record's current `updatedAt`, indicating a newer write has already
 * landed and this delayed replay must be skipped.
 */
export function isSyncRetryStale(
  eventUpdatedAt: string | Date | undefined | null,
  currentUpdatedAt: string | Date | undefined | null,
): boolean {
  if (!eventUpdatedAt || !currentUpdatedAt) return false;
  const eventMs =
    eventUpdatedAt instanceof Date
      ? eventUpdatedAt.getTime()
      : Date.parse(eventUpdatedAt);
  const currentMs =
    currentUpdatedAt instanceof Date
      ? currentUpdatedAt.getTime()
      : Date.parse(currentUpdatedAt);
  if (!Number.isFinite(eventMs) || !Number.isFinite(currentMs)) {
    return false;
  }
  return eventMs < currentMs;
}

export async function dispatchSyncRetry(
  target: "pg" | "mongo",
  data: SyncRetryEventData,
): Promise<{
  status: "replayed";
  domain: string;
  entityId: string;
  idempotencyKey?: string;
}> {
  registerMigrationDomains();
  const handler = getSyncRetryHandler(target, data.domain);
  if (!handler) {
    const message =
      `No sync-retry handler registered for target "${target}", domain "${data.domain}" ` +
      `(operation="${data.operation}", entityId="${data.entityId}")`;
    logger.error(
      "No sync-retry handler registered for domain; failing run so event can be replayed",
      {
        target,
        domain: data.domain,
        operation: data.operation,
        entityId: data.entityId,
        idempotencyKey: data.idempotencyKey,
      },
    );
    throw new NonRetriableError(message);
  }

  await handler(data);
  logger.info("Replayed secondary dual-write", {
    target,
    domain: data.domain,
    operation: data.operation,
    entityId: data.entityId,
    idempotencyKey: data.idempotencyKey,
  });
  return {
    status: "replayed",
    domain: data.domain,
    entityId: data.entityId,
    idempotencyKey: data.idempotencyKey,
  };
}

export const MIGRATION_SYNC_RETRY_CONCURRENCY_KEY =
  "event.data.domain + ':' + event.data.entityId";

export const migrationPgSyncRetryFunction = inngest.createFunction(
  {
    id: "migration-pg-sync-retry",
    name: "Migration: retry secondary Postgres write",
    concurrency: [
      { limit: 1, key: MIGRATION_SYNC_RETRY_CONCURRENCY_KEY },
      { limit: 10 },
    ],
    retries: 5,
    triggers: { event: "migration/pg-sync-retry" },
  },
  async ({ event, step }) => {
    const data = event.data as SyncRetryEventData;
    return step.run("replay-pg-write", () => dispatchSyncRetry("pg", data));
  },
);

export const migrationMongoSyncRetryFunction = inngest.createFunction(
  {
    id: "migration-mongo-sync-retry",
    name: "Migration: retry secondary MongoDB write",
    concurrency: [
      { limit: 1, key: MIGRATION_SYNC_RETRY_CONCURRENCY_KEY },
      { limit: 10 },
    ],
    retries: 5,
    triggers: { event: "migration/mongo-sync-retry" },
  },
  async ({ event, step }) => {
    const data = event.data as SyncRetryEventData;
    return step.run("replay-mongo-write", () =>
      dispatchSyncRetry("mongo", data),
    );
  },
);
