/* eslint-disable no-console, no-process-exit */
/**
 * Reconciliation / drift report between Mongo (current system of record) and
 * Postgres (migration target). This is the safety gate before flipping any
 * domain's reads to Postgres — and the go/no-go gate in the big-bang cutover
 * (freeze -> backfill --prune -> verify -> flip).
 *
 * Usage:
 *   BACKFILL_MONGO_URL=<mongo uri> POSTGRES_URL=<pg uri> \
 *     tsx src/db/verify.ts [--sample=50]
 *
 * The gate FAILS (non-zero exit) when:
 *   - any sampled document is missing or mismatched in Postgres, or
 *   - a domain's total Mongo/Postgres row counts diverge (catches drift that
 *     sampling alone would miss — deletes, missed inserts).
 *
 * Samples are drawn RANDOMLY (`$sample`) so repeated runs cover different
 * documents; the previous first-N sampling was biased toward the oldest rows.
 */
import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import mongoose from "mongoose";
import { sql } from "drizzle-orm";

// Root .env for local runs; explicit env vars take precedence (dotenv does
// not override existing values).
const envPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

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

/**
 * A count divergence is drift even when every sampled doc matches. Sessions
 * are exempt (report-only): they are ephemeral and by design live only in the
 * flag-selected store once `AUTH_PERSISTENCE=postgres` is on.
 */
function countMismatch(r: DomainReport): number {
  if (r.domain === "sessions") return 0;
  return Math.abs(r.mongoCount - r.pgCount);
}

async function pgCount(table: { id: unknown }): Promise<number> {
  const [{ n }] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(table as never);
  return n;
}

/** Compare a workspace-scoped doc's tenant mapping (catches id-mapping bugs). */
function workspaceMatches(m: Record<string, unknown>, p: any): boolean {
  if (m.workspaceId == null) return true;
  return toPgId(String(m.workspaceId)) === String(p.workspaceId);
}

/** Generic sampler: compares N RANDOM Mongo docs against their mapped PG rows. */
async function compareSample<T extends Record<string, unknown>>(
  domain: string,
  mongoModel: {
    countDocuments: () => Promise<number>;
    aggregate: (pipeline: any[]) => { exec: () => Promise<unknown[]> };
  },
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

  const docs = await mongoModel
    .aggregate([{ $sample: { size: sampleSize } }])
    .exec();
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
    if (fields(doc, pgRow) && workspaceMatches(doc, pgRow)) {
      report.matched++;
    } else {
      report.mismatched++;
      log.warn("verify mismatch", { domain, mongoId: String(doc._id) });
    }
  }
  return report;
}

function sameInstant(m: unknown, p: unknown): boolean {
  if (m == null || p == null) return true;
  const mt = new Date(m as string).getTime();
  const pt = new Date(p as string).getTime();
  if (Number.isNaN(mt) || Number.isNaN(pt)) return true;
  return Math.abs(mt - pt) < 1000;
}

async function run(sampleSize: number): Promise<DomainReport[]> {
  const reports: DomainReport[] = [];

  reports.push(
    await compareSample("users", User, users, sampleSize, (m, p) => {
      return (
        String(m.email).toLowerCase() === p.email &&
        (m.hashedPassword ?? null) === (p.hashedPassword ?? null) &&
        (m.emailVerified ?? false) === p.emailVerified
      );
    }),
  );
  reports.push(
    await compareSample(
      "workspaces",
      Workspace,
      workspaces,
      sampleSize,
      (m, p) =>
        m.name === p.name &&
        String(m.slug).toLowerCase() === p.slug &&
        toPgId(String(m.createdBy)) === String(p.createdBy),
    ),
  );
  reports.push(
    await compareSample(
      "database_connections",
      DatabaseConnection,
      databaseConnections,
      sampleSize,
      (m, p) =>
        m.name === p.name &&
        m.type === p.type &&
        (m.isDemo ?? false) === p.isDemo,
    ),
  );
  reports.push(
    await compareSample(
      "connectors",
      Connector,
      connectors,
      sampleSize,
      (m, p) => m.name === p.name && m.type === p.type,
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
      (m, p) => m.name === p.name && (m.code ?? null) === (p.code ?? null),
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
      (m, p) =>
        m.invocationType === p.invocationType &&
        (m.modelId ?? null) === (p.modelId ?? null) &&
        (m.totalTokens ?? null) === (p.totalTokens ?? null),
    ),
  );
  reports.push(
    await compareSample(
      "query_executions",
      QueryExecution,
      queryExecutions,
      sampleSize,
      (m, p) =>
        (m.status ?? null) === (p.status ?? null) &&
        (m.executionTimeMs ?? null) === (p.durationMs ?? null) &&
        sameInstant(m.executedAt, p.executedAt),
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
  reports.push(
    await compareSample(
      "workspace_members",
      WorkspaceMember,
      workspaceMembers,
      sampleSize,
      (m, p) =>
        toPgId(String(m.userId)) === String(p.userId) && m.role === p.role,
    ),
  );

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
        problems += r.mismatched + r.missingInPg + countMismatch(r);
        console.log(
          "  " +
            r.domain.padEnd(22) +
            String(r.mongoCount).padStart(6) +
            String(r.pgCount).padStart(7) +
            String(r.sampled).padStart(9) +
            String(r.matched).padStart(9) +
            String(r.mismatched).padStart(10) +
            String(r.missingInPg).padStart(11) +
            (countMismatch(r) > 0 ? "   << COUNT DRIFT" : ""),
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
