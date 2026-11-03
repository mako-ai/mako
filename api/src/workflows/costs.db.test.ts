/**
 * A run's AI cost and a workflow's (costs.ts), summed from the usage records
 * the AI proxy writes with the run and step they came from.
 *
 * Run with: pnpm --filter api exec tsx src/workflows/costs.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { LlmUsage } from "../database/schema";
import { readRunCosts, readWorkflowCost } from "./costs";

const RUN_A = "11111111-1111-1111-1111-111111111111";
const RUN_B = "22222222-2222-2222-2222-222222222222";

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  try {
    const workspaceId = new Types.ObjectId();
    const other = new Types.ObjectId();
    const call = (
      ws: Types.ObjectId,
      costUsd: number,
      run?: { runId: string; step: string; backfilled?: boolean },
      workflowId = "classifier",
    ) => ({
      workspaceId: ws,
      userId: "worker",
      invocationType: "workflow" as const,
      modelId: "anthropic/claude-haiku-5.5",
      inputTokens: 1000,
      outputTokens: 50,
      totalTokens: 1050,
      costUsd,
      ...(run ? { workflowRun: { workflowId, ...run } } : {}),
    });
    await LlmUsage.create([
      call(workspaceId, 0.1, { runId: RUN_A, step: "label" }),
      call(workspaceId, 0.2, { runId: RUN_A, step: "label" }),
      call(workspaceId, 0.05, { runId: RUN_A, step: "report" }),
      call(workspaceId, 0.3, { runId: RUN_B, step: "label", backfilled: true }),
      // Not a run's: a chat turn, and another workspace's run.
      call(workspaceId, 9),
      call(other, 9, { runId: RUN_A, step: "label" }),
      // Another workflow in the same workspace.
      call(workspaceId, 1, { runId: "33", step: "x" }, "other-flow"),
    ]);

    const costs = await readRunCosts(String(workspaceId), [
      RUN_A,
      RUN_B,
      "44444444-4444-4444-4444-444444444444",
    ]);
    assert.deepEqual(Object.keys(costs).sort(), [RUN_A, RUN_B]);
    assert.equal(costs[RUN_A].costUsd, 0.35);
    assert.equal(costs[RUN_A].calls, 3);
    assert.equal(costs[RUN_A].inputTokens, 3000);
    assert.deepEqual(costs[RUN_A].steps.label, {
      costUsd: 0.3,
      inputTokens: 2000,
      outputTokens: 100,
      calls: 2,
    });
    assert.equal(costs[RUN_A].steps.report.costUsd, 0.05);
    assert.equal(costs[RUN_A].backfilled, undefined);
    assert.equal(costs[RUN_B].backfilled, true);
    assert.deepEqual(await readRunCosts(String(workspaceId), []), {});

    const workflow = await readWorkflowCost(
      String(workspaceId),
      "classifier",
      30,
    );
    assert.equal(workflow.costUsd, 0.65);
    assert.equal(workflow.runs, 2);
    assert.equal(workflow.byDay.length, 1);
    assert.equal(workflow.byDay[0].runs, 2);
    assert.equal(
      (await readWorkflowCost(String(workspaceId), "unknown", 30)).costUsd,
      0,
    );
    console.info("workflow costs tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
