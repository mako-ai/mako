/**
 * Scheduled Postgres TTL reaper (replaces MongoDB's 16 non-CDC TTL indexes).
 *
 * Runs hourly with concurrency 1; skips cleanly when `POSTGRES_URL` is unset or
 * no tables have been registered yet (Phase 0).
 */
import { inngest } from "../../client";
import { hasPostgresConfig } from "../../../database/pg/client";
import {
  listTtlRules,
  reapAllRegisteredTables,
} from "../../../migration/ttl-reaper";

export const migrationPgTtlReaperFunction = inngest.createFunction(
  {
    id: "migration-pg-ttl-reaper",
    name: "Migration: reap expired Postgres TTL rows",
    concurrency: { limit: 1 },
    retries: 1,
    triggers: { cron: "0 * * * *" },
  },
  async ({ step }) => {
    if (!hasPostgresConfig()) {
      return { skipped: "POSTGRES_URL not configured" };
    }
    if (listTtlRules().length === 0) {
      return { skipped: "no TTL rules registered" };
    }
    return step.run("reap-expired-rows", () => reapAllRegisteredTables());
  },
);
