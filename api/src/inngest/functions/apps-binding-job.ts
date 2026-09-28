/**
 * Runs an asynchronous binding build (apps/binding-jobs.ts). Inngest calls
 * the Cloud Run URL directly, so a build may take as long as the query needs
 * — unlike a request through the edge, which is cut at 100 s.
 */
import { inngest } from "../client";
import {
  createBindingJob,
  getBindingJobById,
  sweepStaleBindingJobs,
  type BindingJobDoc,
} from "../../apps/binding-jobs";
import { runBindingJob } from "../../apps/binding-job-runner";
import { APPS_BINDING_BUILD_CONCURRENCY } from "./apps-binding-concurrency";

export const APPS_BINDING_JOB_EVENT = "apps/binding.job";

export interface BindingJobEventData {
  jobId: string;
  workspaceId: string;
  /** `${projectId}:${binding}` — one build per binding at a time. */
  key: string;
}

export const appsBindingJobFunction = inngest.createFunction(
  {
    id: "apps-binding-job",
    name: "Apps Binding Build (async)",
    // One budget with the scheduled builds (see the constant).
    concurrency: APPS_BINDING_BUILD_CONCURRENCY,
    // The job records the failure for the caller polling it; re-running a
    // broken warehouse query would only bill it twice.
    retries: 0,
    triggers: { event: APPS_BINDING_JOB_EVENT },
  },
  async ({ event, step }) => {
    const { jobId } = event.data as BindingJobEventData;
    return step.run("build", async () => {
      const job = await getBindingJobById(jobId);
      if (!job) return { skipped: "job-gone" as const };
      if (job.status !== "queued") return { skipped: job.status };
      return { status: await runBindingJob(job) };
    });
  },
);

/** Record a job and hand it to the worker. Returns the queued job. */
export async function enqueueBindingJob(
  input: Parameters<typeof createBindingJob>[0],
): Promise<BindingJobDoc> {
  const job = await createBindingJob(input);
  const data: BindingJobEventData = {
    jobId: job._id.toString(),
    workspaceId: job.workspaceId,
    key: `${job.projectId}:${job.name}`,
  };
  await inngest.send({ name: APPS_BINDING_JOB_EVENT, data });
  return job;
}

/**
 * Fails running jobs whose worker went silent past the lease, for jobs nobody
 * is polling (a poll fails its own job on the spot — see expireIfStale).
 */
export const appsBindingJobSweeperFunction = inngest.createFunction(
  {
    id: "apps-binding-job-sweeper",
    name: "Sweep Stale Apps Binding Builds",
    retries: 0,
    concurrency: { limit: 1 },
    triggers: { cron: "*/5 * * * *" },
  },
  async ({ step }) =>
    step.run("sweep", async () => ({ failed: await sweepStaleBindingJobs() })),
);
