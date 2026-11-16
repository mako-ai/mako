/**
 * Every minute: give each workspace's workflow worker the pods its work
 * needs, none when it has been idle long enough (workflows/scale.ts). One
 * sweep at a time, so two never scale the same worker in opposite
 * directions.
 */
import { inngest } from "../client";
import { isAutoscaled, reconcileWorkers } from "../../workflows/scale";

export const workflowsScaleFunction = inngest.createFunction(
  {
    id: "workflows-scale",
    name: "Workflows: size workers to their work",
    concurrency: { limit: 1 },
    retries: 0,
    triggers: { cron: "* * * * *" },
  },
  async ({ step }) => {
    if (!isAutoscaled()) return { skipped: "WORKFLOWS_AUTOSCALE is not on" };
    return step.run("reconcile", () => reconcileWorkers());
  },
);
