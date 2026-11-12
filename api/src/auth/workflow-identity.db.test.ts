/**
 * Who a workflow-runtime request acts as, through the real auth middleware
 * and an in-memory Mongo. Deployed workflows share one pod, so nothing a
 * request says about itself (X-Mako-Workflow) is believed: a deployed
 * workflow acts as itself only with a workflow pass (workflows/pass.ts),
 * and only while the run it names is an executing run of that workflow.
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Hono } from "hono";

import { WORKFLOW_WORKER, actingPrincipal } from "../access/connection-writes";
import { User } from "../database/schema";
import { Workspace } from "../database/workspace-schema";
import { getRequestContext, requestContextStorage } from "../logging/context";
import { encryptString } from "../services/crypto.service";
import { keyIdOf, mintPass } from "../workflows/pass";
import { setFirstReadRetryForTests } from "../workflows/runs";
import {
  WORKER_KEY_SCOPES,
  sandboxKeyName,
  workerKeyName,
} from "../workflows/worker-key";
import { hashApiKey } from "./api-key.middleware";
import { unifiedAuthMiddleware } from "./unified-auth.middleware";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const WORKER_KEY = "revops_deployed_worker_key_test";
const SANDBOX_KEY = "revops_member_sandbox_key_test";
const ORDINARY_KEY = "revops_ordinary_mcp_key_test__";
const TENANT = "11111111-1111-1111-1111-111111111111";
const HATCHET_TOKEN = `x.${Buffer.from(
  JSON.stringify({ sub: TENANT, server_url: "https://hatchet.example" }),
).toString("base64url")}.y`;
const BILLING_RUN = "0f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const OTHER_RUN = "1f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const DONE_RUN = "2f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
/** A run Hatchet first answers without its tasks, as right after it starts. */
const YOUNG_RUN = "3f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
let youngReadsWithoutTasks = 0;
const RUNS: Record<string, { workflow: string; status: string }> = {
  [BILLING_RUN]: { workflow: "billing-sync", status: "RUNNING" },
  [OTHER_RUN]: { workflow: "other-flow", status: "RUNNING" },
  [DONE_RUN]: { workflow: "billing-sync", status: "COMPLETED" },
  [YOUNG_RUN]: { workflow: "billing-sync", status: "RUNNING" },
};

// The MCP endpoint is where workflow code queries; answer who is acting.
const app = new Hono();
app.post("/api/mcp", unifiedAuthMiddleware, c =>
  c.json({
    principal: actingPrincipal() ?? null,
    run: getRequestContext()?.workflowRun ?? null,
  }),
);

const call = async (key: string, workflow?: string) => {
  const res = await requestContextStorage.run(
    {
      requestId: "r",
      method: "POST",
      path: "/api/mcp",
      startTime: Date.now(),
    },
    () =>
      app.request("/api/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          ...(workflow ? { "X-Mako-Workflow": workflow } : {}),
        },
      }),
  );
  const body = (await res.json()) as {
    principal?: string | null;
    run?: { runId: string } | null;
    error?: string;
  };
  return { status: res.status, ...body };
};
const principalOf = async (key: string, workflow?: string) => {
  const res = await call(key, workflow);
  assert.equal(res.status, 200, res.error);
  return res.principal;
};

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  setFirstReadRetryForTests([0, 0, 0]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!href.startsWith("https://hatchet.example/")) {
      return realFetch(input, init);
    }
    const id = href.match(/workflow-runs\/([0-9a-f-]{36})/)?.[1] ?? "";
    const run = RUNS[id];
    if (!run) return Response.json({ message: "not found" }, { status: 404 });
    const young = id === YOUNG_RUN && youngReadsWithoutTasks-- > 0;
    return Response.json({
      run: { metadata: { id }, status: run.status, additionalMetadata: {} },
      tasks: young
        ? []
        : [{ actionId: `${run.workflow}:step`, status: run.status }],
    });
  }) as typeof fetch;
  try {
    await User.create({ _id: "admin", email: "admin@example.com" });
    await User.create({ _id: "member", email: "member@example.com" });
    const key = (
      name: string,
      value: string,
      scopes: string[],
      by: string,
    ) => ({
      _id: new Types.ObjectId(),
      name,
      keyHash: hashApiKey(value),
      prefix: value.slice(0, 14),
      scopes,
      createdAt: new Date(),
      createdBy: by,
    });
    const id = new Types.ObjectId();
    await Workspace.collection.insertOne({
      _id: id,
      name: "t",
      slug: `t-${id}`,
      createdBy: "admin",
      apiKeys: [
        key(workerKeyName(), WORKER_KEY, WORKER_KEY_SCOPES, "admin"),
        // A member's sandbox run: same scopes, readable by their own code.
        key(sandboxKeyName("member"), SANDBOX_KEY, WORKER_KEY_SCOPES, "member"),
        key("ordinary", ORDINARY_KEY, ["mcp", "query:write"], "member"),
      ],
      workflows: {
        hatchetToken: encryptString(HATCHET_TOKEN),
        live: { sha: "a", tree: "t", names: ["billing-sync", "other-flow"] },
      },
    });
    const pass = (workflow: string, runId: string, workerKey = WORKER_KEY) =>
      mintPass({
        workspaceId: id.toString(),
        workflow,
        runId,
        step: "step",
        keyId: keyIdOf(hashApiKey(workerKey)),
      }).token;

    // The worker key alone acts as no one listable, whatever it names: never
    // as the deployed workflow it claims, never as the admin who deployed it.
    assert.equal(await principalOf(WORKER_KEY), WORKFLOW_WORKER);
    assert.equal(
      await principalOf(WORKER_KEY, "billing-sync"),
      WORKFLOW_WORKER,
    );
    // A member's sandbox key claiming a workflow stays the member.
    assert.equal(await principalOf(SANDBOX_KEY, "billing-sync"), "user:member");
    assert.equal(await principalOf(SANDBOX_KEY), "user:member");
    // Any other key's claim is ignored.
    assert.equal(
      await principalOf(ORDINARY_KEY, "billing-sync"),
      "user:member",
    );

    // A pass acts as its workflow and run, whatever the request says.
    const billing = await call(pass("billing-sync", BILLING_RUN), "other-flow");
    assert.equal(billing.status, 200, billing.error);
    assert.equal(billing.principal, "workflow:billing-sync");
    assert.deepEqual(billing.run, { runId: BILLING_RUN, step: "step" });

    // A pass works only while its run is an executing run of its workflow.
    const ended = await call(pass("billing-sync", DONE_RUN));
    assert.equal(ended.status, 401);
    assert.match(ended.error ?? "", /no longer executing/);
    const borrowed = await call(pass("billing-sync", OTHER_RUN));
    assert.equal(borrowed.status, 401, "another workflow's run lends nothing");

    // A run whose tasks Hatchet does not list yet (they lag the run) is read
    // again, not taken as a run of no workflow, and not remembered as one.
    youngReadsWithoutTasks = 2;
    const young = await call(pass("billing-sync", YOUNG_RUN));
    assert.equal(young.status, 200, young.error);
    assert.equal(young.principal, "workflow:billing-sync");

    // A pass Mako did not sign, or one that expired, is nothing.
    const good = pass("billing-sync", BILLING_RUN);
    const [body, signature] = good.split(".");
    const claims = JSON.parse(
      Buffer.from(body.slice("mwp_".length), "base64url").toString(),
    );
    const renamed = `mwp_${Buffer.from(
      JSON.stringify({ ...claims, wf: "other-flow", run: OTHER_RUN }),
    ).toString("base64url")}.${signature}`;
    assert.equal((await call(renamed)).status, 401, "a pass cannot be renamed");
    assert.equal((await call(`${body}.${"A".repeat(43)}`)).status, 401);
    const expired = mintPass(
      {
        workspaceId: id.toString(),
        workflow: "billing-sync",
        runId: BILLING_RUN,
        keyId: keyIdOf(hashApiKey(WORKER_KEY)),
      },
      Date.now() - 25 * 60 * 60 * 1000,
    ).token;
    assert.equal((await call(expired)).status, 401);

    // A pass made for a worker key that was replaced is nothing.
    const old = pass(
      "billing-sync",
      BILLING_RUN,
      "revops_replaced_worker_key_x",
    );
    assert.equal((await call(old)).status, 401);

    console.log("workflow identity tests passed");
  } finally {
    globalThis.fetch = realFetch;
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
