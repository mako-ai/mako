/**
 * workflows_status and workflows_run against a real (in-memory) Mongo and a
 * stand-in Hatchet: what the agent is told about live and preview code, that
 * a preview run starts the prefixed workflow, and that Hatchet's responses
 * are trimmed to what a model needs.
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { Workspace, WorkspaceMember } from "../../database/workspace-schema";
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
const requests: Array<{ method: string; path: string; body?: any }> = [];
const responses: Record<string, unknown> = {
  [`GET /api/v1/tenants/${TENANT}/workflows`]: {
    rows: [{ name: "daily-digest" }, { name: "preview_daily-digest" }],
  },
  [`GET /api/v1/tenants/${TENANT}/workflows/crons`]: {
    rows: [{ workflowName: "daily-digest", cron: "0 7 * * 1-5" }],
  },
  [`GET /api/v1/stable/tenants/${TENANT}/workflow-runs`]: {
    rows: [
      {
        metadata: { id: RUN },
        workflowName: "preview_daily-digest",
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
        actionId: "preview_daily-digest:summarize",
        displayName: "summarize-1791452596182",
        taskInsertedAt: "2026-10-08T09:43:16Z",
        status: "CANCELLED",
        errorMessage: "",
      },
      {
        metadata: { id: TASK },
        actionId: "preview_daily-digest:load",
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
    rows: Array.from({ length: 50 }, (_, i) => ({ message: `line ${i}` })),
  },
};
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const { pathname } = new URL(String(url));
  const method = init?.method ?? "GET";
  requests.push({
    method,
    path: pathname,
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
        target: { sha: SHA_A, tree: "ta" },
        live: { sha: SHA_A },
        preview: { branch: "workflow/x", sha: SHA_B, tree: "tb" },
        previewFailed: { sha: SHA_B, error: "error TS2322" },
      },
    });
    await WorkspaceMember.collection.insertMany([
      { workspaceId: id, userId: "member", role: "member" },
      { workspaceId: id, userId: "viewer", role: "viewer" },
    ]);
    const tools = createWorkflowTools({
      workspaceId: id.toString(),
      userId: "member",
    });

    // The overview separates live from preview, and never leaks the token.
    const overview = await call(tools, "workflows_status", {});
    assert.equal(overview.success, true);
    // No repository is linked to this workspace: the screen prompts for one.
    assert.equal(overview.repoLinked, false);
    assert.equal(overview.deployment.liveSha, SHA_A);
    assert.equal(overview.deployment.buildError, null);
    assert.equal(overview.preview.branch, "workflow/x");
    assert.equal(overview.preview.buildError, "error TS2322");
    assert.deepEqual(overview.workflows, [
      // No webhook yet. A preview never has one.
      { workflowId: "daily-digest", preview: false, webhookUrl: null },
      { workflowId: "daily-digest", preview: true },
    ]);
    assert.deepEqual(overview.schedules, [
      { workflowId: "daily-digest", cron: "0 7 * * 1-5" },
    ]);
    assert.deepEqual(overview.recentRuns[0], {
      runId: RUN,
      workflowId: "daily-digest",
      preview: true,
      status: "FAILED",
      startedAt: undefined,
      durationMs: 1200,
      error: "boom",
      trigger: "agent",
    });
    assert.ok(!JSON.stringify(overview).includes(TOKEN));

    // A live run starts the workflow by its name; a preview run, its copy.
    const live = await call(tools, "workflows_run", {
      workflowId: "daily-digest",
      input: { limit: 5 },
    });
    assert.deepEqual(
      [live.success, live.runId, live.preview],
      [true, RUN, false],
    );
    assert.equal(requests.at(-1)?.body.workflowName, "daily-digest");
    assert.deepEqual(requests.at(-1)?.body.input, { limit: 5 });
    assert.equal(requests.at(-1)?.body.additionalMetadata.trigger, "agent");
    await call(tools, "workflows_run", {
      workflowId: "daily-digest",
      preview: true,
    });
    assert.equal(requests.at(-1)?.body.workflowName, "preview_daily-digest");

    // One run: its steps, with long text and long logs cut down.
    const detail = await call(tools, "workflows_status", { runId: RUN });
    assert.equal(detail.run.workflowId, "daily-digest");
    assert.equal(detail.run.preview, true);
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

    // A run id is a UUID, nothing else reaches Hatchet's path.
    const before = requests.length;
    const bad = await call(tools, "workflows_status", { runId: "../tenants" });
    assert.equal(bad.success, false);
    assert.equal(requests.length, before);

    // Viewers look, they do not start runs.
    const viewer = createWorkflowTools({
      workspaceId: id.toString(),
      userId: "viewer",
    });
    assert.equal((await call(viewer, "workflows_status", {})).success, true);
    const refused = await call(viewer, "workflows_run", {
      workflowId: "daily-digest",
    });
    assert.equal(refused.success, false);
    assert.equal(requests.length, before + 3, "no run was started");

    // A webhook is added per workflow, and a viewer neither adds nor sees one.
    const webhook = { workflowId: "daily-digest", enabled: true };
    assert.equal(
      (await call(viewer, "workflows_webhook", webhook)).success,
      false,
    );
    const added = await call(tools, "workflows_webhook", webhook);
    assert.match(
      added.webhookUrl,
      /\/api\/workflows\/hooks\/.+\/daily-digest\/[0-9a-f]{48}$/,
    );
    const isLive = (w: { preview: boolean }) => !w.preview;
    assert.equal(
      (await call(tools, "workflows_status", {})).workflows.find(isLive)
        .webhookUrl,
      added.webhookUrl,
    );
    assert.equal(
      "webhookUrl" in
        (await call(viewer, "workflows_status", {})).workflows.find(isLive),
      false,
    );
    const removed = await call(tools, "workflows_webhook", {
      ...webhook,
      enabled: false,
    });
    assert.equal(removed.webhookUrl, null);
    assert.equal(
      (
        await call(tools, "workflows_webhook", {
          workflowId: "preview_daily-digest",
          enabled: true,
        })
      ).success,
      false,
    );

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
