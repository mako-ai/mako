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
import { inngest } from "../../client";
import { loggers } from "../../../logging";
import type { SyncRetryEventData } from "../../../migration/types";

const logger = loggers.inngest("migration-sync-retry");

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

async function dispatchSyncRetry(
  target: "pg" | "mongo",
  data: SyncRetryEventData,
): Promise<{
  status: "replayed" | "no_handler";
  domain: string;
  entityId: string;
}> {
  const handler = getSyncRetryHandler(target, data.domain);
  if (!handler) {
    logger.warn(
      "No sync-retry handler registered for domain; skipping replay",
      {
        target,
        domain: data.domain,
        operation: data.operation,
        entityId: data.entityId,
      },
    );
    return {
      status: "no_handler",
      domain: data.domain,
      entityId: data.entityId,
    };
  }

  await handler(data);
  logger.info("Replayed secondary dual-write", {
    target,
    domain: data.domain,
    operation: data.operation,
    entityId: data.entityId,
  });
  return { status: "replayed", domain: data.domain, entityId: data.entityId };
}

export const migrationPgSyncRetryFunction = inngest.createFunction(
  {
    id: "migration-pg-sync-retry",
    name: "Migration: retry secondary Postgres write",
    concurrency: { limit: 10 },
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
    concurrency: { limit: 10 },
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
