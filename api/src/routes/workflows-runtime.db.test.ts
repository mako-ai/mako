/**
 * The worker's routes against a real (in-memory) Mongo: which commit to run,
 * and what the worker reports back. These three calls are the whole deploy
 * protocol between Mako and a worker, so they are tested as the worker uses
 * them.
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { OpenAPIHono } from "@hono/zod-openapi";

import { hashApiKey } from "../auth/api-key.middleware";
import { User } from "../database/schema";
import { Workspace } from "../database/workspace-schema";
import { readWorkflowsStatus } from "../workflows/runs";
import { workflowRuntimeRoutes } from "./workflows";

const TENANT = "11111111-1111-1111-1111-111111111111";
const HATCHET_TOKEN = `x.${Buffer.from(
  JSON.stringify({ sub: TENANT, server_url: "https://hatchet.example" }),
).toString("base64url")}.y`;
const WORKER_KEY = "revops_worker_key_for_tests";
const OTHER_KEY = "revops_ordinary_key_for_tests";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const app = new OpenAPIHono();
app.route("/api/workflows/runtime", workflowRuntimeRoutes);

const call = (path: string, key: string, body?: unknown) =>
  app.request(`/api/workflows/runtime${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  process.env.HATCHET_CLIENT_TOKEN = HATCHET_TOKEN;
  try {
    const id = new Types.ObjectId();
    await User.create({ _id: "tester", email: "tester@example.com" });
    const key = (name: string, value: string, scopes: string[]) => ({
      _id: new Types.ObjectId(),
      name,
      keyHash: hashApiKey(value),
      prefix: value.slice(0, 14),
      scopes,
      createdAt: new Date(),
      createdBy: "tester",
    });
    await Workspace.collection.insertOne({
      _id: id,
      name: "t",
      slug: `t-${id}`,
      createdBy: "tester",
      apiKeys: [
        key("worker", WORKER_KEY, ["mcp", "query:read", "workflows:runtime"]),
        key("ordinary", OTHER_KEY, ["mcp", "query:read"]),
      ],
      workflows: { live: { sha: SHA_A, tree: "tree-a" } },
    });
    const state = async () =>
      (await Workspace.findById(id).select("workflows").lean())?.workflows;

    // Only the worker's key gets in: no key, an ordinary key, a wrong key.
    assert.equal((await call("/head", "")).status, 401);
    assert.equal((await call("/head", OTHER_KEY)).status, 403);
    assert.equal((await call("/head", "revops_unknown")).status, 401);
    // The agent and the model are behind the same key; a goal is required.
    assert.equal((await call("/agent", OTHER_KEY, { goal: "x" })).status, 403);
    assert.equal((await call("/ai/language-model", OTHER_KEY, {})).status, 403);
    assert.equal((await call("/agent", WORKER_KEY, {})).status, 400);
    // Only the gateway call that can be counted is forwarded.
    assert.equal(
      (await call("/ai/embedding-model", WORKER_KEY, {})).status,
      404,
    );
    assert.equal(
      (await call("/status", OTHER_KEY, { slot: "live", sha: SHA_A })).status,
      403,
    );

    // The worker learns its commit and its Hatchet token in one call.
    const head = await call("/head", WORKER_KEY);
    assert.equal(head.status, 200);
    assert.deepEqual(await head.json(), {
      hatchetToken: HATCHET_TOKEN,
      live: { sha: SHA_A, tree: "tree-a" },
      preview: null,
    });

    // It reports the commit it runs.
    assert.equal(
      (await call("/status", WORKER_KEY, { slot: "live", sha: SHA_A })).status,
      200,
    );
    assert.deepEqual((await state())?.live?.running, { sha: SHA_A });

    // A build error is recorded and leaves the live commit alone.
    assert.equal(
      (
        await call("/status", WORKER_KEY, {
          slot: "live",
          sha: SHA_B,
          error: "TS2322",
        })
      ).status,
      200,
    );
    assert.deepEqual((await state())?.live?.running, { sha: SHA_A });
    assert.deepEqual((await state())?.live?.failed, {
      sha: SHA_B,
      error: "TS2322",
    });

    // The next good commit clears the error.
    assert.equal(
      (await call("/status", WORKER_KEY, { slot: "live", sha: SHA_B })).status,
      200,
    );
    assert.deepEqual((await state())?.live?.running, { sha: SHA_B });
    assert.equal((await state())?.live?.failed, undefined);

    // A preview is unmerged work next to live: the worker is told about it,
    // and its reports never touch the live commit.
    await Workspace.updateOne(
      { _id: id },
      {
        $set: {
          "workflows.preview": { branch: "jo/x", sha: SHA_A, tree: "tree-p" },
        },
      },
    );
    const withPreview = (await (await call("/head", WORKER_KEY)).json()) as {
      preview: unknown;
    };
    assert.deepEqual(withPreview.preview, { sha: SHA_A, tree: "tree-p" });
    await call("/status", WORKER_KEY, {
      slot: "preview",
      sha: SHA_A,
      error: "TS1005",
    });
    assert.deepEqual((await state())?.preview?.failed, {
      sha: SHA_A,
      error: "TS1005",
    });
    assert.deepEqual((await state())?.live?.running, { sha: SHA_B });
    let status = await readWorkflowsStatus(id.toString());
    assert.equal(status.preview?.branch, "jo/x");
    assert.equal(status.preview?.buildError, "TS1005");
    assert.equal(status.deployment.buildError, null);
    await call("/status", WORKER_KEY, { slot: "preview", sha: SHA_A });
    status = await readWorkflowsStatus(id.toString());
    assert.equal(status.preview?.liveSha, SHA_A);
    assert.equal(status.deployment.liveSha, SHA_B);

    // A commit must be a full SHA.
    assert.equal(
      (await call("/status", WORKER_KEY, { sha: "../etc" })).status,
      400,
    );
    assert.equal((await call("/source/main", WORKER_KEY)).status, 400);

    console.log("workflows runtime route tests passed");
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
