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
import {
  ensureLocalRepo,
  freshenBeforeMainWrite,
  queueMirrorPush,
} from "../apps/cloud-repo.service";
import {
  BlobPreconditionError,
  DEFAULT_BRANCH,
  repoDirFor,
  blobOid,
  commitBlobsOnBranch,
  globTree,
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
  currentTreeCheck,
  detectGitRenames,
  isAncestorCommit,
  mergedAliases,
  pairRenamedSlugs,
  readBlobByOid,
  type RemovedSlug,
  type SlugRenamePair,
} from "../rename/flow-dbt-job-pairing";

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
  /** >1 only when generation 1 is held by a renamed row; see freeDerivedJobId. */
  generation = 1,
): Types.ObjectId {
  const digest = createHash("sha1")
    .update(
      `dbt-job:${workspaceId}:${slug}${generation > 1 ? `#${generation}` : ""}`,
    )
    .digest("hex");
  return new Types.ObjectId(digest.slice(0, 24));
}

/**
 * The stable id for a job file with no row: the first derivation not held
 * by a row of a different slug (a git-born job that was renamed keeps its
 * id, so a new file at its old name must not collide). Deterministic over
 * the same rows, so GET/list and push-sync agree.
 */
export function freeDerivedJobId(
  workspaceId: string,
  slug: string,
  rows: Array<{ _id: Types.ObjectId; slug?: string }>,
): Types.ObjectId {
  for (let generation = 1; generation <= 32; generation++) {
    const id = derivedJobId(workspaceId, slug, generation);
    const holder = rows.find(row => row._id.equals(id));
    if (!holder || holder.slug === slug) return id;
  }
  return new Types.ObjectId();
}

/**
 * An alias two rows claim resolves to neither: a file whose `aliases:` names
 * something another row already answers to (by slug or alias — a copied
 * file, typically) loses that entry. Returns the dropped names for the log.
 */
async function dropJobAliasesClaimedElsewhere(
  projectId: Types.ObjectId,
  jobId: Types.ObjectId,
  aliases: string[],
): Promise<{ kept: string[]; dropped: string[] }> {
  if (aliases.length === 0) return { kept: [], dropped: [] };
  const claimants = await DbtJob.find({
    projectId,
    _id: { $ne: jobId },
    $or: [{ slug: { $in: aliases } }, { aliases: { $in: aliases } }],
  })
    .select("slug aliases")
    .lean();
  const claimed = new Set<string>();
  for (const claimant of claimants) {
    for (const name of [claimant.slug, ...(claimant.aliases ?? [])]) {
      if (name && aliases.includes(name)) claimed.add(name);
    }
  }
  return {
    kept: aliases.filter(alias => !claimed.has(alias)),
    dropped: [...claimed],
  };
}

/** See `RENAME_GUARD_MS` in flow-sync.service.ts — the same window for jobs. */
export const JOB_RENAME_GUARD_MS = 10 * 60 * 1000;

/**
 * Whether the row's last rename is recorded, recent and not in `head`'s
 * history — the one case the tree must not be believed about this row
 * (see `renameGuardActive` in flow-sync.service.ts). No recorded commit,
 * no guard.
 */
async function jobRenameGuardActive(
  repoDir: string,
  head: string,
  row: Pick<IDbtJob, "lastRenameCommit" | "lastRenameAt">,
): Promise<boolean> {
  if (!row.lastRenameCommit || !row.lastRenameAt) return false;
  if (Date.now() - row.lastRenameAt.getTime() > JOB_RENAME_GUARD_MS) {
    return false;
  }
  return !(await isAncestorCommit(repoDir, row.lastRenameCommit, head));
}

/**
 * Retire rename guards the tree caught up with and resolve the ones it
 * never will — the job twin of `settleRenameGuards` in flow-sync.service.ts:
 * landed (in history, or the current file is in the tree under another
 * commit) → cleared; expired with the file still under an old name → the
 * row is re-keyed back to that name, loudly; expired otherwise → cleared.
 */
async function settleJobRenameGuards(args: {
  workspaceId: string;
  projectId: Types.ObjectId;
  repoDir: string;
  head: string;
  fileSlugs: ReadonlySet<string>;
  /** See `currentTreeCheck`: only the mirror's main may retire a guard. */
  treeIsCurrent: () => Promise<boolean>;
}): Promise<void> {
  const { workspaceId, projectId, repoDir, head, fileSlugs, treeIsCurrent } =
    args;
  const guarded = await DbtJob.find({
    projectId,
    lastRenameCommit: { $exists: true },
  });
  if (guarded.length === 0) return;
  // Only a tree every instance agrees on may retire a guard (see
  // flow-sync.service.ts): the renaming instance's local main has the
  // commit before the mirror does, and the dbt sync does not even freshen.
  if (!(await treeIsCurrent())) {
    logger.info(
      "Tree not verified as the mirror's main; keeping job rename guards",
      { workspaceId, head, guarded: guarded.map(row => row.slug) },
    );
    return;
  }
  for (const row of guarded) {
    const clear = () =>
      DbtJob.updateOne(
        { _id: row._id },
        { $unset: { lastRenameCommit: 1, lastRenameAt: 1 } },
      );
    const commit = row.lastRenameCommit as string;
    if (await isAncestorCommit(repoDir, commit, head)) {
      await clear();
      continue;
    }
    if (row.slug && fileSlugs.has(row.slug)) {
      await clear();
      continue;
    }
    const age = row.lastRenameAt
      ? Date.now() - row.lastRenameAt.getTime()
      : Infinity;
    if (age <= JOB_RENAME_GUARD_MS) continue;
    const oldSlug = (row.aliases ?? []).find(alias => fileSlugs.has(alias));
    if (row.slug && oldSlug) {
      logger.error(
        "dbt job rename commit never reached main; re-keying the row back to the file the tree has",
        {
          workspaceId,
          jobId: row._id.toString(),
          renamedTo: row.slug,
          revertedTo: oldSlug,
          lastRenameCommit: commit,
        },
      );
      await rekeyJobSlug(row._id, row.slug, oldSlug, undefined, {
        recordOldAsAlias: false,
      });
    } else {
      logger.warn(
        "dbt job rename commit never reached main; trusting the tree",
        { workspaceId, jobId: row._id.toString(), slug: row.slug },
      );
    }
    await clear();
  }
}

/** Authored job files at main; unbound workspaces deliberately read empty. */
export async function listJobDefinitionsAtMain(
  workspaceId: string,
): Promise<JobDefinitionAtMain[]> {
  if (!(await getWorkspaceRepo(workspaceId))) return [];
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null || !(await resolveCommit(repoDir, MAIN))) return [];
  const paths = await globTree(repoDir, MAIN, "dbt/jobs/*.yml", 1000);
  const definitions: JobDefinitionAtMain[] = [];
  for (const path of paths.sort()) {
    const slug = slugFromJobFilePath(path);
    if (!slug) continue;
    try {
      const blob = await readBlob(repoDir, MAIN, path);
      definitions.push({
        path,
        slug,
        // Git's id from the raw bytes: a file that is not valid UTF-8 hashes
        // differently once decoded, and a row storing that sha could never
        // pass the write-through's compare-and-swap again.
        oid: blob.oid,
        parsed: blob.isBinary ? null : parseJobFile(blob.contents),
      });
    } catch (error) {
      logger.warn("Unreadable dbt job file at main", {
        workspaceId,
        path,
        error,
      });
      definitions.push({ path, slug, oid: "unreadable", parsed: null });
    }
  }
  return definitions;
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

/**
 * Thrown by `commitDbtJobFile` when the job's file (or its slug) changed in
 * the repo since the row was loaded — a rename or another edit landed
 * first. The routes answer 409 (reload and retry); never an upstream error.
 */
export class DbtConfigConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "DbtConfigConflictError";
  }
}

async function markJobInvalid(
  row: IDbtJob,
  reason: string,
  path: string,
  /**
   * The blob found invalid, recorded as `lastSeenBlobSha` so a UI save may
   * overwrite exactly this version (the recovery for a broken laptop push).
   * Two broken versions with the same reason are two blobs: the marker is
   * "unchanged" only when the blob is too.
   */
  blobSha?: string,
): Promise<void> {
  // Idempotent: a list call must not rewrite the marker on every read.
  if (
    row.definitionInvalid?.reason === reason &&
    row.definitionInvalid?.path === path &&
    (blobSha === undefined || row.lastSeenBlobSha === blobSha)
  ) {
    return;
  }
  const definitionInvalid = { reason, at: new Date(), path };
  try {
    await DbtJob.updateOne(
      { _id: row._id },
      {
        $set: {
          definitionInvalid,
          ...(blobSha !== undefined ? { lastSeenBlobSha: blobSha } : {}),
        },
      },
    );
    row.definitionInvalid = definitionInvalid;
    if (blobSha !== undefined) row.lastSeenBlobSha = blobSha;
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
    await markJobInvalid(row, "unparseable job file", def.path, def.oid);
    return;
  }
  const failure = jobApplyFailure(project, def.parsed);
  if (failure) {
    await markJobInvalid(row, failure, def.path, def.oid);
    return;
  }
  if (row.sourceBlobSha === def.oid && !isMarkedInvalid(row)) return;
  const file = def.parsed;
  const reschedule = scheduleDiffers(row, file);
  const unset: Record<string, 1> = { definitionInvalid: 1 };
  if (!file.schedule) unset.schedule = 1;
  const { kept: aliases } = await dropJobAliasesClaimedElsewhere(
    row.projectId,
    row._id,
    mergedAliases(row.aliases, file.aliases, row.slug),
  );
  await DbtJob.updateOne(
    { _id: row._id },
    {
      $set: {
        name: file.name,
        environment: file.environment,
        commands: file.commands,
        ...(file.schedule ? { schedule: file.schedule } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
        enabled: file.enabled,
        deferToProduction: file.deferToProduction,
        sourceBlobSha: def.oid,
        lastSeenBlobSha: def.oid,
      },
      $unset: unset,
    },
  );
  Object.assign(row, {
    name: file.name,
    environment: file.environment,
    commands: file.commands,
    schedule: file.schedule ?? undefined,
    ...(aliases.length > 0 ? { aliases } : {}),
    enabled: file.enabled,
    deferToProduction: file.deferToProduction,
    sourceBlobSha: def.oid,
    lastSeenBlobSha: def.oid,
    definitionInvalid: undefined,
  });
  if (reschedule) await applyJobScheduleChange(row);
}

function joinLiveJobs(
  project: IDbtProject,
  defs: JobDefinitionAtMain[],
  rows: IDbtJob[],
): LiveJob[] {
  const bySlug = new Map(rows.map(row => [row.slug, row]));
  return defs.map(def => ({
    def,
    row: bySlug.get(def.slug) ?? null,
    id:
      bySlug.get(def.slug)?._id ??
      freeDerivedJobId(project.workspaceId.toString(), def.slug, rows),
  }));
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
  const rows = await DbtJob.find({ projectId: project._id });
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
  return joinLiveJobs(project, defs, rows);
}

export async function loadLiveJobById(
  project: IDbtProject,
  jobId: string,
): Promise<LiveJob | null> {
  if (!Types.ObjectId.isValid(jobId)) return null;
  const live = await loadLiveJobs(project);
  const workspaceId = project.workspaceId.toString();
  return (
    live.find(job => job.id.toString() === jobId) ??
    // A tab opened on a git-only file before its push was synced holds
    // `derivedJobId(slug)`; when that push was a rename the slug now belongs
    // to a row that kept its OLD id, but the derived id still names the file.
    live.find(
      job =>
        job.row !== null &&
        derivedJobId(workspaceId, job.def.slug).toString() === jobId,
    ) ??
    null
  );
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
        aliases: live.def.parsed?.aliases,
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
  const aliases = mergedAliases(live.row?.aliases, file.aliases, live.def.slug);
  Object.assign(base, {
    name: file.name,
    environment: file.environment,
    commands: file.commands,
    schedule: file.schedule ?? undefined,
    ...(aliases.length > 0 ? { aliases } : {}),
    enabled: file.enabled,
    deferToProduction: file.deferToProduction,
  });
  delete base.definitionInvalid;
  return base;
}

export function jobToFile(job: IDbtJob): DbtJobFile {
  const aliases = job.aliases ? [...job.aliases] : [];
  return {
    name: job.name,
    // The row's aliases ride along so a write-through (which regenerates the
    // whole file from the row) never drops an `aliases:` a rename wrote.
    ...(aliases.length > 0 ? { aliases } : {}),
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

/**
 * One commit on main for a dbt config mutation; the rename service
 * (api/src/rename/dbt-job-rename.ts) uses it so a move + alias write is one
 * commit through the same freshen/push path as every other write here.
 */
export async function commitDbtConfig(
  workspaceId: string,
  mutation: { writes?: Record<string, string>; deletes?: string[] },
  message: string,
  author?: GitAuthor,
  /** Compare-and-swap on content; see `commitBlobsOnBranch`. */
  expectBlobs?: Record<string, string | null>,
): Promise<{ commitOid: string; unchanged: boolean }> {
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  const result = await commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, mutation, {
    message,
    author,
    expectBlobs,
  });
  if (!result.unchanged) queueMirrorPush(workspaceId);
  return { commitOid: result.commitOid, unchanged: result.unchanged };
}

async function commitConfig(
  workspaceId: string,
  mutation: { writes?: Record<string, string>; deletes?: string[] },
  message: string,
  author?: GitAuthor,
): Promise<boolean> {
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  const result = await commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, mutation, {
    message,
    author,
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
  // Rows alone are not the identity space (same rule as `reserveFlowSlug`):
  // a file at main with no row yet — pushed from a laptop and not synced,
  // or broken — is a job too, and a create landing on its slug would be
  // refused by the create-time compare-and-swap with a misleading "the
  // file changed", every time.
  const project = await DbtProject.findById(projectId)
    .select("workspaceId")
    .lean();
  const takenAtMain = new Set(
    project
      ? (await listJobDefinitionsAtMain(project.workspaceId.toString())).map(
          def => def.slug,
        )
      : [],
  );
  let slug = base;
  for (let i = 2; i < 100; i++) {
    // An old name of a renamed job is taken too: a new job under it would
    // win every lookup (current beats alias) and strand the old links.
    const taken =
      takenAtMain.has(slug) ||
      Boolean(
        await DbtJob.exists({
          projectId,
          $or: [{ slug }, { aliases: slug }],
        }),
      );
    if (!taken) return slug;
    slug = `${base}-${i}`;
  }
  throw new Error(`Could not find a free slug for job "${name}"`);
}

/**
 * Move a job row to a new slug IN PLACE: same `_id`, so the URL
 * (`/x/<project>/job/<id>`), the run history and the scheduler claim are
 * untouched, and the old slug becomes an alias. `$pull` first so renaming
 * BACK to an old name never leaves the current slug among its aliases.
 */
export async function rekeyJobSlug(
  jobId: Types.ObjectId,
  from: string,
  to: string,
  /** The commit that carries the move; see `IDbtJob.lastRenameCommit`. */
  commit?: string,
  options: {
    /** False when `from` never existed on main (a lost rename being undone). */
    recordOldAsAlias?: boolean;
  } = {},
): Promise<void> {
  const recordOldAsAlias = options.recordOldAsAlias ?? true;
  await DbtJob.updateOne({ _id: jobId }, { $pull: { aliases: to } });
  await DbtJob.updateOne(
    { _id: jobId, slug: from },
    {
      $set: {
        slug: to,
        ...(commit
          ? { lastRenameCommit: commit, lastRenameAt: new Date() }
          : {}),
      },
      ...(recordOldAsAlias ? { $addToSet: { aliases: from } } : {}),
    },
  );
}

/**
 * Laptop rename detection for job files (graceful rename, rule 3): pair each
 * row whose file is gone with a file that has no row — by the file's
 * `aliases:`, by `git diff -M`, or by identical content — and re-key the
 * pairs before the push-sync loop looks rows up by slug. See
 * `rename/flow-dbt-job-pairing.ts` for the rules and why ambiguity is never
 * guessed. Never throws into the sync.
 */
export async function rekeyRenamedJobs(args: {
  workspaceId: string;
  projectId: Types.ObjectId;
  repoDir: string;
  /** The commit `files` were read at. */
  head: string;
  files: Array<{ path: string; contents: string; oid: string }>;
  /** See `rekeyRenamedFlows`: a rename BACK is honoured only on the mirror's main. */
  treeIsCurrent?: () => Promise<boolean>;
}): Promise<SlugRenamePair[]> {
  const { workspaceId, projectId, repoDir, head, files, treeIsCurrent } = args;
  const fileBySlug = new Map<
    string,
    { path: string; contents: string; oid: string }
  >();
  for (const file of files) {
    const slug = slugFromJobFilePath(file.path);
    if (slug) fileBySlug.set(slug, file);
  }
  const rows = await DbtJob.find({ projectId, slug: { $exists: true } });
  const rowBySlug = new Map<string, IDbtJob>();
  for (const row of rows) {
    if (row.slug) rowBySlug.set(row.slug, row);
  }
  const addedFiles = [...fileBySlug.entries()].filter(
    ([slug]) => !rowBySlug.has(slug),
  );
  const removedRows: IDbtJob[] = [];
  for (const row of rows) {
    if (row.slug === undefined || fileBySlug.has(row.slug)) continue;
    // A tree older than the row's recent rename commit still shows its old
    // file; that is not a candidate for anything (see flow-sync.service.ts).
    if (await jobRenameGuardActive(repoDir, head, row)) {
      logger.info("Tree predates a job rename; not pairing its old slug", {
        workspaceId,
        slug: row.slug,
        head,
      });
      continue;
    }
    removedRows.push(row);
  }
  if (removedRows.length === 0 || addedFiles.length === 0) return [];

  const removed: RemovedSlug[] = [];
  for (const row of removedRows) {
    let contents = row.sourceBlobSha
      ? await readBlobByOid(repoDir, row.sourceBlobSha)
      : null;
    if (contents === null) contents = serializeJobFile(jobToFile(row));
    const parsedOld = parseJobFile(contents);
    removed.push({
      slug: row.slug as string,
      aliases: row.aliases ?? [],
      contents,
      target: parsedOld ? jobRenameTarget(parsedOld) : null,
    });
  }
  const added = addedFiles.map(([slug, file]) => {
    const parsed = parseJobFile(file.contents);
    return {
      slug,
      contents: file.contents,
      aliases: parsed?.aliases ?? [],
      target: parsed ? jobRenameTarget(parsed) : null,
    };
  });
  const gitRenames = new Map<string, string>();
  for (const [from, to] of await detectGitRenames(
    repoDir,
    removedRows.map(row => ({
      path: jobFilePath(row.slug as string),
      oid: row.sourceBlobSha,
    })),
    addedFiles.map(([slug, file]) => ({
      path: jobFilePath(slug),
      oid: file.oid,
    })),
  )) {
    const fromSlug = slugFromJobFilePath(from);
    const toSlug = slugFromJobFilePath(to);
    if (fromSlug && toSlug) gitRenames.set(fromSlug, toSlug);
  }

  const pairing = pairRenamedSlugs({ removed, added, gitRenames });
  for (const entry of pairing.ambiguous) {
    logger.warn("Ambiguous dbt job rename; not pairing", {
      workspaceId,
      slug: entry.slug,
      rule: entry.rule,
      candidates: entry.candidates,
    });
  }
  for (const entry of pairing.targetMismatch) {
    logger.warn(
      "dbt job renamed by alias onto a different environment/commands",
      { workspaceId, from: entry.from, to: entry.to },
    );
  }
  const done: SlugRenamePair[] = [];
  for (const pair of pairing.pairs) {
    const row = rowBySlug.get(pair.from);
    if (!row) continue;
    if (
      (row.aliases ?? []).includes(pair.to) &&
      treeIsCurrent &&
      !(await treeIsCurrent())
    ) {
      logger.info(
        "dbt job would be renamed back to an old name on an unverified tree; keeping it",
        { workspaceId, from: pair.from, to: pair.to, via: pair.via },
      );
      continue;
    }
    try {
      await rekeyJobSlug(row._id, pair.from, pair.to, head);
      done.push(pair);
      logger.info("dbt job renamed in place from a pushed file move", {
        workspaceId,
        jobId: row._id.toString(),
        from: pair.from,
        to: pair.to,
        via: pair.via,
      });
    } catch (error) {
      logger.warn("Could not re-key a renamed dbt job; leaving it as is", {
        workspaceId,
        from: pair.from,
        to: pair.to,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return done;
}

/** Write-through: the job's file mirrors the row's definition fields. */
export async function commitDbtJobFile(
  project: Pick<IDbtProject, "workspaceId">,
  job: IDbtJob,
  actorUserId?: string,
  messageOverride?: string,
): Promise<void> {
  if (!job.slug) return; // pre-adoption row; the migration stamps slugs
  const workspaceId = project.workspaceId.toString();
  const contents = serializeJobFile(jobToFile(job));
  const sha = blobOid(contents);
  // Never write to a slug a concurrent rename has already moved away from
  // (the old file would come back beside the new one as a second scheduled
  // job). The row's current slug is read AFTER the freshen that precedes
  // every main write, and the commit is a compare-and-swap on the file
  // (`expectBlobs`): a rename or edit landing in between fails the request
  // with the reason rather than being written over.
  await requireWorkspaceRepo(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  if (!job.isNew) {
    const current = await DbtJob.findById(job._id).select("slug").lean();
    if (current?.slug && current.slug !== job.slug) {
      throw new DbtConfigConflictError(
        `the job was renamed to "${current.slug}" while this change was being made; reload and retry`,
      );
    }
  }
  // What the path must still hold: the blob this row last SAW at main
  // (`lastSeenBlobSha`, which a broken file sets too — so a UI save that
  // fixes a bad laptop push, and the auto-disable after failures, go
  // through), never a blob nobody has seen. Rows from before that field
  // fall back to the last applied blob, unless marked invalid, where that
  // blob is by definition not what is on main: then no precondition (the
  // pre-CAS behaviour), which is the recovery path.
  const expected = job.isNew
    ? // A new job's file must not exist yet (a git-only file of the same
      // slug is someone else's job).
      null
    : (job.lastSeenBlobSha ??
      (isMarkedInvalid(job) ? undefined : job.sourceBlobSha));
  const written = true;
  try {
    await commitDbtConfig(
      workspaceId,
      { writes: { [jobFilePath(job.slug)]: contents } },
      messageOverride ?? `dbt: job "${job.name}" (${job.slug})`,
      actorUserId ? await authorForUser(actorUserId) : undefined,
      expected === undefined
        ? undefined
        : { [jobFilePath(job.slug)]: expected },
    );
  } catch (error) {
    if (error instanceof BlobPreconditionError) {
      throw new DbtConfigConflictError(
        `${error.path} changed in the workspace repo while this change was being made (a rename or another edit landed first); reload and retry`,
      );
    }
    throw error;
  }
  // Stamp AFTER the file exists. Stamping first meant a failed commit left
  // the row claiming a sha for a file that was never written, and the
  // push-sync short-circuits on a matching sha. For a not-yet-persisted
  // document (`new DbtJob`), the caller saves after this returns.
  if (written && (job.sourceBlobSha !== sha || job.lastSeenBlobSha !== sha)) {
    job.sourceBlobSha = sha;
    job.lastSeenBlobSha = sha;
    if (!job.isNew) {
      await DbtJob.updateOne(
        { _id: job._id },
        { $set: { sourceBlobSha: sha, lastSeenBlobSha: sha } },
      );
    }
  }
}

export async function deleteDbtJobFile(
  project: Pick<IDbtProject, "workspaceId">,
  slug: string | undefined,
  actorUserId?: string,
): Promise<void> {
  if (!slug) return;
  await commitConfig(
    project.workspaceId.toString(),
    { deletes: [jobFilePath(slug)] },
    `dbt: delete job ${slug}`,
    actorUserId ? await authorForUser(actorUserId) : undefined,
  );
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
  // A file that moved is the same job: re-key its row to the new slug BEFORE
  // the loop looks rows up by slug, so the moved file is an update of the
  // row (same id, same URL, same run history) and the stale sweep at the
  // end never sees the old slug as a deleted job.
  const fileSlugs = new Set<string>();
  for (const path of blobs.keys()) {
    const slug = slugFromJobFilePath(path);
    if (slug) fileSlugs.add(slug);
  }
  const treeIsCurrent = currentTreeCheck(workspaceId, head, reason => {
    logger.info("dbt job sync tree is not the mirror's current main", {
      workspaceId,
      head,
      reason,
    });
  });
  try {
    await settleJobRenameGuards({
      workspaceId,
      projectId: project._id,
      repoDir,
      head,
      fileSlugs,
      treeIsCurrent,
    });
  } catch (error) {
    logger.warn("dbt job rename guards could not be settled", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const idRows = await DbtJob.find({ projectId: project._id })
    .select("_id slug")
    .lean();
  try {
    await rekeyRenamedJobs({
      workspaceId,
      projectId: project._id,
      repoDir,
      head,
      treeIsCurrent,
      files: [...blobs].map(([path, buf]) => ({
        path,
        contents: buf.toString("utf8"),
        oid: blobOid(buf),
      })),
    });
  } catch (error) {
    logger.warn("dbt job rename detection failed; syncing by slug only", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const seenSlugs = new Set<string>();
  for (const [path, buf] of blobs) {
    const slug = slugFromJobFilePath(path);
    if (!slug) continue;
    seenSlugs.add(slug);
    const contents = buf.toString("utf8");
    // Git's id from the raw bytes, never a hash of the decoded text.
    const sha = blobOid(buf);
    let row = await DbtJob.findOne({ projectId: project._id, slug });
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
        row.lastSeenBlobSha = sha;
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
      if (row) await markJobInvalid(row, failure, path, sha);
      continue;
    }
    // A file at a slug some row holds as an ALIAS: a new job taking an old
    // name (current wins; the old row loses the alias below), unless this
    // tree predates that row's rename commit — then the old file is just
    // the pre-rename view and must not become a second job. The row is
    // counted as seen so the stale sweep leaves it alone.
    if (!row) {
      const claimant = await DbtJob.findOne({
        projectId: project._id,
        aliases: slug,
      });
      if (claimant?.slug) {
        const guarded = await jobRenameGuardActive(repoDir, head, claimant);
        // Same job under its old name (same environment and commands, and
        // its current file absent from this tree): a stale tree, or the
        // file moved back — told apart by whether the tree is the mirror's
        // main; unknown → keep the row (see flow-sync.service.ts).
        const sameJob =
          !fileSlugs.has(claimant.slug) &&
          jobRenameTarget(jobToFile(claimant)) === jobRenameTarget(parsed);
        const keep = guarded || (sameJob && !(await treeIsCurrent()));
        if (keep) {
          logger.info("Tree predates a job rename; keeping the renamed row", {
            workspaceId,
            path,
            renamedTo: claimant.slug,
            guarded,
          });
          seenSlugs.add(claimant.slug);
          continue;
        }
        if (sameJob) {
          logger.warn(
            "dbt job file is back under an old name; re-keying the row to it",
            { workspaceId, path, from: claimant.slug, to: slug },
          );
          await rekeyJobSlug(claimant._id, claimant.slug, slug, head);
          row = await DbtJob.findById(claimant._id);
        }
      }
    }
    const scheduleChanged = !row || scheduleDiffers(row, parsed);
    const doc =
      row ??
      new DbtJob({
        // The id GET/list already handed out for this git-only file: a tab
        // opened before the push landed keeps resolving after it.
        _id: freeDerivedJobId(workspaceId, slug, idRows),
        workspaceId: project.workspaceId,
        projectId: project._id,
        slug,
        createdBy: "sync",
      });
    doc.name = parsed.name;
    const merged = await dropJobAliasesClaimedElsewhere(
      project._id,
      doc._id,
      mergedAliases(doc.aliases, parsed.aliases, slug),
    );
    if (merged.dropped.length > 0) {
      logger.warn("dbt job file lists aliases another job already claims", {
        workspaceId,
        path,
        dropped: merged.dropped,
      });
    }
    doc.aliases = merged.kept.length > 0 ? merged.kept : undefined;
    doc.environment = parsed.environment;
    doc.commands = parsed.commands;
    doc.schedule = parsed.schedule
      ? { cron: parsed.schedule.cron, timezone: parsed.schedule.timezone }
      : undefined;
    doc.enabled = parsed.enabled;
    doc.deferToProduction = parsed.deferToProduction;
    doc.sourceBlobSha = sha;
    doc.lastSeenBlobSha = sha;
    const clearInvalid = isMarkedInvalid(doc);
    // One file's failure is that file's problem: a save that throws (a
    // duplicate id, a schema refusal) must not skip every file after it and
    // the stale sweep with it. The row that exists is kept; a new one is
    // simply not created.
    try {
      await doc.save();
    } catch (error) {
      logger.warn("dbt job file could not be saved; keeping current row", {
        workspaceId,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      // The row still SAW this blob: a UI save that fixes it may overwrite it.
      if (row) {
        await DbtJob.updateOne(
          { _id: row._id },
          { $set: { lastSeenBlobSha: sha } },
        );
      }
      continue;
    }
    if (!row) {
      // Current always wins: the old row drops the alias this file took.
      await DbtJob.updateMany(
        { projectId: project._id, aliases: slug, _id: { $ne: doc._id } },
        { $pull: { aliases: slug } },
      );
    }
    if (clearInvalid) {
      // Assigning undefined to a nested path persists `{}`; unset it.
      await DbtJob.updateOne(
        { _id: doc._id },
        { $unset: { definitionInvalid: 1 } },
      );
    }
    if (scheduleChanged) await applyJobScheduleChange(doc);
    logger.info("dbt job synced from repo", { workspaceId, slug });
  }

  // A job file removed on main removes the job (runs keep their history).
  // Except a job renamed WHILE this sync ran: its new slug was not in the
  // tree this sync read, but its rename commit is on its way to main — the
  // guard says so — and deleting it here would recreate it under a new id
  // on the next push. The next sync, which contains the rename, sees it.
  const stale = await DbtJob.find({
    projectId: project._id,
    slug: { $exists: true, $nin: [...seenSlugs] },
  }).select("slug name lastRenameCommit lastRenameAt");
  for (const doc of stale) {
    if (await jobRenameGuardActive(repoDir, head, doc)) {
      logger.info("dbt job renamed during this sync; not sweeping it", {
        workspaceId,
        slug: doc.slug,
      });
      continue;
    }
    await DbtJob.deleteOne({ _id: doc._id });
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
    job.lastSeenBlobSha = job.sourceBlobSha;
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
