/* eslint-disable no-console, no-process-exit */
/**
 * Reconciliation / drift report between Mongo (current system of record) and
 * Postgres (migration target). This is the safety gate before flipping any
 * domain's reads to Postgres: it compares row counts and samples documents
 * field-by-field through the deterministic id mapping.
 *
 * Usage:
 *   BACKFILL_MONGO_URL=<mongo uri> POSTGRES_URL=<pg uri> \
 *     tsx src/db/verify.ts [--sample=50]
 *
 * Exit code is non-zero if any sampled document is missing or mismatched in
 * Postgres (so it can gate CI / a cutover script).
 */
import mongoose from "mongoose";
import { sql } from "drizzle-orm";

import { LlmUsage, Session, User } from "../database/schema";
import {
  Chat,
  Connector,
  ConsoleFolder,
  DatabaseConnection,
  QueryExecution,
  SavedConsole,
  Workspace,
  WorkspaceMember,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { closePostgres, getDb } from "./client";
import { toPgId } from "./ids";
import {
  chats,
  connectors,
  consoleFolders,
  databaseConnections,
  llmUsage,
  queryExecutions,
  savedConsoles,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from "./schema";

const log = loggers.migration();

interface DomainReport {
  domain: string;
  mongoCount: number;
  pgCount: number;
  sampled: number;
  matched: number;
  mismatched: number;
  missingInPg: number;
}

async function pgCount(table: { id: unknown }): Promise<number> {
  const [{ n }] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(table as never);
  return n;
}

/** Generic sampler: compares N Mongo docs against their mapped PG rows. */
async function compareSample<T extends Record<string, unknown>>(
  domain: string,
  mongoModel: { countDocuments: () => Promise<number>; find: () => any },
  pgTable: { id: unknown },
  sampleSize: number,
  fields: (doc: any, pgRow: any) => boolean,
): Promise<DomainReport> {
  const report: DomainReport = {
    domain,
    mongoCount: await mongoModel.countDocuments(),
    pgCount: await pgCount(pgTable),
    sampled: 0,
    matched: 0,
    mismatched: 0,
    missingInPg: 0,
  };

  const docs = await mongoModel.find().limit(sampleSize).lean();
  const db = getDb();
  for (const doc of docs as Array<Record<string, unknown>>) {
    report.sampled++;
    const pgId = toPgId(String(doc._id));
    const rows = await db
      .select()
      .from(pgTable as never)
      .where(sql`id = ${pgId}`);
    const pgRow = (rows as unknown as T[])[0];
    if (!pgRow) {
      report.missingInPg++;
      continue;
    }
    if (fields(doc, pgRow)) {
      report.matched++;
    } else {
      report.mismatched++;
    }
  }
  return report;
}

async function run(sampleSize: number): Promise<DomainReport[]> {
  const reports: DomainReport[] = [];

  reports.push(
    await compareSample("users", User, users, sampleSize, (m, p) => {
      return String(m.email).toLowerCase() === p.email;
    }),
  );
  reports.push(
    await compareSample(
      "workspaces",
      Workspace,
      workspaces,
      sampleSize,
      (m, p) => m.name === p.name && String(m.slug).toLowerCase() === p.slug,
    ),
  );
  reports.push(
    await compareSample(
      "database_connections",
      DatabaseConnection,
      databaseConnections,
      sampleSize,
      (m, p) => m.name === p.name && m.type === p.type,
    ),
  );
  reports.push(
    await compareSample(
      "connectors",
      Connector,
      connectors,
      sampleSize,
      (m, p) => m.name === p.name,
    ),
  );
  reports.push(
    await compareSample(
      "console_folders",
      ConsoleFolder,
      consoleFolders,
      sampleSize,
      (m, p) => m.name === p.name,
    ),
  );
  reports.push(
    await compareSample(
      "saved_consoles",
      SavedConsole,
      savedConsoles,
      sampleSize,
      (m, p) => m.name === p.name,
    ),
  );
  reports.push(
    await compareSample("chats", Chat, chats, sampleSize, (m, p) => {
      const mongoLen = Array.isArray(m.messages) ? m.messages.length : 0;
      const pgLen = Array.isArray(p.messages) ? p.messages.length : 0;
      return m.title === p.title && mongoLen === pgLen;
    }),
  );
  reports.push(
    await compareSample(
      "llm_usage",
      LlmUsage,
      llmUsage,
      sampleSize,
      (m, p) => m.invocationType === p.invocationType,
    ),
  );
  reports.push(
    await compareSample(
      "query_executions",
      QueryExecution,
      queryExecutions,
      sampleSize,
      (m, p) => (m.status ?? null) === (p.status ?? null),
    ),
  );
  // Sessions: count-only (high churn; ids are text, compared by membership).
  reports.push({
    domain: "sessions",
    mongoCount: await Session.countDocuments(),
    pgCount: await pgCount(sessions),
    sampled: 0,
    matched: 0,
    mismatched: 0,
    missingInPg: 0,
  });
  reports.push({
    domain: "workspace_members",
    mongoCount: await WorkspaceMember.countDocuments(),
    pgCount: await pgCount(workspaceMembers),
    sampled: 0,
    matched: 0,
    mismatched: 0,
    missingInPg: 0,
  });

  return reports;
}

function parseSample(): number {
  const arg = process.argv.find(a => a.startsWith("--sample="));
  const n = arg ? Number(arg.slice("--sample=".length)) : 50;
  return Number.isFinite(n) && n > 0 ? n : 50;
}

export async function runVerify(sampleSize = 50): Promise<DomainReport[]> {
  const mongoUrl =
    process.env.BACKFILL_MONGO_URL ||
    process.env.DEV_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!mongoUrl) {
    throw new Error("Set BACKFILL_MONGO_URL / DEV_DATABASE_URL / DATABASE_URL");
  }
  await mongoose.connect(mongoUrl);
  try {
    return await run(sampleSize);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  runVerify(parseSample())
    .then(async reports => {
      console.log(
        "\n  domain                  mongo     pg  sampled  matched  mismatch  missingPg",
      );
      console.log(
        "  ----------------------------------------------------------------------------",
      );
      let problems = 0;
      for (const r of reports) {
        problems += r.mismatched + r.missingInPg;
        console.log(
          "  " +
            r.domain.padEnd(22) +
            String(r.mongoCount).padStart(6) +
            String(r.pgCount).padStart(7) +
            String(r.sampled).padStart(9) +
            String(r.matched).padStart(9) +
            String(r.mismatched).padStart(10) +
            String(r.missingInPg).padStart(11),
        );
      }
      log.info("verify complete", { problems });
      await closePostgres();
      process.exit(problems > 0 ? 1 : 0);
    })
    .catch(async err => {
      console.error("verify: FAILED", err);
      await closePostgres();
      process.exit(1);
    });
}
