/**
 * The workflow tools against a real (in-memory) Mongo and a stand-in
 * Hatchet: what the agent is told about what is deployed, that a run starts
 * the workflow, that the switches are an admin's, and that Hatchet's
 * responses are trimmed to what a model needs.
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { Workspace, WorkspaceMember } from "../../database/workspace-schema";
import { encryptString } from "../../services/crypto.service";
import {
  createSandboxRun,
  finishSandboxRun,
} from "../../workflows/sandbox-runs";
import { createWorkflowTools } from "./workflow-tools";

const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";
const TASK = "33333333-3333-3333-3333-333333333333";
const TOKEN = `x.${Buffer.from(
  JSON.stringify({ sub: TENANT, server_url: "https://hatchet.test" }),
).toString("base64url")}.y`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

type Result = Record<string, any>;
const call = (
  tools: ReturnType<typeof createWorkflowTools>,
  name: string,
  input: object,
): Promise<Result> =>
  (
    tools[name] as unknown as {
      execute: (i: object, o: object) => Promise<Result>;
    }
  ).execute(input, { toolCallId: "t", messages: [] });

/** What the stand-in Hatchet was asked. */
const requests: Array<{
  method: string;
  path: string;
  limit?: string;
  body?: any;
}> = [];
const responses: Record<string, unknown> = {
  [`GET /api/v1/tenants/${TENANT}/workflows`]: {
    rows: [{ name: "daily-digest" }, { name: "weekly-report" }],
  },
  [`GET /api/v1/tenants/${TENANT}/workflows/crons`]: {
    rows: [{ workflowName: "daily-digest", cron: "0 7 * * 1-5" }],
  },
  [`GET /api/v1/stable/tenants/${TENANT}/workflow-runs`]: {
    rows: [
      {
        metadata: { id: RUN },
        workflowName: "daily-digest",
        status: "FAILED",
        duration: 1200,
        errorMessage: "boom",
        additionalMetadata: { trigger: "agent", triggeredBy: "member" },
      },
    ],
  },
  [`POST /api/v1/stable/tenants/${TENANT}/workflow-runs/trigger`]: {
    run: { metadata: { id: RUN } },
  },
  [`GET /api/v1/stable/workflow-runs/${RUN}`]: {
    run: { metadata: { id: RUN }, status: "FAILED", input: { limit: 5 } },
    // As Hatchet returns them: in no order, the error as JSON.
    tasks: [
      {
        metadata: { id: "44444444-4444-4444-4444-444444444444" },
        actionId: "daily-digest:summarize",
        displayName: "summarize-1791452596182",
        taskInsertedAt: "2026-10-08T09:43:16Z",
        status: "CANCELLED",
        errorMessage: "",
      },
      {
        metadata: { id: TASK },
        actionId: "daily-digest:load",
        displayName: "load-1791452586494",
        taskInsertedAt: "2026-10-08T09:43:06Z",
        status: "FAILED",
        errorMessage: JSON.stringify({
          message: "connection refused\n",
          stack: `Error: connection refused\n    at load (workflow.ts:12:9)\n${"    at x\n".repeat(900)}`,
        }),
      },
    ],
  },
  [`GET /api/v1/stable/tasks/${TASK}/logs`]: {
    // In no order, as Hatchet lists them: newest first here.
    rows: Array.from({ length: 50 }, (_, i) => ({
      message: `line ${i}`,
      // Fractions of a second at varying lengths, as Hatchet writes them:
      // "…:00.9Z" sorts after "…:00.95Z" as text, before it as time.
      createdAt: `2026-10-08T09:43:${String(Math.floor(i / 2)).padStart(2, "0")}.${i % 2 ? "95" : "9"}Z`,
    })).reverse(),
  },
};
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const { pathname } = new URL(String(url));
  const method = init?.method ?? "GET";
  requests.push({
    method,
    path: pathname,
    limit: new URL(String(url)).searchParams.get("limit") ?? undefined,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });
  const body = responses[`${method} ${pathname}`];
  return new Response(JSON.stringify(body ?? { error: "not found" }), {
    status: body ? 200 : 404,
  });
}) as typeof fetch;

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  process.env.HATCHET_CLIENT_TOKEN = TOKEN;
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  try {
    const id = new Types.ObjectId();
    await Workspace.collection.insertOne({
      _id: id,
      name: "t",
      slug: `t-${id}`,
      createdBy: "tester",
      workflows: {
        hatchetToken: encryptString(TOKEN),
        live: {
          sha: SHA_B,
          tree: "tb",
          names: ["daily-digest", "weekly-report"],
          running: { sha: SHA_A },
          failed: { sha: SHA_B, error: "error TS2322" },
        },
        active: ["weekly-report"],
      },
    });
    await WorkspaceMember.collection.insertMany([
      { workspaceId: id, userId: "admin", role: "admin" },
      { workspaceId: id, userId: "member", role: "member" },
      { workspaceId: id, userId: "viewer", role: "viewer" },
    ]);
    const as = (userId: string) =>
      createWorkflowTools({ workspaceId: id.toString(), userId });
    const admin = as("admin");
    const tools = as("member");

    // The overview: what runs, what was wanted and did not build, which
    // workflows are active. It never leaks the token.
    const overview = await call(tools, "workflows_status", {});
    assert.equal(overview.success, true);
    // No repository is linked to this workspace: the screen prompts for one.
    assert.equal(overview.repoLinked, false);
    assert.equal(overview.deployment.liveSha, SHA_A);
    assert.equal(overview.deployment.targetSha, SHA_B);
    assert.equal(overview.deployment.buildError, "error TS2322");
    assert.deepEqual(overview.workflows, [
      // A member is not shown webhooks; an admin sees `webhookUrl: null`.
      { workflowId: "daily-digest", active: false },
      { workflowId: "weekly-report", active: true },
    ]);
    assert.equal(overview.mayChange, false);
    assert.equal(
      (await call(admin, "workflows_status", {})).workflows[0].webhookUrl,
      null,
    );
    assert.deepEqual(overview.schedules, [
      { workflowId: "daily-digest", cron: "0 7 * * 1-5" },
    ]);
    assert.deepEqual(overview.recentRuns[0], {
      runId: RUN,
      workflowId: "daily-digest",
      status: "FAILED",
      startedAt: undefined,
      durationMs: 1200,
      error: "boom",
      trigger: "agent",
    });
    assert.ok(!JSON.stringify(overview).includes(TOKEN));

    // A run starts the workflow by its name, active or not.
    const live = await call(tools, "workflows_run", {
      workflowId: "daily-digest",
      input: { limit: 5 },
    });
    assert.deepEqual([live.success, live.runId], [true, RUN]);
    assert.equal(requests.at(-1)?.body.workflowName, "daily-digest");
    assert.deepEqual(requests.at(-1)?.body.input, { limit: 5 });
    assert.equal(requests.at(-1)?.body.additionalMetadata.trigger, "agent");

    // One run: its steps, with long text and long logs cut down.
    const detail = await call(tools, "workflows_status", { runId: RUN });
    assert.equal(detail.run.workflowId, "daily-digest");
    assert.equal(detail.run.input, '{"limit":5}');
    const [step, next] = detail.run.steps;
    assert.equal(step.step, "load");
    assert.deepEqual(
      [next.step, next.status, next.error],
      ["summarize", "CANCELLED", undefined],
    );
    assert.match(step.error, /^connection refused\n {4}at load \(workflow\.ts/);
    assert.ok(step.error.length < 200, "the stack is cut to its first lines");
    assert.equal(step.logs.length, 20);
    assert.equal(step.logs.at(-1), "line 49");
    assert.equal(step.logLinesOmitted, 30);

    // `full`: every log line and the whole stack.
    const whole = await call(tools, "workflows_status", {
      runId: RUN,
      full: true,
    });
    const [fullStep] = whole.run.steps;
    assert.equal(fullStep.logs.length, 50);
    assert.ok(
      requests.some(
        r =>
          r.path === `/api/v1/stable/tasks/${TASK}/logs` && r.limit === "10000",
      ),
      "asks Hatchet for every line, not its default 50",
    );
    assert.deepEqual(
      [fullStep.logs[0], fullStep.logs.at(-1)],
      ["line 0", "line 49"],
    );
    assert.equal(fullStep.logLinesOmitted, undefined);
    assert.ok(fullStep.error.length > 5000, "the whole stack");
    // An ended run answers at once, wait or not, and is not `running`.
    const waited = await call(tools, "workflows_status", {
      runId: RUN,
      wait: 30,
    });
    assert.equal(waited.running, undefined);

    // A sandbox run is the starter's: among their recent runs, readable by
    // its id, and nobody else's.
    const sandboxRunId = await createSandboxRun(
      id.toString(),
      "member",
      "daily-digest",
      { limit: 1 },
    );
    await finishSandboxRun(sandboxRunId, {
      result: { buildError: "error TS2304: Cannot find name 'x'." },
    });
    const mine = await call(tools, "workflows_status", {});
    const listed = mine.recentRuns.find(
      (r: { runId: string }) => r.runId === sandboxRunId,
    );
    assert.deepEqual(
      [listed?.sandbox, listed?.status, listed?.trigger],
      [true, "FAILED", "sandbox"],
    );
    assert.equal(
      (await call(admin, "workflows_status", {})).recentRuns.some(
        (r: { runId: string }) => r.runId === sandboxRunId,
      ),
      false,
    );
    const read = await call(tools, "workflows_status", {
      runId: sandboxRunId,
    });
    assert.equal(read.run.buildError, "error TS2304: Cannot find name 'x'.");
    assert.equal(read.run.input, '{"limit":1}');
    const notTheirs = await call(admin, "workflows_status", {
      runId: sandboxRunId,
    });
    assert.deepEqual(
      [notTheirs.success, notTheirs.error],
      [false, "Run not found"],
    );

    // Without a runId, `wait` waits for the deploy: this one has a build
    // error, so it has settled and answers at once.
    const started = Date.now();
    const deploy = await call(tools, "workflows_status", { wait: 30 });
    assert.ok(Date.now() - started < 5000);
    assert.equal(deploy.deploying, undefined);

    // A run id is a UUID, nothing else reaches Hatchet's path.
    const before = requests.length;
    const bad = await call(tools, "workflows_status", { runId: "../tenants" });
    assert.equal(bad.success, false);
    assert.equal(requests.length, before);

    // Viewers look, they do not start runs.
    const viewer = as("viewer");
    assert.equal((await call(viewer, "workflows_status", {})).success, true);
    const refused = await call(viewer, "workflows_run", {
      workflowId: "daily-digest",
    });
    assert.equal(refused.success, false);
    assert.equal(requests.length, before + 2, "no run was started");

    // The triggers are an admin's: active on and off, and never a name that
    // is not one.
    const activeOf = async () =>
      (await Workspace.findById(id).select("workflows.active").lean())
        ?.workflows?.active;
    const triggers = (who: typeof tools, change: object) =>
      call(who, "workflows_triggers", {
        workflowId: "daily-digest",
        ...change,
      });
    assert.equal((await triggers(tools, { active: true })).success, false);
    const on = await triggers(admin, { active: true });
    assert.deepEqual(
      [on.success, on.active, "webhookUrl" in on],
      [true, true, false],
    );
    assert.deepEqual(await activeOf(), ["weekly-report", "daily-digest"]);
    await triggers(admin, { active: false });
    assert.deepEqual(await activeOf(), ["weekly-report"]);
    assert.equal(
      (
        await call(admin, "workflows_triggers", {
          workflowId: "../x",
          active: true,
        })
      ).success,
      false,
    );

    // A webhook is added per workflow by an admin; a member neither adds
    // nor sees one.
    assert.equal((await triggers(tools, { webhook: true })).success, false);
    const added = await triggers(admin, { webhook: true });
    assert.match(
      added.webhookUrl,
      /\/api\/workflows\/hooks\/.+\/daily-digest\/[0-9a-f]{48}$/,
    );
    const digestOf = async (who: typeof tools) =>
      (await call(who, "workflows_status", {})).workflows.find(
        (w: { workflowId: string }) => w.workflowId === "daily-digest",
      );
    assert.equal((await digestOf(admin)).webhookUrl, added.webhookUrl);
    assert.equal("webhookUrl" in (await digestOf(tools)), false);
    assert.equal((await triggers(admin, { webhook: false })).webhookUrl, null);
    assert.deepEqual(await activeOf(), ["weekly-report"], "active untouched");

    // A Hatchet failure is an answer, not a throw.
    const missing = await call(tools, "workflows_run", { workflowId: "nope" });
    assert.equal(missing.success, true); // the stand-in accepts any name
    delete responses[
      `POST /api/v1/stable/tenants/${TENANT}/workflow-runs/trigger`
    ];
    const failed = await call(tools, "workflows_run", { workflowId: "nope" });
    assert.equal(failed.success, false);
    assert.match(failed.error, /404/);

    console.log("workflow tools tests passed");
  } finally {
    delete process.env.HATCHET_CLIENT_TOKEN;
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
