/**
 * The worker half of binding-jobs.ts: run one queued job to completion and
 * record what the synchronous route would have answered.
 */
import fs from "node:fs/promises";
import type { IAppProject } from "../database/workspace-schema";
import { resolveProjectRef } from "./worktree.service";
import { materializeAppBinding } from "./bindings.service";
import { DevBuildError, planDevBuild } from "./binding-dev-build";
import {
  JOB_HEARTBEAT_MS,
  heartbeatBindingJob,
  markBindingJob,
  storeJobDraft,
  type BindingJobDoc,
  type BindingJobResult,
} from "./binding-jobs";
import { loggers } from "../logging";

const logger = loggers.api("apps");

/** Swappable for tests; production wires the real services. */
export interface BindingJobRunnerDeps {
  resolveProject: (
    workspaceId: string,
    projectId: string,
  ) => Promise<IAppProject | null>;
  materialize: typeof materializeAppBinding;
  plan: typeof planDevBuild;
  mark: typeof markBindingJob;
  storeDraft: typeof storeJobDraft;
  heartbeat: (jobId: string) => Promise<void>;
  heartbeatMs: number;
}

const defaultDeps: BindingJobRunnerDeps = {
  resolveProject: (workspaceId, projectId) =>
    resolveProjectRef(workspaceId, projectId),
  materialize: materializeAppBinding,
  plan: planDevBuild,
  mark: markBindingJob,
  storeDraft: storeJobDraft,
  heartbeat: jobId => heartbeatBindingJob(jobId),
  heartbeatMs: JOB_HEARTBEAT_MS,
};

export async function runBindingJob(
  job: BindingJobDoc,
  deps: BindingJobRunnerDeps = defaultDeps,
): Promise<BindingJobDoc["status"]> {
  const jobId = job._id.toString();
  const project = await deps.resolveProject(job.workspaceId, job.projectId);
  if (!project) {
    await deps.mark(jobId, {
      status: "error",
      error: "App not found",
      errorStatus: 404,
    });
    return "error";
  }
  await deps.mark(jobId, { status: "running" });
  // The lease: while this beats, the stale sweep leaves the job alone; if
  // the process dies, the beat stops and pollers get a terminal error.
  const beat = setInterval(() => {
    deps.heartbeat(jobId).catch(() => undefined);
  }, deps.heartbeatMs);
  try {
    const result = await build(job, project, deps);
    await deps.mark(jobId, { status: "ready", result });
    return "ready";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Apps binding job failed", {
      jobId,
      projectId: job.projectId,
      binding: job.name,
      kind: job.kind,
      error: message,
    });
    await deps.mark(jobId, {
      status: "error",
      error: message,
      errorStatus: error instanceof DevBuildError ? error.status : 502,
    });
    return "error";
  } finally {
    clearInterval(beat);
  }
}

async function build(
  job: BindingJobDoc,
  project: IAppProject,
  deps: BindingJobRunnerDeps,
): Promise<BindingJobResult> {
  if (job.kind === "materialize") {
    const result = await deps.materialize(project, job.name, job.actorId);
    return {
      artifactKey: result.artifactKey,
      build: "materialized",
      rowCount: result.rowCount,
      byteSize: result.byteSize,
      materializedAt: result.materializedAt.toISOString(),
    };
  }
  // Re-planned, not replayed: the same checks and the same committed-vs-
  // draft decision the synchronous route makes, at the time it runs.
  const plan = await deps.plan({
    project,
    name: job.name,
    actorId: job.actorId,
    userId: job.userId,
    canWrite: job.canWrite,
    source: job.request.source ?? "",
    dbtEnvironment: job.request.dbtEnvironment,
    dbtDefer: job.request.dbtDefer,
    refresh: job.request.refresh,
  });
  if (plan.kind === "artifact") {
    return { artifactKey: plan.artifactKey, build: "artifact" };
  }
  const built = await plan.run();
  const common = {
    rowCount: built.rowCount,
    byteSize: built.byteSize,
    materializedAt: built.builtAt.toISOString(),
  };
  if (built.kind === "materialized" && built.artifactKey) {
    // Stored as the app's artifact already; the local copy is not needed.
    await fs.rm(built.filePath, { force: true }).catch(() => undefined);
    return { artifactKey: built.artifactKey, build: "materialized", ...common };
  }
  const artifactKey = await deps.storeDraft(job, built.filePath);
  return { artifactKey, build: "draft", ...common };
}
