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
import mongoose, { Schema, Types } from "mongoose";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";

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
  request: BindingJobRequest;
  status: BindingJobStatus;
  result?: BindingJobResult | null;
  error?: string | null;
  /** HTTP status the synchronous route would have answered the failure with. */
  errorStatus?: number | null;
  /** Last proof of life from the worker (running jobs). */
  heartbeatAt?: Date | null;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const AppBindingJob =
  mongoose.models.AppBindingJob ??
  mongoose.model(
    "AppBindingJob",
    new Schema(
      {
        workspaceId: { type: String, required: true },
        projectId: { type: String, required: true },
        name: { type: String, required: true },
        kind: { type: String, enum: ["materialize", "dev-build"] },
        actorId: { type: String, required: true },
        userId: { type: String },
        canWrite: { type: Boolean, default: false },
        request: { type: Schema.Types.Mixed, default: {} },
        status: {
          type: String,
          enum: ["queued", "running", "ready", "error"],
          default: "queued",
        },
        result: { type: Schema.Types.Mixed },
        error: { type: String },
        errorStatus: { type: Number },
        heartbeatAt: { type: Date },
        expiresAt: { type: Date, required: true },
      },
      { collection: "app_binding_jobs", timestamps: true },
    )
      .index({ projectId: 1, expiresAt: 1 })
      .index({ status: 1, heartbeatAt: 1 }),
  );

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
  await pruneExpiredJobs(input.projectId, now);
  const doc = await AppBindingJob.create({
    ...input,
    status: "queued",
    expiresAt: new Date(now.getTime() + JOB_TTL_MS),
  });
  return doc.toObject() as BindingJobDoc;
}

/** The job, if it belongs to this project and is still live. */
export async function getBindingJob(
  projectId: string,
  jobId: string,
  now: Date = new Date(),
): Promise<BindingJobDoc | null> {
  if (!Types.ObjectId.isValid(jobId)) return null;
  const doc = (await AppBindingJob.findOne({
    _id: new Types.ObjectId(jobId),
    projectId,
  }).lean()) as BindingJobDoc | null;
  if (!doc) return null;
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
  job: Pick<BindingJobDoc, "_id" | "projectId" | "heartbeatAt">,
  now: Date,
): Promise<BindingJobDoc | null> {
  // Conditional on the heartbeat still being the stale one: a worker that
  // just checked in keeps its job.
  const updated = (await AppBindingJob.findOneAndUpdate(
    {
      _id: job._id,
      status: "running",
      $or: [
        { heartbeatAt: { $lte: new Date(now.getTime() - JOB_LEASE_MS) } },
        { heartbeatAt: null },
      ],
    },
    {
      $set: {
        status: "error",
        error: STALE_ERROR,
        errorStatus: 502,
        expiresAt: new Date(now.getTime() + JOB_TTL_MS),
      },
    },
    { new: true },
  ).lean()) as BindingJobDoc | null;
  if (updated) {
    // A worker that died between uploading its draft and recording it
    // leaves the object behind; nothing will ever point at it.
    await deleteQuietly(jobDraftKey(job.projectId, job._id.toString()));
  }
  return updated;
}

/**
 * The periodic sweep behind expireIfStale, for jobs nobody is polling any
 * more. Returns how many were failed.
 */
export async function sweepStaleBindingJobs(
  now: Date = new Date(),
): Promise<number> {
  const stale = (await AppBindingJob.find({
    status: "running",
    $or: [
      { heartbeatAt: { $lte: new Date(now.getTime() - JOB_LEASE_MS) } },
      { heartbeatAt: null },
    ],
  })
    .select("_id projectId heartbeatAt")
    .limit(500)
    .lean()) as unknown as Array<
    Pick<BindingJobDoc, "_id" | "projectId" | "heartbeatAt">
  >;
  let failed = 0;
  for (const job of stale) {
    if (await failStaleJob(job, now)) failed++;
  }
  return failed;
}

/** The worker is alive: extend the lease (and the row's life). */
export async function heartbeatBindingJob(
  jobId: string,
  now: Date = new Date(),
): Promise<void> {
  await AppBindingJob.updateOne(
    { _id: new Types.ObjectId(jobId), status: "running" },
    {
      $set: {
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + JOB_TTL_MS),
      },
    },
  );
}

async function deleteQuietly(key: string): Promise<void> {
  try {
    await getDashboardArtifactStore().delete(key);
  } catch {
    // Missing already, or the store is unreachable: the prune retries.
  }
}

/** The worker's read: by id alone (the event carries only the id). */
export async function getBindingJobById(
  jobId: string,
): Promise<BindingJobDoc | null> {
  if (!Types.ObjectId.isValid(jobId)) return null;
  return (await AppBindingJob.findById(jobId).lean()) as BindingJobDoc | null;
}

export async function markBindingJob(
  jobId: string,
  update:
    | { status: "running" }
    | { status: "ready"; result: BindingJobResult }
    | { status: "error"; error: string; errorStatus: number },
): Promise<void> {
  const now = new Date();
  await AppBindingJob.updateOne(
    { _id: new Types.ObjectId(jobId) },
    {
      $set: {
        ...update,
        // Every state change extends the row: a result stays fetchable for
        // a full TTL after it lands, and a running job starts its lease.
        expiresAt: new Date(now.getTime() + JOB_TTL_MS),
        ...(update.status === "running" ? { heartbeatAt: now } : {}),
      },
    },
  );
}

/** Keep a draft build's local file as this job's result (the file is removed). */
export async function storeJobDraft(
  job: Pick<BindingJobDoc, "_id" | "projectId" | "name">,
  filePath: string,
): Promise<string> {
  const key = jobDraftKey(job.projectId, job._id.toString());
  try {
    await getDashboardArtifactStore().put(filePath, key, {
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

async function pruneExpiredJobs(projectId: string, now: Date) {
  // Finished jobs only: a queued or running job's row is its poller's only
  // way to the result, and its worker's only place to put one.
  const expired = (await AppBindingJob.find({
    projectId,
    status: { $in: ["ready", "error"] },
    expiresAt: { $lte: now },
  })
    .select("_id result")
    .limit(200)
    .lean()) as unknown as Array<Pick<BindingJobDoc, "_id" | "result">>;
  if (expired.length === 0) return;
  for (const job of expired) {
    // The job's own draft object, if it ever wrote one — never the app's
    // artifact a committed build points at.
    const own = jobDraftKey(projectId, job._id.toString());
    const key = job.result?.artifactKey;
    if (key && key !== own && key.startsWith(`apps/jobs/${projectId}/`)) {
      await deleteQuietly(key);
    }
    await deleteQuietly(own);
  }
  await AppBindingJob.deleteMany({
    _id: { $in: expired.map(job => job._id) },
  });
}
