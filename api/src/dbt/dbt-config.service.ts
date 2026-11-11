/**
 * dbt orchestration config in the workspace repo (apps.md §23).
 *
 * Files are authoritative for job DEFINITIONS (`dbt/jobs/<slug>.yml`) and
 * project environments/settings (`dbt/environments.yml`); the Mongo rows
 * are the derived index the scheduler scans, carrying the runtime fields
 * (scheduledRun claims, failure counters, lastRun stats) that never enter
 * git. Every in-product mutation writes through here (a commit on main —
 * jobs build main, so orchestration config is main-scoped, branch-policy
 * rule 2), and the push-reaction reconciles external edits, re-registering
 * schedules the way a push to apps/ deploys.
 */
import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { Types } from "mongoose";
import {
  DbtJob,
  DbtProject,
  type IDbtJob,
  type IDbtProject,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { authorForUser } from "../apps/workspace-consoles.service";
import {
  boundRepoDirIfExists,
  requireWorkspaceRepo,
} from "../apps/workspace-repo-required";
import { getWorkspaceRepo } from "../services/workspace-repos.service";
import { unsafeSlugReason } from "@mako/schemas";
import {
  ensureLocalRepo,
  freshenBeforeMainWrite,
  freshenForServe,
  queueMirrorPush,
} from "../apps/cloud-repo.service";
import {
  BlobPreconditionError,
  DEFAULT_BRANCH,
  repoDirFor,
  blobOid,
  commitBlobsOnBranch,
  listTree,
  readBlobsBatch,
  readBlob,
  repoExists,
  resolveCommit,
  type GitAuthor,
} from "../apps/repository.service";
import {
  DBT_ENVIRONMENTS_PATH,
  type DbtEnvironmentsFile,
  jobFilePath,
  jobRenameTarget,
  parseEnvironmentsFile,
  parseJobFile,
  serializeEnvironmentsFile,
  serializeJobFile,
  slugFromJobFilePath,
  slugifyJobName,
  type DbtJobFile,
} from "./dbt-config-files";
import { parseDbtCommands } from "./commands";
import { applyJobScheduleChange } from "./dbt-run.service";
import {
  SlugFileConflictError,
  currentFileOf,
  deleteSlugFile,
} from "../rename/slug-file-rename";
import {
  DBT_JOB_FILES,
  freeDerivedId,
  mergedAliases,
  retireObjectId,
  settleRenames,
  type SlugRow,
} from "../rename/slug-files";
import { publishRealtimeEvent } from "../services/realtime.service";

const logger = loggers.api("dbt-config");
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

export interface JobDefinitionAtMain {
  path: string;
  slug: string;
  oid: string;
  parsed: DbtJobFile | null;
}

export interface LiveJob {
  def: JobDefinitionAtMain;
  row: IDbtJob | null;
  id: Types.ObjectId;
}

export function derivedJobId(
  workspaceId: string,
  slug: string,
  /** Above 1 only when the first id is another job's, or a deleted one's. */
  generation = 1,
): Types.ObjectId {
  const digest = createHash("sha1")
    .update(
      `dbt-job:${workspaceId}:${slug}${generation > 1 ? `#${generation}` : ""}`,
    )
    .digest("hex");
  return new Types.ObjectId(digest.slice(0, 24));
}

/** The id of a job file that has no row (see `freeDerivedId`). */
function jobIdForFile(
  workspaceId: string,
  slug: string,
  rows: ReadonlyArray<{ _id: Types.ObjectId; slug?: string }>,
): Promise<Types.ObjectId> {
  return freeDerivedId(
    "dbt_job",
    workspaceId,
    slug,
    generation => derivedJobId(workspaceId, slug, generation),
    rows,
  );
}

/** Drop a job's row; its id is never given to another job file. */
export async function removeDbtJobRow(
  job: Pick<IDbtJob, "_id" | "workspaceId">,
): Promise<void> {
  await DbtJob.deleteOne({ _id: job._id });
  await retireObjectId(job.workspaceId, "dbt_job", job._id);
}

/** Authored job files at main; unbound workspaces deliberately read empty. */
export async function listJobDefinitionsAtMain(
  workspaceId: string,
): Promise<JobDefinitionAtMain[]> {
  if (!(await getWorkspaceRepo(workspaceId))) return [];
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return [];
  // A job file another instance committed is invisible to a clone that has
  // not fetched it: listing it, then "Job not found" on run, by instance.
  await freshenForServe(workspaceId);
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) return [];
  // EVERY job file, read by one git process: the push sync reads them all,
  // so the cap of 1,000 that was here listed some jobs and answered "Job
  // not found" for the rest.
  const paths = (await listTree(repoDir, head))
    .map(entry => entry.path)
    .filter(path => slugFromJobFilePath(path) !== null)
    .sort();
  const blobs = await readBlobsBatch(repoDir, head, paths);
  return paths.map(path => {
    const slug = slugFromJobFilePath(path) as string;
    const blob = blobs.get(path);
    if (!blob) {
      logger.warn("Unreadable dbt job file at main", { workspaceId, path });
      return { path, slug, oid: "unreadable", parsed: null };
    }
    return {
      path,
      slug,
      oid: blobOid(blob),
      // A NUL byte: not a text file, so not a job definition.
      parsed: blob.includes(0) ? null : parseJobFile(blob.toString("utf8")),
    };
  });
}

const JOB_NAME_MAX_LENGTH = 128;

/**
 * A schedule the scheduler can actually register. `cron-parser` rejects a
 * bad expression at parse time but only trips over an unknown timezone when
 * computing the next date, so both steps run here — the same two steps
 * `applyJobScheduleChange` performs when it registers the schedule.
 */
export function jobScheduleFailure(
  schedule: DbtJobFile["schedule"],
): string | null {
  if (!schedule) return null;
  try {
    CronExpressionParser.parse(schedule.cron, {
      currentDate: new Date(),
      tz: schedule.timezone,
    })
      .next()
      .toDate();
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `invalid schedule: ${message}`;
  }
}

/**
 * Why the reactor would refuse to apply an otherwise well-formed file. One
 * definition of "applies" shared by GET/list and push-sync: a file that is
 * refused here is flagged in the list AND skipped by the sync, so a bad cron
 * or timezone can neither look valid nor abort the reconciliation of every
 * other job (apps.md §23 fail-safe).
 */
export function jobApplyFailure(
  project: IDbtProject,
  file: DbtJobFile,
): string | null {
  if (file.name.length > JOB_NAME_MAX_LENGTH) {
    return `name longer than ${JOB_NAME_MAX_LENGTH} characters`;
  }
  try {
    parseDbtCommands(file.commands);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (!project.environments.some(env => env.name === file.environment)) {
    return `unknown environment: ${file.environment}`;
  }
  return jobScheduleFailure(file.schedule);
}

/**
 * Mongoose materialises an unset nested path as `{}` on a hydrated doc, so
 * the marker's presence is its `reason`, never the object's truthiness.
 */
function isMarkedInvalid(row: IDbtJob): boolean {
  return typeof row.definitionInvalid?.reason === "string";
}

async function markJobInvalid(
  row: IDbtJob,
  reason: string,
  path: string,
): Promise<void> {
  // Idempotent: a list call must not rewrite the marker on every read.
  if (
    row.definitionInvalid?.reason === reason &&
    row.definitionInvalid?.path === path
  ) {
    return;
  }
  const definitionInvalid = { reason, at: new Date(), path };
  try {
    await DbtJob.updateOne({ _id: row._id }, { $set: { definitionInvalid } });
    row.definitionInvalid = definitionInvalid;
  } catch (error) {
    logger.warn("Failed to mark dbt job invalid", {
      jobId: row._id.toString(),
      error,
    });
  }
}

function scheduleDiffers(row: IDbtJob, file: DbtJobFile): boolean {
  return (
    row.enabled !== file.enabled ||
    (row.schedule?.cron ?? null) !== (file.schedule?.cron ?? null) ||
    (row.schedule?.timezone ?? null) !== (file.schedule?.timezone ?? null)
  );
}

/**
 * SHA-resync an existing scheduler row against its file at main. Never
 * creates or deletes rows. It DOES re-register the schedule when the file
 * changed it: the resync stamps `sourceBlobSha`, after which push-sync sees
 * the row as level and skips it — so a cron edited in git and then viewed in
 * the list before the push webhook landed would otherwise keep firing on the
 * old cron (or never fire, for a schedule added to a manual job).
 */
export async function ensureJobDerivedCache(
  project: IDbtProject,
  def: JobDefinitionAtMain,
  row: IDbtJob,
): Promise<void> {
  if (!def.parsed) {
    await markJobInvalid(row, "unparseable job file", def.path);
    return;
  }
  const failure = jobApplyFailure(project, def.parsed);
  if (failure) {
    await markJobInvalid(row, failure, def.path);
    return;
  }
  if (row.sourceBlobSha === def.oid && !isMarkedInvalid(row)) return;
  const file = def.parsed;
  const reschedule = scheduleDiffers(row, file);
  const unset: Record<string, 1> = { definitionInvalid: 1 };
  if (!file.schedule) unset.schedule = 1;
  // The file's old names, then what only the row knows (a pushed `git mv`).
  const aliases = mergedAliases(file.aliases, row.aliases, row.slug);
  await DbtJob.updateOne(
    { _id: row._id },
    {
      $set: {
        name: file.name,
        ...(aliases.length > 0 ? { aliases } : {}),
        environment: file.environment,
        commands: file.commands,
        ...(file.schedule ? { schedule: file.schedule } : {}),
        enabled: file.enabled,
        deferToProduction: file.deferToProduction,
        sourceBlobSha: def.oid,
      },
      $unset: unset,
    },
  );
  Object.assign(row, {
    name: file.name,
    ...(aliases.length > 0 ? { aliases } : {}),
    environment: file.environment,
    commands: file.commands,
    schedule: file.schedule ?? undefined,
    enabled: file.enabled,
    deferToProduction: file.deferToProduction,
    sourceBlobSha: def.oid,
    definitionInvalid: undefined,
  });
  if (reschedule) await applyJobScheduleChange(row);
}

async function joinLiveJobs(
  project: IDbtProject,
  defs: JobDefinitionAtMain[],
  rows: IDbtJob[],
  /** Rows renamed ahead of this tree, by the old slug it still shows. */
  ahead: ReadonlyMap<string, SlugRow>,
): Promise<LiveJob[]> {
  const workspaceId = project.workspaceId.toString();
  const bySlug = new Map(rows.map(row => [row.slug, row]));
  const live: LiveJob[] = [];
  for (const def of defs) {
    const aheadId = ahead.get(def.slug)?._id;
    const row =
      bySlug.get(def.slug) ??
      (aheadId && rows.find(candidate => candidate._id.equals(aheadId))) ??
      null;
    live.push({
      def,
      row,
      id: row?._id ?? (await jobIdForFile(workspaceId, def.slug, rows)),
    });
  }
  return live;
}

/**
 * Re-key the job rows whose file moved (api/src/rename/slug-files.ts)
 * before rows are matched to files by slug. Costs nothing unless a row's
 * own file is missing from the tree.
 */
async function settleJobRenames(
  project: IDbtProject,
  files: Array<JobDefinitionAtMain & { contents?: string }>,
  rows: IDbtJob[],
  mode: "sync" | "read",
  at?: string,
): Promise<Awaited<ReturnType<typeof settleRenames>>> {
  const none = { renamed: [], ahead: new Map<string, SlugRow>() };
  const workspaceId = project.workspaceId.toString();
  // Only a row without its file AND a file without a row can be a move.
  const slugs = new Set(files.map(file => file.slug));
  const owned = new Set(rows.map(row => row.slug));
  if (
    !rows.some(row => row.slug && !slugs.has(row.slug)) ||
    !files.some(file => !owned.has(file.slug))
  ) {
    return none;
  }
  const repoDir = await boundRepoDirIfExists(workspaceId);
  const head = at ?? (repoDir && (await resolveCommit(repoDir, MAIN)));
  if (!repoDir || !head) return none;
  const settled = await settleRenames(DBT_JOB_FILES, {
    workspaceId,
    repoDir,
    head,
    mode,
    rows,
    files: files.map(file => ({
      slug: file.slug,
      oid: file.oid,
      contents: file.contents,
      aliases: file.parsed?.aliases ?? [],
      target: file.parsed ? jobRenameTarget(file.parsed) : null,
    })),
  });
  if (settled.renamed.length > 0) {
    publishRealtimeEvent(workspaceId, {
      type: "dbt.job.updated",
      projectId: project._id.toString(),
    });
  }
  return settled;
}

export async function loadLiveJobs(project: IDbtProject): Promise<LiveJob[]> {
  const workspaceId = project.workspaceId.toString();
  if ((await boundRepoDirIfExists(workspaceId)) == null) return [];
  // A job "applies" against the environments the FILE declares, not the
  // last pushed row — otherwise a job added together with its environment
  // in one commit reads as invalid until the webhook lands.
  try {
    await ensureEnvironmentsDerivedCache(project);
  } catch (error) {
    logger.warn("ensureEnvironmentsDerivedCache failed", {
      workspaceId,
      error,
    });
  }
  const defs = await listJobDefinitionsAtMain(workspaceId);
  let rows = await DbtJob.find({ projectId: project._id });
  const settled = await settleJobRenames(project, defs, rows, "read");
  if (settled.renamed.length > 0) {
    rows = await DbtJob.find({ projectId: project._id });
  }
  const bySlug = new Map(rows.map(row => [row.slug, row]));
  for (const def of defs) {
    const row = bySlug.get(def.slug);
    if (!row) continue;
    try {
      await ensureJobDerivedCache(project, def, row);
    } catch (error) {
      logger.warn("ensureJobDerivedCache failed", {
        workspaceId,
        path: def.path,
        error,
      });
    }
  }
  return joinLiveJobs(project, defs, rows, settled.ahead);
}

export async function loadLiveJobById(
  project: IDbtProject,
  jobId: string,
): Promise<LiveJob | null> {
  if (!Types.ObjectId.isValid(jobId)) return null;
  const live = await loadLiveJobs(project);
  return live.find(job => job.id.toString() === jobId) ?? null;
}

export type LiveJobRowResolution =
  | { ok: true; live: LiveJob; row: IDbtJob }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Resolve a job id for a mutation or a run: the file must be live at main
 * AND the scheduler row must exist. A file that only lives in git (the push
 * has not been reconciled yet) is a 409 with the reason, not a bare 404 —
 * the list just showed the job. A row whose file was deleted is not live
 * and resolves to nothing, so it can no longer be triggered.
 */
export async function resolveLiveJobRow(
  project: IDbtProject,
  jobId: string,
): Promise<LiveJobRowResolution> {
  const live = await loadLiveJobById(project, jobId);
  if (!live) return { ok: false, status: 404, error: "Job not found" };
  if (!live.row) {
    // A file the sync refuses never gets a row, so "once the push is
    // synced" would be a promise that never comes true. Say what is wrong.
    const failure = live.def.parsed
      ? jobApplyFailure(project, live.def.parsed)
      : "unparseable job file";
    if (failure) {
      return {
        ok: false,
        status: 409,
        error: `Job "${live.def.slug}" is not registered because ${live.def.path} is invalid: ${failure}. Fix the file on main; it registers on the next push.`,
      };
    }
    return {
      ok: false,
      status: 409,
      error: `Job "${live.def.slug}" exists only in git so far (${live.def.path}); it becomes runnable and editable once the push is synced.`,
    };
  }
  return { ok: true, live, row: live.row };
}

function rowAsPlain(row: IDbtJob): Record<string, unknown> {
  return typeof row.toObject === "function"
    ? (row.toObject() as Record<string, unknown>)
    : { ...(row as unknown as Record<string, unknown>) };
}

export function liveJobToPlain(
  live: LiveJob,
  project: IDbtProject,
): Record<string, unknown> {
  const base = live.row
    ? rowAsPlain(live.row)
    : {
        _id: live.id,
        workspaceId: project.workspaceId,
        projectId: project._id,
        slug: live.def.slug,
        createdBy: "git",
        // A git-only file that does not apply has no last-good row to fall
        // back on. Keep the response shape whole (clients map over
        // `commands`) and unrunnable rather than half-defined.
        name: live.def.slug,
        environment: "",
        commands: [],
        schedule: null,
        enabled: false,
        deferToProduction: false,
      };
  base._id = live.id;
  base.slug = live.def.slug;
  base.sourceBlobSha = live.def.oid;
  const file = live.def.parsed;
  const failure = file
    ? jobApplyFailure(project, file)
    : "unparseable job file";
  if (!file || failure) {
    base.definitionInvalid =
      live.row && isMarkedInvalid(live.row)
        ? live.row.definitionInvalid
        : {
            reason: failure ?? "invalid job file",
            at: new Date(),
            path: live.def.path,
          };
    return base;
  }
  Object.assign(base, {
    name: file.name,
    environment: file.environment,
    commands: file.commands,
    schedule: file.schedule ?? undefined,
    enabled: file.enabled,
    deferToProduction: file.deferToProduction,
  });
  delete base.definitionInvalid;
  return base;
}

function jobToFile(job: IDbtJob): DbtJobFile {
  return {
    name: job.name,
    // The row's old names ride along: a save writes the whole file.
    ...(job.aliases?.length ? { aliases: [...job.aliases] } : {}),
    environment: job.environment,
    commands: [...job.commands],
    schedule: job.schedule?.cron
      ? { cron: job.schedule.cron, timezone: job.schedule.timezone || "UTC" }
      : null,
    enabled: job.enabled !== false,
    deferToProduction: !!job.deferToProduction,
  };
}

function environmentsToFile(project: IDbtProject) {
  return {
    dbtVersion: project.dbtVersion,
    defaultEnvironment: project.defaultEnvironment,
    prodEnvironment: project.prodEnvironment,
    environments: project.environments.map(env => ({
      name: env.name,
      connectionId: env.connectionId.toString(),
      targetSchema: env.targetSchema,
      threads: env.threads,
      vars: env.vars as Record<string, unknown> | undefined,
      ownerUserId: env.ownerUserId,
    })),
  };
}

function isEnvironmentsMarkedInvalid(project: IDbtProject): boolean {
  return typeof project.environmentsInvalid?.reason === "string";
}

async function markEnvironmentsInvalid(
  project: IDbtProject,
  reason: string,
): Promise<void> {
  if (project.environmentsInvalid?.reason === reason) return;
  const environmentsInvalid = { reason, at: new Date() };
  await DbtProject.updateOne(
    { _id: project._id },
    { $set: { environmentsInvalid } },
  );
  project.environmentsInvalid = environmentsInvalid;
}

/** Project settings follow `dbt/environments.yml`; same mapping for read and push. */
async function applyEnvironmentsFile(
  project: IDbtProject,
  parsed: DbtEnvironmentsFile,
): Promise<void> {
  project.environments = parsed.environments.map(env => ({
    name: env.name,
    connectionId: new Types.ObjectId(env.connectionId),
    targetSchema: env.targetSchema,
    threads: env.threads ?? 4,
    vars: env.vars,
    ownerUserId: env.ownerUserId,
  })) as IDbtProject["environments"];
  project.defaultEnvironment = parsed.defaultEnvironment;
  project.prodEnvironment = parsed.prodEnvironment;
  if (parsed.dbtVersion) project.dbtVersion = parsed.dbtVersion;
  const clearInvalid = isEnvironmentsMarkedInvalid(project);
  if (project.isModified()) await project.save();
  if (clearInvalid) {
    // Assigning undefined to a nested path persists `{}`; unset it.
    await DbtProject.updateOne(
      { _id: project._id },
      { $unset: { environmentsInvalid: 1 } },
    );
    project.environmentsInvalid = undefined;
  }
}

/**
 * `dbt/environments.yml` at main is the read surface for a project's
 * environments (apps.md §23), the way `dbt/jobs/*.yml` is for jobs. The
 * project row is resynced in place when the file differs — a project GET
 * after an external edit shows the file, not the last push. No file at main
 * (workspace not adopted) leaves the row alone; an unbound workspace too.
 */
export async function ensureEnvironmentsDerivedCache(
  project: IDbtProject,
): Promise<void> {
  const workspaceId = project.workspaceId.toString();
  if (!(await getWorkspaceRepo(workspaceId))) return;
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null || !(await resolveCommit(repoDir, MAIN))) return;
  let contents: string | null;
  try {
    const blob = await readBlob(repoDir, MAIN, DBT_ENVIRONMENTS_PATH);
    contents = blob.isBinary ? null : blob.contents;
  } catch {
    return; // not adopted yet
  }
  const parsed = contents == null ? null : parseEnvironmentsFile(contents);
  if (!parsed) {
    await markEnvironmentsInvalid(project, "unparseable environments.yml");
    return;
  }
  const level =
    serializeEnvironmentsFile(environmentsToFile(project)) ===
    serializeEnvironmentsFile(parsed);
  if (level && !isEnvironmentsMarkedInvalid(project)) return;
  await applyEnvironmentsFile(project, parsed);
}

/**
 * The workspace repo, at a tip that agrees with the mirror.
 *
 * Every path in this module — the write, the push-triggered sync, the
 * adoption migration — reaches the repo through here, so the freshen belongs
 * here and nowhere else. `ensureLocalRepo` returns early once the directory
 * exists and never refreshes it, so on a long-lived Cloud Run instance
 * "the repo is present" says nothing about whether it is current.
 *
 * A stale tip is not merely stale on these paths, it is WRONG, and on one of
 * them it is destructive: `syncDbtConfigNow` deletes every job row whose file
 * is absent from the tree it read, so reading an old tip deletes the rows for
 * jobs added since — and deregisters their schedules with them. `adoptDbtConfig`
 * fails the other way: it computes "which files already exist" from the tree
 * and writes the rest, so an old tip makes it overwrite a newer job file with
 * Mongo's version. Freshening at COMMIT time cannot fix that second one — the
 * payload was already decided from a stale read — which is why this moved up
 * here from commitConfig rather than being added alongside it (#916).
 *
 * Cheap where it sits: the three callers are a write, a push reaction that is
 * already detached and coalesced by `syncInFlight`, and a rare migration.
 * None is a per-request hot path, so this is not the reflexive freshen that a
 * read path should refuse.
 */
async function repoDirIfExists(workspaceId: string): Promise<string | null> {
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return null;
  await freshenBeforeMainWrite(workspaceId);
  return repoDir;
}

async function commitConfig(
  workspaceId: string,
  mutation: { writes?: Record<string, string>; deletes?: string[] },
  message: string,
  author?: GitAuthor,
  /** What the commit expects at main, decided after the freshen. */
  expect?: (repoDir: string) => Promise<Record<string, string | null>>,
): Promise<boolean> {
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  const result = await commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, mutation, {
    message,
    author,
    expectBlobs: expect ? await expect(repoDir) : undefined,
  });
  if (!result.unchanged) queueMirrorPush(workspaceId);
  return true;
}

/** Reserve a unique slug for a new job and stamp it on the row fields. */
export async function reserveJobSlug(
  projectId: Types.ObjectId,
  name: string,
): Promise<string> {
  const base = slugifyJobName(name);
  let slug = base;
  for (let i = 2; i < 100; i++) {
    // Never a name a Windows checkout cannot create, or one that reads as
    // an id (ids resolve before names).
    const taken =
      unsafeSlugReason(slug) !== null ||
      (await DbtJob.exists({ projectId, slug }));
    if (!taken) return slug;
    slug = `${base}-${i}`;
  }
  throw new Error(`Could not find a free slug for job "${name}"`);
}

/** Write-through: the job's file mirrors the row's definition fields. */
export async function commitDbtJobFile(
  project: Pick<IDbtProject, "workspaceId">,
  job: IDbtJob,
  actorUserId?: string,
  messageOverride?: string,
): Promise<void> {
  if (!job.slug) return; // pre-adoption row; the migration stamps slugs
  const contents = serializeJobFile(jobToFile(job));
  const sha = blobOid(contents);
  const workspaceId = project.workspaceId.toString();
  const slug = job.slug;
  let written: boolean;
  try {
    written = await commitConfig(
      workspaceId,
      { writes: { [jobFilePath(slug)]: contents } },
      messageOverride ?? `dbt: job "${job.name}" (${slug})`,
      actorUserId ? await authorForUser(actorUserId) : undefined,
      // An existing job's file is replaced only where it still is: the row
      // in this request's hand may predate a rename, and writing its old
      // path would bring back the file the rename moved.
      job.isNew
        ? undefined
        : async repoDir => {
            const at = await currentFileOf(DBT_JOB_FILES, {
              workspaceId,
              scope: { projectId: job.projectId },
              repoDir,
              id: job._id,
              slug,
            });
            if (at.slug !== slug) {
              throw new SlugFileConflictError(
                `This job was renamed (its file is now ${at.path}) while it was being edited. Nothing was saved: reload the job and make the change again.`,
              );
            }
            return { [at.path]: at.oid };
          },
    );
  } catch (error) {
    if (!(error instanceof BlobPreconditionError)) throw error;
    throw new SlugFileConflictError(
      `${error.path} changed while the job was being saved (a rename or another edit landed first). Nothing was saved: reload the job and make the change again.`,
    );
  }
  // Stamp AFTER the file exists. Stamping first meant a failed commit left
  // the row claiming a sha for a file that was never written, and the
  // push-sync short-circuits on a matching sha. For a not-yet-persisted
  // document (`new DbtJob`), the caller saves after this returns.
  if (written && job.sourceBlobSha !== sha) {
    job.sourceBlobSha = sha;
    if (!job.isNew) {
      await DbtJob.updateOne(
        { _id: job._id },
        { $set: { sourceBlobSha: sha } },
      );
    }
  }
}

/**
 * Remove a deleted job's file: the one its row has NOW (a rename may have
 * moved it since the request read the row). `SlugFileConflictError` (409)
 * when a rename or an edit lands in between.
 */
export async function deleteDbtJobFile(
  project: Pick<IDbtProject, "workspaceId">,
  job: Pick<IDbtJob, "_id" | "projectId" | "slug">,
  actorUserId?: string,
): Promise<void> {
  if (!job.slug) return;
  await deleteSlugFile(DBT_JOB_FILES, {
    workspaceId: project.workspaceId.toString(),
    scope: { projectId: job.projectId },
    id: job._id,
    slug: job.slug,
    message: slug => `dbt: delete job ${slug}`,
    actorUserId,
  });
}

export async function commitDbtEnvironmentsFile(
  project: IDbtProject,
  actorUserId?: string,
): Promise<void> {
  await commitConfig(
    project.workspaceId.toString(),
    {
      writes: {
        [DBT_ENVIRONMENTS_PATH]: serializeEnvironmentsFile(
          environmentsToFile(project),
        ),
      },
    },
    "dbt: update environments",
    actorUserId ? await authorForUser(actorUserId) : undefined,
  );
}

/**
 * Reconcile the Mongo index from `dbt/jobs/*.yml` + `dbt/environments.yml`
 * at main. Runs on every push (notifyRepoPushed). Definition fields follow
 * the files; runtime fields (scheduledRun, failure counters) are preserved;
 * schedules are re-registered when they changed. Invalid files are logged
 * and skipped — a broken YAML must not take a production job down.
 */
const syncInFlight = new Map<string, Promise<void>>();

export async function syncDbtConfigFromRepo(
  workspaceId: string,
  actorUserId?: string,
): Promise<void> {
  const running = syncInFlight.get(workspaceId);
  if (running) return running;
  const run = syncDbtConfigNow(workspaceId, actorUserId).finally(() => {
    syncInFlight.delete(workspaceId);
  });
  syncInFlight.set(workspaceId, run);
  return run;
}

async function syncDbtConfigNow(
  workspaceId: string,
  _actorUserId?: string,
): Promise<void> {
  const repoDir = await repoDirIfExists(workspaceId);
  if (repoDir == null) return;
  const project = await DbtProject.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!project) return;
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) return;
  const entries = await listTree(repoDir, head);
  const jobPaths = entries
    .map(e => e.path)
    .filter(p => slugFromJobFilePath(p) !== null);
  // No dbt config in the repo at all → not adopted; leave Mongo alone.
  const hasEnvFile = entries.some(e => e.path === DBT_ENVIRONMENTS_PATH);
  if (jobPaths.length === 0 && !hasEnvFile) return;

  // ---- environments.yml → project settings ----
  if (hasEnvFile) {
    try {
      const blob = await readBlob(repoDir, head, DBT_ENVIRONMENTS_PATH);
      const parsed = blob.isBinary
        ? null
        : parseEnvironmentsFile(blob.contents);
      if (!parsed) {
        logger.warn(
          "dbt environments.yml is invalid; not overwriting from Mongo",
          { workspaceId },
        );
        await markEnvironmentsInvalid(project, "unparseable environments.yml");
      } else {
        await applyEnvironmentsFile(project, parsed);
      }
    } catch (error) {
      logger.warn("dbt environments sync failed", { workspaceId, error });
    }
  }

  // ---- jobs/*.yml → job rows ----
  const blobs = await readBlobsBatch(repoDir, head, jobPaths);
  // A file that MOVED is a rename: its row is re-keyed in place here, before
  // the loop reads the new slug as a new job and the old one as removed
  // (a new id: the URL, the run history and the scheduler claim orphaned).
  const settled = await settleJobRenames(
    project,
    [...blobs].flatMap(([path, buf]) => {
      const slug = slugFromJobFilePath(path);
      const contents = buf.toString("utf8");
      const parsed = parseJobFile(contents);
      return slug
        ? [{ path, slug, oid: blobOid(contents), contents, parsed }]
        : [];
    }),
    await DbtJob.find({ projectId: project._id, slug: { $exists: true } }),
    "sync",
    head,
  );
  const holders: Array<{ _id: Types.ObjectId; slug?: string }> =
    await DbtJob.find({ projectId: project._id }).select("_id slug").lean();
  const seenSlugs = new Set<string>();
  for (const [path, buf] of blobs) {
    const slug = slugFromJobFilePath(path);
    if (!slug) continue;
    seenSlugs.add(slug);
    // This tree is older than a rename of this job (see `settleRenames`):
    // the file is the job's own, as it was. Nothing is created from it.
    if (settled.ahead.has(slug)) continue;
    const contents = buf.toString("utf8");
    const sha = blobOid(contents);
    const row = await DbtJob.findOne({ projectId: project._id, slug });
    // Level already — unless the row is still flagged from an earlier bad
    // version and the file was reverted to this exact content, in which
    // case the marker must clear.
    if (row && row.sourceBlobSha === sha && !isMarkedInvalid(row)) continue;
    const parsed = parseJobFile(contents);
    if (!parsed) {
      logger.warn("dbt job file is invalid; not overwriting from Mongo", {
        workspaceId,
        path,
      });
      if (row) {
        row.definitionInvalid = {
          reason: "unparseable job file",
          at: new Date(),
          path,
        };
        row.enabled = false;
        await row.save();
      }
      continue;
    }
    // Allowlist, environment, schedule — never index a job we refuse to run,
    // and never let one bad file throw out of the loop (a cron the scheduler
    // cannot parse used to abort the sync for every file after it).
    const failure = jobApplyFailure(project, parsed);
    if (failure) {
      logger.warn("dbt job file does not apply; skipped", {
        workspaceId,
        path,
        reason: failure,
      });
      if (row) await markJobInvalid(row, failure, path);
      continue;
    }
    const scheduleChanged = !row || scheduleDiffers(row, parsed);
    const doc =
      row ??
      new DbtJob({
        // The id GET/list already handed out for this git-only file: a tab
        // opened before the push landed keeps resolving after it.
        _id: await jobIdForFile(workspaceId, slug, holders),
        workspaceId: project.workspaceId,
        projectId: project._id,
        slug,
        createdBy: "sync",
      });
    doc.name = parsed.name;
    const aliases = mergedAliases(parsed.aliases, doc.aliases, slug);
    if (aliases.length > 0 || doc.aliases?.length) {
      doc.aliases = aliases.length > 0 ? aliases : undefined;
    }
    doc.environment = parsed.environment;
    doc.commands = parsed.commands;
    doc.schedule = parsed.schedule
      ? { cron: parsed.schedule.cron, timezone: parsed.schedule.timezone }
      : undefined;
    doc.enabled = parsed.enabled;
    doc.deferToProduction = parsed.deferToProduction;
    doc.sourceBlobSha = sha;
    const clearInvalid = isMarkedInvalid(doc);
    await doc.save();
    if (clearInvalid) {
      // Assigning undefined to a nested path persists `{}`; unset it.
      await DbtJob.updateOne(
        { _id: doc._id },
        { $unset: { definitionInvalid: 1 } },
      );
    }
    if (scheduleChanged) await applyJobScheduleChange(doc);
    if (!row) holders.push({ _id: doc._id, slug });
    logger.info("dbt job synced from repo", { workspaceId, slug });
  }

  // A job file removed on main removes the job (runs keep their history).
  const stale = await DbtJob.find({
    projectId: project._id,
    slug: { $exists: true, $nin: [...seenSlugs] },
  }).select("slug name workspaceId");
  const renamedAhead = new Set(
    [...settled.ahead.values()].map(row => String(row._id)),
  );
  for (const doc of stale) {
    // Renamed by a commit this tree does not hold yet: not a removal.
    if (renamedAhead.has(String(doc._id))) continue;
    await removeDbtJobRow(doc);
    logger.info("dbt job removed (file deleted on main)", {
      workspaceId,
      slug: doc.slug,
    });
  }
}

/**
 * Adoption (migration path): write files for every job + the environments
 * of a repo-holding workspace, stamping slugs. Only missing files are
 * written, in ONE commit. Re-runnable.
 */
export async function adoptDbtConfig(workspaceId: string): Promise<{
  jobs: number;
  written: number;
}> {
  const repoDir = await repoDirIfExists(workspaceId);
  if (repoDir == null) return { jobs: 0, written: 0 };
  const project = await DbtProject.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!project) return { jobs: 0, written: 0 };
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  const existing = new Set(
    head ? (await listTree(repoDir, head)).map(e => e.path) : [],
  );

  const writes: Record<string, string> = {};
  const jobs = await DbtJob.find({ projectId: project._id });
  for (const job of jobs) {
    if (!job.slug) {
      job.slug = await reserveJobSlug(project._id, job.name);
    }
    const path = jobFilePath(job.slug);
    const contents = serializeJobFile(jobToFile(job));
    job.sourceBlobSha = blobOid(contents);
    await job.save();
    if (!existing.has(path)) writes[path] = contents;
  }
  if (!existing.has(DBT_ENVIRONMENTS_PATH)) {
    writes[DBT_ENVIRONMENTS_PATH] = serializeEnvironmentsFile(
      environmentsToFile(project),
    );
  }
  if (Object.keys(writes).length > 0) {
    await commitConfig(
      workspaceId,
      { writes },
      `dbt: adopt orchestration config into git (${jobs.length} jobs + environments)`,
    );
  }
  return { jobs: jobs.length, written: Object.keys(writes).length };
}
