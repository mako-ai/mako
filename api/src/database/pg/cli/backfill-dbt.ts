/**
 * Dry-run plans all four collections. --apply fences the bridge, reconciles all
 * extant rows and retained logs, then commits the routing marker with parity.
 * --verify is read-only and returns nonzero on drift. See docs/runbooks/dbt-postgres-cutover.md.
 */
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BSON, MongoClient, type Db, type Document } from "mongodb";
import { loggers } from "../../../logging";
import { PgAuthRepository } from "../../../repositories/auth/pg.repo";
import {
  invalidMarkerToJson,
  jobValues,
  mongoEnvPreferenceToRecord,
  mongoJobToRecord,
  mongoProjectToRecord,
  mongoRunToRecordWithLogs,
  projectValues,
  runValues,
} from "../../../repositories/dbt/mapper";
import {
  activateDbtStore,
  precopyDbtStore,
  dbtUsesPostgres,
} from "../../../repositories/dbt/cutover";
import { reconcileDbtRow } from "./dbt-row-parity";
import {
  DBT_RUN_MAX_LOG_LINES,
  type DbtRunLogLine,
} from "../../../repositories/dbt/types";
import { closePgConnections, getPgDirectDb, type MakoPgDb } from "../client";
import { parseEntityId } from "../id-codec";
import {
  dbtEnvPreferences,
  dbtJobs,
  dbtProjects,
  dbtRuns,
  workspaces,
} from "../schema";

const log = loggers.migration();
const collections = {
  projects: "dbt_projects",
  preferences: "dbt_env_preferences",
  jobs: "dbt_jobs",
  runs: "dbt_runs",
} as const;
type Table = keyof typeof collections;
type Parent = Exclude<Table, "runs">;
type Issue = {
  reason: string;
  targetId?: string;
  fields?: string[];
  prefixLines?: number;
};
type Exception = {
  collection: string;
  sourceId: string;
  issues: Issue[];
  document: Document;
};
type Options = {
  apply: boolean;
  acceptedPreferenceIds?: ReadonlySet<string>;
  onException: (entry: Exception) => Promise<void>;
};
const uuid = (value: unknown) => parseEntityId(String(value))?.uuid;
const counters = () => ({ projects: 0, preferences: 0, jobs: 0, runs: 0 });

type KeyRow = {
  id: string;
  workspaceId: string;
  projectId?: string;
  userId?: string;
  name?: string;
  slug?: string | null;
};
function secondaryKey(row: KeyRow) {
  if (row.userId) return JSON.stringify([row.projectId, row.userId]);
  if (row.name !== undefined) {
    return JSON.stringify([row.workspaceId, row.name]);
  }
  if (row.slug != null) return JSON.stringify([row.projectId, row.slug]);
}
function keyIndex(rows: KeyRow[]) {
  const ids = new Map<string, KeyRow>();
  const unique = new Map<string, string>();
  function add(row: KeyRow) {
    const previous = ids.get(row.id);
    const oldKey = previous && secondaryKey(previous);
    if (oldKey !== undefined) unique.delete(oldKey);
    ids.set(row.id, row);
    const key = secondaryKey(row);
    if (key !== undefined) unique.set(key, row.id);
  }
  rows.forEach(add);
  return { ids, unique, add };
}

export async function backfillDbt(
  source: Db,
  target: MakoPgDb,
  cutoff: Date,
  options: Options,
) {
  const counts = counters();
  const inserted = counters();
  const wouldInsert = counters();
  const existing = counters();
  const skipped = counters();
  const acceptedPreferences: string[] = [];
  const reconciled = counters();
  const wouldUpdate = counters();
  const group = () => ({
    sourceRuns: 0,
    verifiedRuns: 0,
    sourceLines: 0,
    sourceLinesOutsideWindow: 0,
    verifiedLines: 0,
  });
  const history = { recentOrActive: group(), olderTerminal: group() };
  const reasons: Record<string, number> = {};
  const logs = { verifiedRuns: 0, verifiedLines: 0, mismatchedRuns: 0 };
  const unresolvedCreators = { projects: 0, jobs: 0 };
  const auth = new PgAuthRepository({ getDb: () => target });
  const ws = new Set(
    (await target.select({ id: workspaces.id }).from(workspaces)).map(
      row => row.id,
    ),
  );
  const readKeys = {
    projects: () =>
      target
        .select({
          id: dbtProjects.id,
          workspaceId: dbtProjects.workspaceId,
          name: dbtProjects.name,
        })
        .from(dbtProjects),
    preferences: () =>
      target
        .select({
          id: dbtEnvPreferences.id,
          workspaceId: dbtEnvPreferences.workspaceId,
          projectId: dbtEnvPreferences.projectId,
          userId: dbtEnvPreferences.userId,
        })
        .from(dbtEnvPreferences),
    jobs: () =>
      target
        .select({
          id: dbtJobs.id,
          workspaceId: dbtJobs.workspaceId,
          projectId: dbtJobs.projectId,
          slug: dbtJobs.slug,
        })
        .from(dbtJobs),
  };
  const keys = {
    projects: keyIndex(await readKeys.projects()),
    preferences: keyIndex(await readKeys.preferences()),
    jobs: keyIndex(await readKeys.jobs()),
  };
  const targetIds = {
    projects: new Set(keys.projects.ids.keys()),
    preferences: new Set(keys.preferences.ids.keys()),
    jobs: new Set(keys.jobs.ids.keys()),
    runs: new Set(
      (await target.select({ id: dbtRuns.id }).from(dbtRuns)).map(r => r.id),
    ),
  };
  async function report(table: Table, doc: Document, issues: Issue[]) {
    if (!issues.length) return;
    for (const { reason } of issues) {
      const key = table + "." + reason;
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
    if (
      table === "preferences" &&
      issues.every(i => i.reason === "missingUser") &&
      options.acceptedPreferenceIds?.has(String(doc._id))
    ) {
      acceptedPreferences.push(String(doc._id));
    }
    await options.onException({
      collection: collections[table],
      sourceId: String(doc._id),
      issues,
      document: doc,
    });
  }
  function parentIssues(doc: Document, needsProject: boolean) {
    const issues: Issue[] = [];
    const workspaceId = uuid(doc.workspaceId);
    if (!uuid(doc._id)) issues.push({ reason: "invalidId" });
    if (!workspaceId || !ws.has(workspaceId)) {
      issues.push({ reason: "missingWorkspace" });
    }
    if (needsProject) {
      const project = keys.projects.ids.get(uuid(doc.projectId) ?? "");
      if (!project) issues.push({ reason: "missingProject" });
      else if (project.workspaceId !== workspaceId) {
        issues.push({
          reason: "projectWorkspaceMismatch",
          targetId: project.id,
        });
      }
    }
    return issues;
  }
  // Keep the same projected parent keys during dry-run as apply would insert.
  // Never attach children to a replacement project or job with a different ID.
  async function copy(
    table: Table,
    doc: Document,
    values: Record<string, unknown>,
    issues: Issue[],
    lines?: DbtRunLogLine[],
  ) {
    const outcome = await reconcileDbtRow(
      target,
      table,
      values,
      options.apply,
      lines,
    );
    switch (outcome.status) {
      case "inserted":
        inserted[table]++;
        return true;
      case "existing":
        existing[table]++;
        return true;
      case "reconciled":
        reconciled[table]++;
        return true;
      case "wouldInsert":
        wouldInsert[table]++;
        return false;
      case "wouldUpdate":
        wouldUpdate[table]++;
        log.info("dbt source changed since import", {
          collection: collections[table],
          sourceId: String(doc._id),
          fields: outcome.differentFields,
        });
        return false;
      default:
        skipped[table]++;
        if (
          outcome.status === "targetChanged" &&
          outcome.differentFields.includes("retainedLogs")
        ) {
          logs.mismatchedRuns++;
        }
        issues.push({
          reason: outcome.status,
          targetId: String(values.id),
          fields:
            "differentFields" in outcome ? outcome.differentFields : undefined,
        });
        return false;
    }
  }
  async function copyParent(
    table: Parent,
    doc: Document,
    row: KeyRow,
    values: () => Record<string, unknown>,
    issues: Issue[],
  ) {
    targetIds[table].delete(row.id);
    const index = keys[table];
    const sameId = index.ids.get(row.id);
    const key = secondaryKey(row);
    const other = key === undefined ? undefined : index.unique.get(key);
    if (other && other !== row.id) {
      issues.push({ reason: "secondaryKeyCollision", targetId: other });
    }
    if (
      sameId &&
      (sameId.workspaceId !== row.workspaceId ||
        sameId.projectId !== row.projectId ||
        sameId.userId !== row.userId)
    ) {
      issues.push({ reason: "idScopeMismatch", targetId: sameId.id });
    }
    if (issues.length) skipped[table]++;
    else {
      await copy(table, doc, values(), issues);
      if (!issues.length) index.add(row);
    }
    await report(table, doc, issues);
  }
  for await (const doc of source
    .collection(collections.projects)
    .find()
    .sort({ _id: 1 })) {
    counts.projects++;
    const p = mongoProjectToRecord(doc);
    const creator = await auth.resolveUserUuid(p.createdBy);
    if (!creator && p.createdBy) unresolvedCreators.projects++;
    const row = {
      id: uuid(doc._id) ?? "",
      workspaceId: uuid(doc.workspaceId) ?? "",
      name: p.name.trim(),
    };
    await copyParent(
      "projects",
      doc,
      row,
      () => ({
        ...projectValues(p, creator),
        lastProdManifestCommittedAt: p.lastProdManifestCommittedAt,
        lastProdManifestKey: p.lastProdManifestKey,
        lastProdManifestSha: p.lastProdManifestSha,
        environmentsInvalid: invalidMarkerToJson(p.environmentsInvalid),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }),
      parentIssues(doc, false),
    );
  }
  for await (const doc of source
    .collection(collections.preferences)
    .find()
    .sort({ _id: 1 })) {
    counts.preferences++;
    const p = mongoEnvPreferenceToRecord(doc);
    const userId = await auth.resolveUserUuid(p.userId);
    const issues = parentIssues(doc, true);
    if (!userId) issues.push({ reason: "missingUser" });
    const row = {
      id: uuid(doc._id) ?? "",
      workspaceId: uuid(doc.workspaceId) ?? "",
      projectId: uuid(doc.projectId) ?? "",
      userId: userId ?? "",
    };
    await copyParent(
      "preferences",
      doc,
      row,
      () => ({
        ...row,
        environment: p.environment,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }),
      issues,
    );
  }
  for await (const doc of source
    .collection(collections.jobs)
    .find()
    .sort({ _id: 1 })) {
    counts.jobs++;
    const j = mongoJobToRecord(doc);
    const { nextAt, lastAt, ...stats } = j.scheduledRun;
    const creator = await auth.resolveUserUuid(j.createdBy);
    if (!creator && j.createdBy) unresolvedCreators.jobs++;
    const row = {
      id: uuid(doc._id) ?? "",
      workspaceId: uuid(doc.workspaceId) ?? "",
      projectId: uuid(doc.projectId) ?? "",
      slug: j.slug,
    };
    await copyParent(
      "jobs",
      doc,
      row,
      () => ({
        ...jobValues(j, creator),
        scheduledRunNextAt: nextAt,
        scheduledRun: { ...stats, lastAt: lastAt?.toISOString() },
        lane: j.lane,
        laneMedianMs: j.laneMedianMs,
        laneEvaluatedAt: j.laneEvaluatedAt,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
      }),
      parentIssues(doc, true),
    );
  }
  function runReferences(doc: Document) {
    const issues = parentIssues(doc, true);
    const blocked = issues.length > 0;
    const job =
      doc.jobId == null ? undefined : keys.jobs.ids.get(uuid(doc.jobId) ?? "");
    const detached =
      doc.jobId != null &&
      (!job ||
        job.workspaceId !== uuid(doc.workspaceId) ||
        job.projectId !== uuid(doc.projectId));
    if (detached) {
      issues.push({ reason: job ? "jobScopeMismatch" : "missingJob" });
    }
    return { issues, blocked, detached };
  }
  for await (const doc of source
    .collection(collections.runs)
    .find()
    .batchSize(8)) {
    counts.runs++;
    const r = mongoRunToRecordWithLogs(doc);
    const older =
      r.status !== "running" &&
      r.status !== "queued" &&
      (r.completedAt ?? r.createdAt) < cutoff;
    const cohort = older ? history.olderTerminal : history.recentOrActive;
    const size = Math.min(r.logs.length, DBT_RUN_MAX_LOG_LINES);
    cohort.sourceRuns++;
    cohort.sourceLines += size;
    const { issues, blocked, detached } = runReferences(doc);
    const prefixLines = r.logs.length - size;
    if (prefixLines > 0) {
      cohort.sourceLinesOutsideWindow += prefixLines;
      issues.push({ reason: "logPrefixOutsideRetainedWindow", prefixLines });
    }
    targetIds.runs.delete(uuid(doc._id) ?? "");
    if (blocked) skipped.runs++;
    else {
      const values = {
        ...runValues({ ...r, jobId: detached ? undefined : r.jobId }),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
      if (await copy("runs", doc, values, issues, r.logs)) {
        cohort.verifiedRuns++;
        cohort.verifiedLines += size;
        logs.verifiedRuns++;
        logs.verifiedLines += size;
      }
    }
    await report("runs", doc, issues);
  }
  const targetOnly = Object.fromEntries(
    Object.entries(targetIds).map(([name, ids]) => [name, Array.from(ids)]),
  );
  return {
    counts,
    inserted,
    wouldInsert,
    existing,
    skipped,
    acceptedPreferences,
    history,
    reconciled,
    wouldUpdate,
    targetOnly,
    reasons,
    unresolvedCreators,
    logs,
  };
}

export function dbtParityComplete(
  result: Awaited<ReturnType<typeof backfillDbt>>,
) {
  return (
    Object.values(result.targetOnly).every(ids => ids.length === 0) &&
    Object.entries(result.counts).every(([key, n]) => {
      const t = key as Table;
      return (
        n ===
        result.existing[t] +
          result.inserted[t] +
          result.reconciled[t] +
          (t === "preferences" ? result.acceptedPreferences.length : 0)
      );
    }) &&
    result.logs.verifiedRuns === result.counts.runs &&
    Object.values(result.history).every(
      cohort =>
        cohort.sourceRuns === cohort.verifiedRuns &&
        cohort.sourceLines === cohort.verifiedLines,
    )
  );
}

async function verifyServingWriters() {
  // Separate production services share the same Mongo database. Use the release
  // verifier from this checkout, and retain its sanitized revision inventory.
  const script = path.resolve(
    __dirname,
    "../../../../../scripts/check-control-plane-revisions.mjs",
  );
  const { stdout } = await promisify(execFile)(process.execPath, [
    script,
    "--dbt",
  ]).catch(error => {
    // The verifier reports resource names and retirement evidence, never env values.
    log.error("dbt writer retirement verification failed", {
      reason: String(error.stderr).trim(),
    });
    throw new Error("Unverified production dbt writer");
  });
  const evidence = JSON.parse(stdout);
  if (
    evidence.marker !== "MAKO_DBT_FENCE_V1" ||
    evidence.services?.length !== 2
  ) {
    throw new Error(
      "Missing dbt capability or production targets in revision evidence",
    );
  }
  log.info("Verified Cloud Run dbt writers", evidence);
  return JSON.stringify(evidence.services);
}

async function main() {
  const input = process.argv.slice(2);
  const args = input.filter(arg => !arg.startsWith("--accept-preference="));
  const acceptedPreferenceIds = new Set(
    input
      .filter(arg => arg.startsWith("--accept-preference="))
      .map(arg => arg.slice("--accept-preference=".length)),
  );
  if (
    args.length > 1 ||
    args.some(arg => !["--apply", "--verify", "--precopy"].includes(arg)) ||
    [...acceptedPreferenceIds].some(id => !parseEntityId(id))
  ) {
    throw new Error(
      "Usage: backfill-dbt.ts [--precopy|--verify|--apply] [--accept-preference=source-id]",
    );
  }
  dotenv.config({
    path: [
      path.resolve(__dirname, "../../../../../.env"),
      path.resolve(__dirname, "../../../../.env"),
    ],
    quiet: true,
  });
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const source = new MongoClient(process.env.DATABASE_URL, {
    readPreference: "primary",
    readConcern: { level: "majority" },
  });
  const apply = args.includes("--apply");
  const precopy = args.includes("--precopy");
  const archivePath = path.resolve(
    `dbt-backfill-exceptions-${Date.now()}-${process.pid}.jsonl`,
  );
  let archive: FileHandle | undefined;
  const cutoff = new Date(Date.now() - 30 * 86400000);
  try {
    const scan = (db: MakoPgDb, write: boolean) =>
      backfillDbt(source.db(), db, cutoff, {
        apply: write,
        acceptedPreferenceIds,
        async onException({ collection, sourceId, issues, document }) {
          if (write) {
            // Keep the original BSON types for offline recovery. Never log payloads.
            archive ??= await open(archivePath, "wx", 0o600);
            const original = await source
              .db()
              .collection(collection)
              .findOne(
                { _id: document._id },
                { promoteValues: false, promoteLongs: false, bsonRegExp: true },
              );
            if (!original) {
              throw new Error("Source changed during dbt backfill");
            }
            await archive.writeFile(
              BSON.EJSON.stringify(
                { collection, sourceId, issues, document: original },
                { relaxed: false },
              ) + "\n",
            );
          }
          log.warn("dbt backfill exception", { collection, sourceId, issues });
        },
      });
    const db = getPgDirectDb();
    let switched = false;
    // Verify both production services before changing even the Mongo fence.
    const services =
      apply && !(await dbtUsesPostgres(db))
        ? await verifyServingWriters()
        : null;
    const result =
      services !== null
        ? await activateDbtStore(db, source.db(), async tx => {
            const audited = await scan(tx, true);
            await archive?.sync();
            if (!dbtParityComplete(audited)) {
              log.error("dbt activation rolled back; parity incomplete", {
                ...audited,
                archive: archive ? archivePath : undefined,
              });
              throw new Error("dbt parity incomplete");
            }
            if ((await verifyServingWriters()) !== services) {
              throw new Error(
                "Production revisions changed during the dbt scan",
              );
            }
            switched = true;
            return audited;
          })
        : precopy
          ? await precopyDbtStore(db, tx => scan(tx, true))
          : await scan(db, false);
    const parity = dbtParityComplete(result);
    if ((apply || args.includes("--verify")) && !parity) process.exitCode = 1;
    log.info("dbt backfill complete", {
      switched,
      precopy,
      parity,
      apply,
      cutoff,
      ...result,
      archive: archive ? archivePath : undefined,
    });
  } finally {
    await archive?.close();
    await source.close();
    await closePgConnections();
  }
}
if (require.main === module) {
  main().catch(() => {
    // Driver exceptions can include credentials, SQL parameters or log payloads.
    log.error(
      "dbt backfill failed; check database access, recovery file and target constraints",
    );
    process.exitCode = 1;
  });
}
