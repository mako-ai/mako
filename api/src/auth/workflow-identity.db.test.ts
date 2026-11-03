/**
 * Who a workflow-runtime key writes as, through the real auth middleware and
 * an in-memory Mongo. Workflow code can read the key it runs with, so the
 * workflow name it sends (X-Mako-Workflow) must be trusted only from the
 * deployed worker's key, and only for a workflow deployed from main.
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Hono } from "hono";

import { WORKFLOW_WORKER, actingPrincipal } from "../access/connection-writes";
import { User } from "../database/schema";
import { Workspace } from "../database/workspace-schema";
import { requestContextStorage } from "../logging/context";
import {
  WORKER_KEY_SCOPES,
  sandboxKeyName,
  workerKeyName,
} from "../workflows/worker-key";
import { hashApiKey } from "./api-key.middleware";
import { unifiedAuthMiddleware } from "./unified-auth.middleware";

const WORKER_KEY = "revops_deployed_worker_key_test";
const SANDBOX_KEY = "revops_member_sandbox_key_test";
const ORDINARY_KEY = "revops_ordinary_mcp_key_test__";

// The MCP endpoint is where workflow code queries; answer who is acting.
const app = new Hono();
app.post("/api/mcp", unifiedAuthMiddleware, c =>
  c.json({ principal: actingPrincipal() ?? null }),
);

const principalOf = async (key: string, workflow?: string) => {
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
  assert.equal(res.status, 200);
  return ((await res.json()) as { principal: string | null }).principal;
};

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
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
      workflows: { live: { sha: "a", tree: "t", names: ["billing-sync"] } },
    });

    // The deployed worker, naming a deployed workflow, writes as it.
    assert.equal(
      await principalOf(WORKER_KEY, "billing-sync"),
      "workflow:billing-sync",
    );
    // A member's sandbox key claiming that workflow stays the member.
    assert.equal(await principalOf(SANDBOX_KEY, "billing-sync"), "user:member");
    assert.equal(await principalOf(SANDBOX_KEY), "user:member");
    // Any other key's claim is ignored.
    assert.equal(
      await principalOf(ORDINARY_KEY, "billing-sync"),
      "user:member",
    );
    // The worker naming nothing, or a workflow not deployed from main, writes
    // as no one listable: never as the admin who deployed it.
    assert.equal(await principalOf(WORKER_KEY), WORKFLOW_WORKER);
    assert.equal(
      await principalOf(WORKER_KEY, "not-deployed"),
      WORKFLOW_WORKER,
    );
    assert.equal(await principalOf(WORKER_KEY, "bad name!"), WORKFLOW_WORKER);

    console.log("workflow identity tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
