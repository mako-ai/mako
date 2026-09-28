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
import { loggers } from "../logging";

const logger = loggers.api("apps");

/** A finished job's result stays fetchable this long. */
export const JOB_TTL_MS = 60 * 60_000;

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
        expiresAt: { type: Date, required: true },
      },
      { collection: "app_binding_jobs", timestamps: true },
    ).index({ projectId: 1, expiresAt: 1 }),
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
  if (!doc || doc.expiresAt <= now) return null;
  return doc;
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
  await AppBindingJob.updateOne(
    { _id: new Types.ObjectId(jobId) },
    {
      $set: {
        ...update,
        // The result stays fetchable for a full TTL after it lands.
        ...(update.status !== "running"
          ? { expiresAt: new Date(Date.now() + JOB_TTL_MS) }
          : {}),
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
  const expired = (await AppBindingJob.find({
    projectId,
    expiresAt: { $lte: now },
  })
    .select("_id result")
    .limit(200)
    .lean()) as unknown as Array<Pick<BindingJobDoc, "_id" | "result">>;
  if (expired.length === 0) return;
  const store = getDashboardArtifactStore();
  for (const job of expired) {
    const key = job.result?.artifactKey;
    // Only job-owned drafts; a committed build's artifact is the app's.
    if (!key || !key.startsWith(`apps/jobs/${projectId}/`)) continue;
    try {
      await store.delete(key);
    } catch (error) {
      logger.warn("Could not delete expired binding job artifact", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await AppBindingJob.deleteMany({
    _id: { $in: expired.map(job => job._id) },
  });
}
