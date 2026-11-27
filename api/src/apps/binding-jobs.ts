/**
 * Asynchronous binding builds — for builds longer than the edge allows.
 *
 * Cloudflare answers 524 after 100 s without a response, so a
 * `POST …/bindings/<name>/materialize` (or `…/dev-build`) whose query runs
 * longer "failed" for the caller while the build carried on server-side. A
 * caller that asks for it (`?async=1`, `{ async: true }`) now gets a job id at
 * once (202) and polls `GET …/binding-jobs/<jobId>`; the build runs in an
 * Inngest function, which Inngest invokes on the Cloud Run URL directly (no
 * edge timeout) — the path scheduled materializations already take. Callers
 * that do not ask keep the synchronous answer.
 *
 * A job remembers its REQUEST, not the binding: the worker re-reads the repo
 * (materialize) or re-plans the submitted text (dev-build), so it builds what
 * the synchronous route would have built. Results:
 *
 *   - materialize / committed dev-build → the app's stored artifact key;
 *   - a draft dev-build → the parquet under `apps/jobs/<projectId>/<jobId>`,
 *     readable only through this job (same actor) and deleted with it.
 *
 * Jobs expire after JOB_TTL_MS; a project's expired jobs (row + draft
 * object) are deleted whenever it creates a new one.
 */
import fs from "node:fs/promises";
import { Types } from "mongoose";
import { parseEntityId } from "../database/pg/id-codec";
import {
  appsMetadataRepo,
  getMongoAppBindingJobModel,
  toMongoObjectId,
  type AppBindingJobRecord,
} from "../repositories/apps-metadata";
import { getArtifactStore } from "../services/artifact-store.service";
import type { BindingPhase, BindingProgressEvent } from "./binding-progress";

// Ensure Mongoose model stays compiled for Mongo tests inspecting it directly.
void getMongoAppBindingJobModel();

/**
 * A job's row lives this long past its last state change or heartbeat; a
 * finished job's result stays fetchable that long. Queued and running jobs
 * are never pruned — only finished ones.
 */
export const JOB_TTL_MS = 60 * 60_000;

/** A running job's worker proves it is alive this often… */
export const JOB_HEARTBEAT_MS = 30_000;
/** …and a running job silent for longer than this is presumed dead. */
export const JOB_LEASE_MS = 3 * 60_000;

export type BindingJobKind = "materialize" | "dev-build";
export type BindingJobStatus = "queued" | "running" | "ready" | "error";

export interface BindingJobRequest {
  /** dev-build only. */
  source?: string;
  dbtEnvironment?: string;
  dbtDefer?: boolean;
  refresh?: boolean;
}

export interface BindingJobResult {
  artifactKey: string;
  /** "materialized" | "draft" | "artifact" — what `x-mako-build` would say. */
  build: string;
  rowCount?: number;
  byteSize?: number;
  materializedAt?: string;
}

/**
 * The running build's latest phase (binding-progress.ts), so the poller can
 * say "querying the warehouse" rather than "running". In the row, not in
 * memory: the worker and the poller are rarely the same instance.
 */
export interface BindingJobProgress {
  phase: BindingPhase;
  rowsWritten?: number;
  bytes?: number;
  at: Date;
}

export interface BindingJobDoc {
  _id: Types.ObjectId;
  workspaceId: string;
  /** The app's id — re-resolved by the worker (resolveProjectRef). */
  projectId: string;
  name: string;
  kind: BindingJobKind;
  actorId: string;
  userId?: string;
  canWrite: boolean;
  /**
   * dev-build of an app not on main yet (unregistered-draft-app.ts): the
   * worker synthesizes the same draft-only project the route did.
   */
  unregistered?: boolean;
  request: BindingJobRequest;
  status: BindingJobStatus;
  result?: BindingJobResult | null;
  error?: string | null;
  /** HTTP status the synchronous route would have answered the failure with. */
  errorStatus?: number | null;
  /** Last proof of life from the worker (running jobs). */
  heartbeatAt?: Date | null;
  progress?: BindingJobProgress | null;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

function recordToBindingJobDoc(rec: AppBindingJobRecord): BindingJobDoc {
  return {
    _id: toMongoObjectId(rec.id),
    workspaceId: rec.workspaceId,
    projectId: rec.projectId,
    name: rec.name,
    kind: rec.kind ?? "materialize",
    actorId: rec.actorId,
    ...(rec.userId !== undefined ? { userId: rec.userId } : {}),
    canWrite: rec.canWrite,
    ...(rec.unregistered !== undefined
      ? { unregistered: rec.unregistered }
      : {}),
    request: rec.request,
    status: rec.status,
    ...(rec.result !== undefined ? { result: rec.result } : {}),
    ...(rec.error !== undefined ? { error: rec.error } : {}),
    ...(rec.errorStatus !== undefined ? { errorStatus: rec.errorStatus } : {}),
    ...(rec.heartbeatAt !== undefined ? { heartbeatAt: rec.heartbeatAt } : {}),
    ...(rec.progress !== undefined
      ? {
          progress: rec.progress
            ? {
                ...rec.progress,
                phase: rec.progress.phase as BindingPhase,
              }
            : null,
        }
      : {}),
    expiresAt: rec.expiresAt,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

export function jobDraftKey(projectId: string, jobId: string): string {
  return `apps/jobs/${projectId}/${jobId}.parquet`;
}

export async function createBindingJob(
  input: Omit<
    BindingJobDoc,
    "_id" | "status" | "result" | "error" | "errorStatus" | "expiresAt"
  >,
  now: Date = new Date(),
): Promise<BindingJobDoc> {
  await pruneExpiredJobs(input.projectId, now, input.workspaceId);
  const created = await appsMetadataRepo.createBindingJob({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    name: input.name,
    kind: input.kind,
    actorId: input.actorId,
    userId: input.userId,
    canWrite: input.canWrite,
    unregistered: input.unregistered,
    request: input.request,
    expiresAt: new Date(now.getTime() + JOB_TTL_MS),
  });
  return recordToBindingJobDoc(created);
}

/** The job, if it belongs to this project and is still live. */
export async function getBindingJob(
  projectId: string,
  jobId: string,
  now: Date = new Date(),
  workspaceId?: string,
): Promise<BindingJobDoc | null> {
  if (!parseEntityId(jobId)) return null;
  const rec = await appsMetadataRepo.findBindingJobById(
    jobId,
    projectId,
    workspaceId,
  );
  if (!rec) return null;
  const doc = recordToBindingJobDoc(rec);
  // An unfinished job never disappears under its poller.
  if (isFinished(doc) && doc.expiresAt <= now) return null;
  return expireIfStale(doc, now);
}

function isFinished(job: Pick<BindingJobDoc, "status">): boolean {
  return job.status === "ready" || job.status === "error";
}

const STALE_ERROR =
  "The build stopped reporting progress (its worker was restarted or " +
  "timed out); refresh to try again";

/**
 * A running job whose worker went silent past the lease is failed, so the
 * poller gets a terminal answer instead of `running` forever (the worker does
 * not retry: re-running a warehouse query nobody is waiting for would only
 * bill it twice). Returns the job as it now stands.
 */
export async function expireIfStale(
  job: BindingJobDoc,
  now: Date = new Date(),
): Promise<BindingJobDoc> {
  if (job.status !== "running") return job;
  const alive = job.heartbeatAt ?? job.updatedAt ?? job.createdAt;
  if (alive && now.getTime() - alive.getTime() <= JOB_LEASE_MS) return job;
  const failed = await failStaleJob(job, now);
  return failed ?? job;
}

async function failStaleJob(
  job: Pick<BindingJobDoc, "_id" | "projectId" | "heartbeatAt"> & {
    workspaceId?: string;
  },
  now: Date,
): Promise<BindingJobDoc | null> {
  // Conditional on the heartbeat still being the stale one: a worker that
  // just checked in keeps its job.
  const updated = await appsMetadataRepo.casFailStaleBindingJob(
    job._id.toString(),
    new Date(now.getTime() - JOB_LEASE_MS),
    STALE_ERROR,
    502,
    new Date(now.getTime() + JOB_TTL_MS),
    job.workspaceId,
  );
  if (updated) {
    // A worker that died between uploading its draft and recording it
    // leaves the object behind; nothing will ever point at it.
    await deleteQuietly(jobDraftKey(job.projectId, job._id.toString()));
    return recordToBindingJobDoc(updated);
  }
  return null;
}

/**
 * The periodic sweep behind expireIfStale, for jobs nobody is polling any
 * more. Returns how many were failed.
 */
export async function sweepStaleBindingJobs(
  now: Date = new Date(),
): Promise<number> {
  const stale = await appsMetadataRepo.listStaleRunningBindingJobs(
    new Date(now.getTime() - JOB_LEASE_MS),
    500,
  );
  let failed = 0;
  for (const job of stale) {
    if (
      await failStaleJob(
        {
          _id: toMongoObjectId(job.id),
          workspaceId: job.workspaceId,
          projectId: job.projectId,
          heartbeatAt: job.heartbeatAt,
        },
        now,
      )
    ) {
      failed++;
    }
  }
  return failed;
}

/** The worker is alive: extend the lease (and the row's life). */
export async function heartbeatBindingJob(
  jobId: string,
  now: Date = new Date(),
  workspaceId?: string,
): Promise<void> {
  await appsMetadataRepo.heartbeatBindingJob(
    jobId,
    now,
    new Date(now.getTime() + JOB_TTL_MS),
    workspaceId,
  );
}

async function deleteQuietly(key: string): Promise<void> {
  try {
    await getArtifactStore().delete(key);
  } catch {
    // Missing already, or the store is unreachable: the prune retries.
  }
}

/** The worker's phase report. Running jobs only: never undoes a result. */
export async function recordBindingJobProgress(
  jobId: string,
  event: BindingProgressEvent,
  nowOrWorkspaceId?: Date | string,
  workspaceId?: string,
): Promise<void> {
  const now = nowOrWorkspaceId instanceof Date ? nowOrWorkspaceId : new Date();
  const resolvedWorkspaceId =
    typeof nowOrWorkspaceId === "string" ? nowOrWorkspaceId : workspaceId;
  const progress: BindingJobProgress = {
    phase: event.phase,
    ...(event.rowsWritten !== undefined
      ? { rowsWritten: event.rowsWritten }
      : {}),
    ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
    at: now,
  };
  await appsMetadataRepo.updateBindingJobProgress(
    jobId,
    progress,
    resolvedWorkspaceId,
  );
}

/** The worker's read: by id alone (the event carries only the id). */
export async function getBindingJobById(
  jobId: string,
  workspaceId?: string,
): Promise<BindingJobDoc | null> {
  if (!parseEntityId(jobId)) return null;
  const rec = await appsMetadataRepo.findBindingJobById(
    jobId,
    undefined,
    workspaceId,
  );
  return rec ? recordToBindingJobDoc(rec) : null;
}

export async function markBindingJob(
  jobId: string,
  update:
    | { status: "running" }
    | { status: "ready"; result: BindingJobResult }
    | { status: "error"; error: string; errorStatus: number },
  workspaceId?: string,
): Promise<void> {
  const now = new Date();
  await appsMetadataRepo.markBindingJob(
    jobId,
    update,
    new Date(now.getTime() + JOB_TTL_MS),
    update.status === "running" ? now : undefined,
    workspaceId,
  );
}

/** Keep a draft build's local file as this job's result (the file is removed). */
export async function storeJobDraft(
  job: Pick<BindingJobDoc, "_id" | "projectId" | "name">,
  filePath: string,
): Promise<string> {
  const key = jobDraftKey(job.projectId, job._id.toString());
  try {
    await getArtifactStore().put(filePath, key, {
      appProjectId: job.projectId,
      binding: job.name,
      draft: "true",
    });
  } finally {
    await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
  return key;
}

/** What `GET …/binding-jobs/<id>` answers. */
export function serializeBindingJob(job: BindingJobDoc) {
  return {
    jobId: job._id.toString(),
    binding: job.name,
    kind: job.kind,
    status: job.status,
    ...(job.status === "running" && job.progress
      ? {
          phase: job.progress.phase,
          ...(job.progress.rowsWritten !== undefined
            ? { rowsWritten: job.progress.rowsWritten }
            : {}),
          ...(job.progress.bytes !== undefined
            ? { bytes: job.progress.bytes }
            : {}),
        }
      : {}),
    ...(job.result
      ? {
          build: job.result.build,
          rowCount: job.result.rowCount,
          byteSize: job.result.byteSize,
          materializedAt: job.result.materializedAt,
        }
      : {}),
    ...(job.error ? { error: job.error, errorStatus: job.errorStatus } : {}),
  };
}

async function pruneExpiredJobs(
  projectId: string,
  now: Date,
  workspaceId?: string,
) {
  // Finished jobs only: a queued or running job's row is its poller's only
  // way to the result, and its worker's only place to put one.
  const expired = await appsMetadataRepo.listExpiredFinishedBindingJobs(
    projectId,
    now,
    200,
    workspaceId,
  );
  if (expired.length === 0) return;
  for (const job of expired) {
    // The job's own draft object, if it ever wrote one — never the app's
    // artifact a committed build points at.
    const own = jobDraftKey(projectId, job.id);
    const key = job.result?.artifactKey;
    if (key && key !== own && key.startsWith(`apps/jobs/${projectId}/`)) {
      await deleteQuietly(key);
    }
    await deleteQuietly(own);
  }
  await appsMetadataRepo.deleteBindingJobsByIds(
    projectId,
    expired.map(job => job.id),
    workspaceId,
  );
}
