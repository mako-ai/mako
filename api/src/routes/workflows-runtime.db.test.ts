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
import { LlmUsage, User } from "../database/schema";
import { loggingMiddleware } from "../logging";
import { Workspace } from "../database/workspace-schema";
import { encryptString } from "../services/crypto.service";
import { workerKeyName } from "../workflows/worker-key";
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
// As in the API: the request context carries the workflow Mako checked.
app.use("*", loggingMiddleware({}));
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
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
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
        key(workerKeyName(), WORKER_KEY, [
          "mcp",
          "query:read",
          "workflows:runtime",
        ]),
        key("ordinary", OTHER_KEY, ["mcp", "query:read"]),
      ],
      workflows: {
        hatchetToken: encryptString(HATCHET_TOKEN),
        live: {
          sha: SHA_A,
          tree: "tree-a",
          names: ["digest", "crm-chat-classifier"],
        },
        active: ["digest"],
      },
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
      (await call("/status", OTHER_KEY, { sha: SHA_A })).status,
      403,
    );

    // The worker learns its commit and its Hatchet token in one call.
    const head = await call("/head", WORKER_KEY);
    assert.equal(head.status, 200);
    assert.deepEqual(await head.json(), {
      hatchetToken: HATCHET_TOKEN,
      live: { sha: SHA_A, tree: "tree-a" },
      active: ["digest"],
    });

    // It reports the commit it runs.
    assert.equal(
      (await call("/status", WORKER_KEY, { sha: SHA_A })).status,
      200,
    );
    assert.deepEqual((await state())?.live?.running, { sha: SHA_A });

    // A new commit is wanted; its build error is recorded and leaves the
    // running commit alone.
    await Workspace.updateOne(
      { _id: id },
      {
        $set: { "workflows.live.sha": SHA_B, "workflows.live.tree": "tree-b" },
      },
    );
    assert.equal(
      (await call("/status", WORKER_KEY, { sha: SHA_B, error: "TS2322" }))
        .status,
      200,
    );
    assert.deepEqual((await state())?.live?.running, { sha: SHA_A });
    assert.deepEqual((await state())?.live?.failed, {
      sha: SHA_B,
      error: "TS2322",
    });

    // The next good build of it clears the error.
    assert.equal(
      (await call("/status", WORKER_KEY, { sha: SHA_B })).status,
      200,
    );
    assert.deepEqual((await state())?.live?.running, { sha: SHA_B });
    assert.equal((await state())?.live?.failed, undefined);

    // A late report for a commit no longer wanted changes nothing.
    await call("/status", WORKER_KEY, { sha: SHA_A, error: "stale" });
    assert.equal((await state())?.live?.failed, undefined);
    assert.deepEqual((await state())?.live?.running, { sha: SHA_B });

    // A commit must be a full SHA.
    assert.equal(
      (await call("/status", WORKER_KEY, { sha: "../etc" })).status,
      400,
    );
    assert.equal((await call("/source/main", WORKER_KEY)).status, 400);

    // A decision model (Jev) is forwarded like a language model: to the
    // gateway's /decision-model, with only its protocol headers and the
    // gateway key, the body untouched, and its usage counted.
    const gatewayCalls: Array<{ url: string; init: RequestInit }> = [];
    let gatewayReply = () =>
      new Response(
        JSON.stringify({
          answers: { intent: "valuation" },
          usage: { inputTokens: 120, outputTokens: 4 },
          providerMetadata: { gateway: { cost: "0.000031374" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      // Anything else (the model catalog, pricing) finds no network here.
      if (!url.endsWith("-model")) return new Response(null, { status: 503 });
      gatewayCalls.push({ url, init: init ?? {} });
      return gatewayReply();
    }) as typeof fetch;
    process.env.AI_GATEWAY_API_KEY = "gateway-key-for-tests";
    const decide = (key: string) =>
      app.request("/api/workflows/runtime/ai/decision-model", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "ai-model-id": "typesafe-ai/jev",
          "ai-decision-model-specification-version": "4",
          "x-mako-workflow": "crm-chat-classifier",
          // The run and step the worker sends (worker.mjs), for its cost.
          "x-mako-run": "0f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
          "x-mako-step": "label",
          cookie: "session=secret",
        },
        body: JSON.stringify({
          stateParts: [{ type: "json", value: { text: "hi" } }],
          questions: [{ name: "intent" }],
        }),
      });
    const usageRows = async (expected: number) => {
      // trackUsage is not awaited by the route.
      for (let i = 0; i < 50; i++) {
        const n = await LlmUsage.countDocuments({ workspaceId: id });
        if (n >= expected) return n;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return LlmUsage.countDocuments({ workspaceId: id });
    };
    try {
      assert.equal((await decide(OTHER_KEY)).status, 403);
      assert.equal(gatewayCalls.length, 0);

      const decided = await decide(WORKER_KEY);
      assert.equal(decided.status, 200);
      assert.deepEqual(
        ((await decided.json()) as { answers: unknown }).answers,
        { intent: "valuation" },
      );
      assert.equal(gatewayCalls.length, 1);
      const [forwarded] = gatewayCalls;
      assert.equal(
        forwarded.url,
        "https://ai-gateway.vercel.sh/v4/ai/decision-model",
      );
      const sent = new Headers(forwarded.init.headers);
      assert.deepEqual([...sent.keys()].sort(), [
        "ai-decision-model-specification-version",
        "ai-gateway-protocol-version",
        "ai-model-id",
        "authorization",
        "content-type",
      ]);
      assert.equal(sent.get("authorization"), "Bearer gateway-key-for-tests");
      assert.equal(sent.get("ai-model-id"), "typesafe-ai/jev");
      // A plain fetch omits the gateway protocol version; Mako adds it.
      assert.equal(sent.get("ai-gateway-protocol-version"), "0.0.1");
      assert.deepEqual(
        JSON.parse(
          Buffer.from(forwarded.init.body as ArrayBuffer).toString("utf8"),
        ),
        {
          stateParts: [{ type: "json", value: { text: "hi" } }],
          questions: [{ name: "intent" }],
        },
      );
      assert.equal(await usageRows(1), 1);
      const row = await LlmUsage.findOne({ workspaceId: id }).lean();
      assert.equal(row?.invocationType, "workflow");
      assert.equal(row?.modelId, "typesafe-ai/jev");
      assert.equal(row?.inputTokens, 120);
      assert.equal(row?.outputTokens, 4);
      assert.equal(row?.totalTokens, 124);
      assert.equal(row?.costUsd, 0.000031374);
      // Counted against the run and step it came from, the workflow being
      // the deployed one Mako checked.
      assert.deepEqual(row?.workflowRun, {
        workflowId: "crm-chat-classifier",
        runId: "0f6f3d2c-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
        step: "label",
      });

      // A gateway error is passed back as is, and nothing is counted.
      gatewayReply = () =>
        new Response(JSON.stringify({ error: "model not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      const missing = await decide(WORKER_KEY);
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: "model not found" });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await LlmUsage.countDocuments({ workspaceId: id }), 1);

      // A language model goes to the gateway path of the spec version the
      // client states. `@ai-sdk/gateway` 3 (ai@6, the runtime's) passes the
      // body through, and only `/v3/ai` answers in the per-side usage shape
      // ai@6 reads; `/v1/ai` answers with flat numbers, read as 0 tokens.
      // The reply is the gateway's real `/v3/ai` answer for gpt-4o-mini.
      gatewayReply = () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "Hi" }],
            finishReason: "stop",
            usage: {
              inputTokens: {
                total: 13,
                noCache: 13,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 3, text: 3, reasoning: 0 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      const generate = (specificationVersion?: string) =>
        app.request("/api/workflows/runtime/ai/language-model", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${WORKER_KEY}`,
            "content-type": "application/json",
            "ai-language-model-id": "openai/gpt-4o-mini",
            "ai-language-model-streaming": "false",
            ...(specificationVersion
              ? {
                  "ai-language-model-specification-version":
                    specificationVersion,
                }
              : {}),
          },
          body: JSON.stringify({ prompt: [] }),
        });
      const generated = await generate("3");
      assert.equal(generated.status, 200);
      assert.equal(
        gatewayCalls.at(-1)?.url,
        "https://ai-gateway.vercel.sh/v3/ai/language-model",
      );
      const generatedBody = (await generated.json()) as {
        usage: { inputTokens: { total: number } };
      };
      assert.equal(generatedBody.usage.inputTokens.total, 13);
      assert.equal(await usageRows(2), 2);
      const lmRow = await LlmUsage.findOne({
        workspaceId: id,
        modelId: "openai/gpt-4o-mini",
      }).lean();
      assert.equal(lmRow?.inputTokens, 13);
      assert.equal(lmRow?.outputTokens, 3);
      // A client stating ai@7's spec goes to /v4/ai; one stating none keeps
      // the configured base.
      await generate("4");
      assert.equal(
        gatewayCalls.at(-1)?.url,
        "https://ai-gateway.vercel.sh/v4/ai/language-model",
      );
      await generate();
      assert.equal(
        gatewayCalls.at(-1)?.url,
        "https://ai-gateway.vercel.sh/v1/ai/language-model",
      );
      await usageRows(4);

      // Over its plan's limit, the call is refused before the gateway.
      process.env.BILLING_ENABLED = "true";
      await Workspace.updateOne(
        { _id: id },
        { $set: { billing: { plan: "pro", hardLimitUsd: 1 } } },
      );
      await LlmUsage.create({
        workspaceId: id,
        userId: "tester",
        invocationType: "workflow",
        modelId: "typesafe-ai/jev",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 10,
      });
      const callsBefore = gatewayCalls.length;
      assert.equal((await decide(WORKER_KEY)).status, 402);
      assert.equal(gatewayCalls.length, callsBefore);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.AI_GATEWAY_API_KEY;
      delete process.env.BILLING_ENABLED;
    }

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
