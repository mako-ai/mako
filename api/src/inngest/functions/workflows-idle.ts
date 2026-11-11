/**
 * Every minute: wake the workflow workers Hatchet has work for, and put to
 * sleep the ones idle long enough (workflows/idle.ts). One sweep at a time,
 * so two never scale the same worker in opposite directions.
 */
import { inngest } from "../client";
import { reconcileIdleWorkers } from "../../workflows/idle";
import { isGkeWorkerConfigured } from "../../workflows/kube";

export const workflowsIdleFunction = inngest.createFunction(
  {
    id: "workflows-idle",
    name: "Workflows: sleep idle workers, wake needed ones",
    concurrency: { limit: 1 },
    retries: 0,
    triggers: { cron: "* * * * *" },
  },
  async ({ step }) => {
    if (!isGkeWorkerConfigured()) return { skipped: "no gke workers" };
    return step.run("reconcile", () => reconcileIdleWorkers());
  },
);
