/**
 * dbt orchestration config in the workspace repo (apps.md §23).
 *
 * Files are authoritative for job DEFINITIONS (`dbt/jobs/<slug>.yml`) and
 * project environments/settings (`dbt/environments.yml`); the database rows
 * are the derived index the scheduler scans, carrying the runtime fields
 * (scheduledRun claims, failure counters, lastRun stats) that never enter
 * git. Every in-product mutation writes through here (a commit on main —
 * jobs build main, so orchestration config is main-scoped, branch-policy
 * rule 2), and the push-reaction reconciles external edits, re-registering
 * schedules the way a push to apps/ deploys.
 */
import { parseEntityId } from "../database/pg/id-codec";
import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import {
  dbtRepo,
  type DbtJobRecord,
  type DbtProjectRecord,
} from "../repositories/dbt";
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
  freshenForServe,
  queueMirrorPush,
} from "../apps/cloud-repo.service";
import {
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
  row: DbtJobRecord | null;
  id: string;
}

export function derivedJobId(workspaceId: string, slug: string): string {
  const digest = createHash("sha1")
    .update(`dbt-job:${workspaceId}:${slug}`)
    .digest("hex");
  return digest.slice(0, 24);
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
  if (!(await resolveCommit(repoDir, MAIN))) return [];
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
        oid: blob.isBinary
          ? blobOid(Buffer.from(blob.contents, "base64"))
          : blobOid(blob.contents),
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
  project: DbtProjectRecord,
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
function isMarkedInvalid(row: DbtJobRecord): boolean {
  return typeof row.definitionInvalid?.reason === "string";
}

async function markJobInvalid(
  row: DbtJobRecord,
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
    await dbtRepo.updateJob(row._id, { definitionInvalid });
    row.definitionInvalid = definitionInvalid;
  } catch (error) {
    logger.warn("Failed to mark dbt job invalid", {
      jobId: row._id.toString(),
      error,
    });
  }
}

function scheduleDiffers(row: DbtJobRecord, file: DbtJobFile): boolean {
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
  project: DbtProjectRecord,
  def: JobDefinitionAtMain,
  row: DbtJobRecord,
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
  const patch = {
    name: file.name,
    environment: file.environment,
    commands: file.commands,
    schedule: file.schedule ?? null,
    enabled: file.enabled,
    deferToProduction: file.deferToProduction,
    sourceBlobSha: def.oid,
    definitionInvalid: null,
  };
  const updated = await dbtRepo.updateJob(row._id, patch);
  if (!updated) return;
  Object.assign(row, updated, {
    schedule: updated.schedule,
    definitionInvalid: undefined,
  });
  if (reschedule) await applyJobScheduleChange(row);
}

function joinLiveJobs(
  project: DbtProjectRecord,
  defs: JobDefinitionAtMain[],
  rows: DbtJobRecord[],
): LiveJob[] {
  const bySlug = new Map(rows.map(row => [row.slug, row]));
  return defs.map(def => ({
    def,
    row: bySlug.get(def.slug) ?? null,
    id:
      bySlug.get(def.slug)?._id ??
      derivedJobId(project.workspaceId.toString(), def.slug),
  }));
}

export async function loadLiveJobs(
  project: DbtProjectRecord,
): Promise<LiveJob[]> {
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
  const rows = await dbtRepo.listJobsByProject(project._id);
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
  project: DbtProjectRecord,
  jobId: string,
): Promise<LiveJob | null> {
  if (!parseEntityId(jobId)) return null;
  const live = await loadLiveJobs(project);
  return live.find(job => job.id.toString() === jobId) ?? null;
}

export type LiveJobRowResolution =
  | { ok: true; live: LiveJob; row: DbtJobRecord }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Resolve a job id for a mutation or a run: the file must be live at main
 * AND the scheduler row must exist. A file that only lives in git (the push
 * has not been reconciled yet) is a 409 with the reason, not a bare 404 —
 * the list just showed the job. A row whose file was deleted is not live
 * and resolves to nothing, so it can no longer be triggered.
 */
export async function resolveLiveJobRow(
  project: DbtProjectRecord,
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

export function liveJobToPlain(
  live: LiveJob,
  project: DbtProjectRecord,
): Record<string, unknown> {
  const base: Record<string, unknown> = live.row
    ? { ...live.row }
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

function jobToFile(
  job: Pick<
    DbtJobRecord,
    | "name"
    | "environment"
    | "commands"
    | "schedule"
    | "enabled"
    | "deferToProduction"
  >,
): DbtJobFile {
  return {
    name: job.name,
    environment: job.environment,
    commands: [...job.commands],
    schedule: job.schedule?.cron
      ? { cron: job.schedule.cron, timezone: job.schedule.timezone || "UTC" }
      : null,
    enabled: job.enabled !== false,
    deferToProduction: !!job.deferToProduction,
  };
}

function environmentsToFile(
  project: Pick<
    DbtProjectRecord,
    "dbtVersion" | "environments" | "defaultEnvironment" | "prodEnvironment"
  >,
) {
  return {
    dbtVersion: project.dbtVersion,
    defaultEnvironment: project.defaultEnvironment,
    prodEnvironment: project.prodEnvironment,
    environments: project.environments.map(env => ({
      name: env.name,
      connectionId: env.connectionId.toString(),
      ...(env.readConnectionId
        ? { readConnectionId: env.readConnectionId.toString() }
        : {}),
      targetSchema: env.targetSchema,
      threads: env.threads,
      vars: env.vars as Record<string, unknown> | undefined,
      ownerUserId: env.ownerUserId,
    })),
  };
}

function isEnvironmentsMarkedInvalid(project: DbtProjectRecord): boolean {
  return typeof project.environmentsInvalid?.reason === "string";
}

async function markEnvironmentsInvalid(
  project: DbtProjectRecord,
  reason: string,
): Promise<void> {
  if (project.environmentsInvalid?.reason === reason) return;
  const environmentsInvalid = { reason, at: new Date() };
  await dbtRepo.updateProject(project._id, { environmentsInvalid });
  project.environmentsInvalid = environmentsInvalid;
}

/** Project settings follow `dbt/environments.yml`; same mapping for read and push. */
async function applyEnvironmentsFile(
  project: DbtProjectRecord,
  parsed: DbtEnvironmentsFile,
): Promise<void> {
  const level =
    serializeEnvironmentsFile(environmentsToFile(project)) ===
    serializeEnvironmentsFile(parsed);
  if (level && !isEnvironmentsMarkedInvalid(project)) return;
  if (parsed.environments.some(env => !parseEntityId(env.connectionId))) {
    await markEnvironmentsInvalid(project, "invalid environment connection id");
    return;
  }
  project.environments = parsed.environments.map(env => ({
    name: env.name,
    connectionId: env.connectionId,
    // A value that is no id is dropped: metric queries then fall back to
    // the build connection rather than the whole file being refused.
    ...(env.readConnectionId && parseEntityId(env.readConnectionId)
      ? { readConnectionId: env.readConnectionId }
      : {}),
    targetSchema: env.targetSchema,
    threads: env.threads ?? 4,
    vars: env.vars,
    ownerUserId: env.ownerUserId,
  }));
  project.defaultEnvironment = parsed.defaultEnvironment;
  project.prodEnvironment = parsed.prodEnvironment;
  if (parsed.dbtVersion) project.dbtVersion = parsed.dbtVersion;
  await dbtRepo.updateProject(project._id, {
    environments: project.environments,
    defaultEnvironment: project.defaultEnvironment,
    prodEnvironment: project.prodEnvironment ?? null,
    dbtVersion: project.dbtVersion,
    environmentsInvalid: null,
  });
  project.environmentsInvalid = undefined;
}

/**
 * `dbt/environments.yml` at main is the read surface for a project's
 * environments (apps.md §23), the way `dbt/jobs/*.yml` is for jobs. The
 * project row is resynced in place when the file differs — a project GET
 * after an external edit shows the file, not the last push. No file at main
 * (workspace not adopted) leaves the row alone; an unbound workspace too.
 */
export async function ensureEnvironmentsDerivedCache(
  project: DbtProjectRecord,
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
 * the indexed version. Freshening at COMMIT time cannot fix that second one — the
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
  projectId: string | { toString(): string },
  name: string,
): Promise<string> {
  const base = slugifyJobName(name);
  let slug = base;
  for (let i = 2; i < 100; i++) {
    const taken = await dbtRepo.jobSlugExists(String(projectId), slug);
    if (!taken) return slug;
    slug = `${base}-${i}`;
  }
  throw new Error(`Could not find a free slug for job "${name}"`);
}

/** Write-through: the job's file mirrors the row's definition fields. */
export async function commitDbtJobFile(
  project: { workspaceId: { toString(): string } },
  job: Pick<
    DbtJobRecord,
    | "name"
    | "environment"
    | "commands"
    | "schedule"
    | "enabled"
    | "deferToProduction"
    | "slug"
  > & { _id?: { toString(): string }; sourceBlobSha?: string },
  actorUserId?: string,
  messageOverride?: string,
): Promise<string | undefined> {
  if (!job.slug) return; // pre-adoption row; the migration stamps slugs
  const contents = serializeJobFile(jobToFile(job));
  const sha = blobOid(contents);
  const written = await commitConfig(
    project.workspaceId.toString(),
    { writes: { [jobFilePath(job.slug)]: contents } },
    messageOverride ?? `dbt: job "${job.name}" (${job.slug})`,
    actorUserId ? await authorForUser(actorUserId) : undefined,
  );
  if (!written) return undefined;
  if (job._id && job.sourceBlobSha !== sha) {
    await dbtRepo.updateJob(String(job._id), { sourceBlobSha: sha });
  }
  return sha;
}

export async function deleteDbtJobFile(
  project: { workspaceId: { toString(): string } },
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
  project: Parameters<typeof environmentsToFile>[0] & { workspaceId: string },
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
 * Reconcile the job index from `dbt/jobs/*.yml` + `dbt/environments.yml`
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
  const [project] = await dbtRepo.listProjectsByWorkspace(workspaceId, {
    limit: 1,
  });
  if (!project) return;
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) return;
  const entries = await listTree(repoDir, head);
  const jobPaths = entries
    .map(e => e.path)
    .filter(p => slugFromJobFilePath(p) !== null);
  // No dbt config in the repo at all → not adopted; leave the index alone.
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
          "dbt environments.yml is invalid; keeping the last indexed settings",
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
  const seenSlugs = new Set<string>();
  for (const [path, buf] of blobs) {
    const slug = slugFromJobFilePath(path);
    if (!slug) continue;
    seenSlugs.add(slug);
    const contents = buf.toString("utf8");
    const sha = blobOid(contents);
    const row = await dbtRepo.findJobBySlug(project._id, slug);
    // Level already — unless the row is still flagged from an earlier bad
    // version and the file was reverted to this exact content, in which
    // case the marker must clear.
    if (row && row.sourceBlobSha === sha && !isMarkedInvalid(row)) continue;
    const parsed = parseJobFile(contents);
    if (!parsed) {
      logger.warn(
        "dbt job file is invalid; keeping the last indexed settings",
        {
          workspaceId,
          path,
        },
      );
      if (row) {
        row.definitionInvalid = {
          reason: "unparseable job file",
          at: new Date(),
          path,
        };
        row.enabled = false;
        await dbtRepo.updateJob(row._id, {
          enabled: false,
          definitionInvalid: row.definitionInvalid,
        });
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
    const fields = {
      name: parsed.name,
      environment: parsed.environment,
      commands: parsed.commands,
      enabled: parsed.enabled,
      deferToProduction: parsed.deferToProduction,
      sourceBlobSha: sha,
    };
    const doc = row
      ? await dbtRepo.updateJob(row._id, {
          ...fields,
          schedule: parsed.schedule ?? null,
          definitionInvalid: null,
        })
      : await dbtRepo.createJob({
          ...fields,
          _id: derivedJobId(workspaceId, slug),
          workspaceId,
          projectId: project._id,
          slug,
          createdBy: "sync",
          schedule: parsed.schedule ?? undefined,
        });
    if (doc && scheduleChanged) await applyJobScheduleChange(doc);
    logger.info("dbt job synced from repo", { workspaceId, slug });
  }

  // A job file removed on main removes the job (runs keep their history).
  const indexed = await dbtRepo.listJobsByProject(project._id);
  for (const doc of indexed) {
    if (!doc.slug || seenSlugs.has(doc.slug)) continue;
    await dbtRepo.deleteJob(doc._id);
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
  const [project] = await dbtRepo.listProjectsByWorkspace(workspaceId, {
    limit: 1,
  });
  if (!project) return { jobs: 0, written: 0 };
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  const existing = new Set(
    head ? (await listTree(repoDir, head)).map(e => e.path) : [],
  );

  const writes: Record<string, string> = {};
  const jobs = await dbtRepo.listJobsByProject(project._id);
  for (const job of jobs) {
    if (!job.slug) {
      job.slug = await reserveJobSlug(project._id, job.name);
    }
    const path = jobFilePath(job.slug);
    const contents = serializeJobFile(jobToFile(job));
    job.sourceBlobSha = blobOid(contents);
    await dbtRepo.updateJob(job._id, {
      slug: job.slug,
      sourceBlobSha: job.sourceBlobSha,
    });
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
