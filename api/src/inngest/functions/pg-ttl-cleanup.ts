import { lte } from "drizzle-orm";

import { getDb } from "../../db/client";
import { queriesRepository, sessionsRepository } from "../../db/repositories";
import { desktopAuthCodes, emailVerifications } from "../../db/schema";
import { loggers } from "../../logging";
import { inngest } from "../client";

const log = loggers.inngest();

/** Mongo's `query_executions` TTL was 90 days; mirror it in Postgres. */
const QUERY_EXECUTION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function postgresBacksAnyDomain(): boolean {
  return (
    process.env.AUTH_PERSISTENCE === "postgres" ||
    process.env.CONNECTIONS_PERSISTENCE === "postgres"
  );
}

/**
 * Postgres has no TTL indexes; this cron replaces the Mongo
 * `expireAfterSeconds` indexes for the migrated tables:
 *
 *   - sessions            (expiresAt, delete at expiry)
 *   - email_verifications (expiresAt, delete at expiry)
 *   - desktop_auth_codes  (expiresAt, delete at expiry)
 *   - query_executions    (executedAt, 90 days)
 *
 * Expired workspace invites are intentionally kept: the Mongo TTL deleted
 * them, but the invite-acceptance path already rejects expired tokens and the
 * rows are useful audit data. Revisit if the table grows.
 *
 * No-op unless a Postgres persistence flag is enabled, so environments that
 * haven't started the migration never open a PG pool.
 */
export const pgTtlCleanupFunction = inngest.createFunction(
  {
    id: "pg-ttl-cleanup",
    name: "Postgres TTL Cleanup (migrated Mongo TTL indexes)",
    retries: 2,
    concurrency: { limit: 1 },
  },
  { cron: "*/30 * * * *" },
  async ({ step }) => {
    if (!postgresBacksAnyDomain()) {
      return { skipped: true, reason: "postgres persistence not enabled" };
    }

    const now = new Date();

    const expiredSessions = await step.run("delete-expired-sessions", () =>
      sessionsRepository.deleteExpired(now),
    );

    const expiredVerifications = await step.run(
      "delete-expired-email-verifications",
      async () => {
        const rows = await getDb()
          .delete(emailVerifications)
          .where(lte(emailVerifications.expiresAt, now))
          .returning({ id: emailVerifications.id });
        return rows.length;
      },
    );

    const expiredDesktopCodes = await step.run(
      "delete-expired-desktop-auth-codes",
      async () => {
        const rows = await getDb()
          .delete(desktopAuthCodes)
          .where(lte(desktopAuthCodes.expiresAt, now))
          .returning({ id: desktopAuthCodes.id });
        return rows.length;
      },
    );

    const prunedExecutions = await step.run("prune-old-query-executions", () =>
      queriesRepository.deleteOlderThan(
        new Date(now.getTime() - QUERY_EXECUTION_RETENTION_MS),
      ),
    );

    const summary = {
      expiredSessions,
      expiredVerifications,
      expiredDesktopCodes,
      prunedExecutions,
    };
    log.info("pg-ttl-cleanup complete", summary);
    return summary;
  },
);
