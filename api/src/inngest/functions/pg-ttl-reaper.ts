/**
 * Scheduled Postgres TTL reaper (replaces MongoDB's non-CDC TTL indexes).
 *
 * Runs hourly with concurrency 1; skips cleanly when `POSTGRES_URL` is unset.
 */
import { inngest } from "../client";
import { hasPostgresConfig } from "../../database/pg/client";
import {
  listTtlRules,
  reapAllRegisteredTablesOrThrow,
  registerDefaultPgTtlRules,
} from "../../database/pg/ttl-reaper";

export const pgTtlReaperFunction = inngest.createFunction(
  {
    id: "migration-pg-ttl-reaper",
    name: "Postgres: reap expired TTL rows",
    concurrency: { limit: 1 },
    retries: 1,
    triggers: { cron: "0 * * * *" },
  },
  async ({ step }) => {
    if (!hasPostgresConfig()) {
      return { skipped: "POSTGRES_URL not configured" };
    }
    registerDefaultPgTtlRules();
    if (listTtlRules().length === 0) {
      return { skipped: "no TTL rules registered" };
    }
    return step.run("reap-expired-rows", () =>
      reapAllRegisteredTablesOrThrow(),
    );
  },
);
