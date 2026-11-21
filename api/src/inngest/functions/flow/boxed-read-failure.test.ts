import assert from "node:assert/strict";
import { test } from "node:test";
import { StepError } from "inngest";
import { Types } from "mongoose";
import { boxedReadError } from "../../../connectors/workspace/boxed-read-failure";
import { Flow } from "../../../database/workspace-schema";
import { handleFlowRunFailure } from "./failure";

void test("terminal boxed read records only the catalog entity and rethrows the original error", async t => {
  const executionId = new Types.ObjectId().toString();
  const executionUpdates: unknown[] = [];
  const flowUpdates: unknown[] = [];
  const logs: unknown[] = [];
  t.mock.method(Flow.db, "collection", (name: string) => {
    assert.equal(name, "flow_executions");
    return {
      findOne: async () => ({ startedAt: new Date() }),
      updateOne: async (filter: { _id: Types.ObjectId }, update: unknown) => {
        assert.equal(filter._id.toString(), executionId);
        executionUpdates.push(update);
      },
    };
  });
  t.mock.method(
    Flow,
    "findByIdAndUpdate",
    async (_id: unknown, update: unknown) => {
      flowUpdates.push(update);
    },
  );
  const capture = (_message: string, payload: unknown) => logs.push(payload);
  const ctx = {
    step: { run: async (_name: string, fn: () => Promise<void>) => fn() },
    logger: { error: capture, info: capture },
    flowId: new Types.ObjectId().toString(),
    data: { backfill: false },
    state: { executionId },
    appendExecutionLog: async (
      _level: string,
      message: string,
      payload: unknown,
    ) => capture(message, payload),
  } as unknown as Parameters<typeof handleFlowRunFailure>[0];
  const boxed = boxedReadError(
    "request canceled with synthetic provider payload",
    "ads",
    ["ads"],
  );
  const terminal = new StepError("invoke", {
    name: boxed.name,
    message: boxed.message,
    cause: boxed.cause,
  });
  await assert.rejects(
    handleFlowRunFailure(ctx, terminal),
    error => error === terminal,
  );
  assert.equal(executionUpdates.length, 1);
  const { $set } = executionUpdates[0] as { $set: Record<string, unknown> };
  assert.equal($set.status, "failed");
  assert.deepEqual($set.error, {
    message: "Boxed connector read failed",
    readFailure: { entity: "ads" },
  });
  assert.deepEqual(flowUpdates, [{ lastError: "Boxed connector read failed" }]);
  assert.doesNotMatch(
    JSON.stringify([executionUpdates, flowUpdates, logs]),
    /request canceled|synthetic provider payload/,
  );
});
