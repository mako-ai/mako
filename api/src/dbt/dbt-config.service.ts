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
  ensureLocalRepo,
  freshenBeforeMainWrite,
  queueMirrorPush,
} from "../apps/cloud-repo.service";
import {
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

function jobToFile(job: IDbtJob): DbtJobFile {
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
): Promise<void> {
  // Freshened by repoDirIfExists: config-as-code commits land on main, so
  // they are judged against the mirror's main rather than this instance's
  // cache (#916, moved up to the choke point so the reads get it too —
  // freshenBeforeMainWrite is un-throttled, so doing it in both places would
  // cost two sequential fetches per write).
  const repoDir = await repoDirIfExists(workspaceId);
  if (!repoDir) return;
  const result = await commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, mutation, {
    message,
    author,
  });
  if (!result.unchanged) queueMirrorPush(workspaceId);
}

/** Reserve a unique slug for a new job and stamp it on the row fields. */
export async function reserveJobSlug(
  projectId: Types.ObjectId,
  name: string,
): Promise<string> {
  const base = slugifyJobName(name);
  let slug = base;
  for (let i = 2; i < 100; i++) {
    const taken = await DbtJob.exists({ projectId, slug });
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
  if (job.sourceBlobSha !== sha) {
    await DbtJob.updateOne({ _id: job._id }, { $set: { sourceBlobSha: sha } });
  }
  await commitConfig(
    project.workspaceId.toString(),
    { writes: { [jobFilePath(job.slug)]: contents } },
    messageOverride ?? `dbt: job "${job.name}" (${job.slug})`,
    actorUserId ? await authorForUser(actorUserId) : undefined,
  );
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
  if (!repoDir) return;
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
        logger.warn("dbt environments.yml is invalid; keeping current config", {
          workspaceId,
        });
      } else {
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
        if (project.isModified()) await project.save();
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
    const row = await DbtJob.findOne({ projectId: project._id, slug });
    if (row && row.sourceBlobSha === sha) continue; // level already
    const parsed = parseJobFile(contents);
    if (!parsed) {
      logger.warn("dbt job file is invalid; keeping current row", {
        workspaceId,
        path,
      });
      continue;
    }
    try {
      parseDbtCommands(parsed.commands); // allowlist — never index a job we refuse to run
    } catch (error) {
      logger.warn("dbt job file has disallowed commands; skipped", {
        workspaceId,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!project.environments.some(env => env.name === parsed.environment)) {
      logger.warn("dbt job file names an unknown environment; skipped", {
        workspaceId,
        path,
        environment: parsed.environment,
      });
      continue;
    }
    const scheduleChanged =
      !row ||
      row.enabled !== parsed.enabled ||
      (row.schedule?.cron ?? null) !== (parsed.schedule?.cron ?? null) ||
      (row.schedule?.timezone ?? null) !== (parsed.schedule?.timezone ?? null);
    const doc =
      row ??
      new DbtJob({
        workspaceId: project.workspaceId,
        projectId: project._id,
        slug,
        createdBy: "sync",
      });
    doc.name = parsed.name;
    doc.environment = parsed.environment;
    doc.commands = parsed.commands;
    doc.schedule = parsed.schedule
      ? { cron: parsed.schedule.cron, timezone: parsed.schedule.timezone }
      : undefined;
    doc.enabled = parsed.enabled;
    doc.deferToProduction = parsed.deferToProduction;
    doc.sourceBlobSha = sha;
    await doc.save();
    if (scheduleChanged) await applyJobScheduleChange(doc);
    logger.info("dbt job synced from repo", { workspaceId, slug });
  }

  // A job file removed on main removes the job (runs keep their history).
  const stale = await DbtJob.find({
    projectId: project._id,
    slug: { $exists: true, $nin: [...seenSlugs] },
  }).select("slug name");
  for (const doc of stale) {
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
  if (!repoDir) return { jobs: 0, written: 0 };
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
