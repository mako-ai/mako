/**
 * The connection proxy end to end: the runtime's own `lib/mako.ts`
 * `connection()` (deploy/workflows/runtime/defaults), run inside the
 * AsyncLocalStorage worker.mjs sets, calls Mako's runtime route over real
 * HTTP with the worker's key or a person's own key. In-memory Mongo; only the
 * service on the other side is replaced (setTransportForTests).
 *
 * Pins: a read passes for an unlisted workflow; an unlisted write is refused
 * and recorded; a listed `workflow:<name>` writes; a person's own run acts as
 * the person, whatever workflow it names; a path outside the base URL is
 * refused; agents and unidentified callers only read; no answer carries the
 * key.
 *
 * Needs the runtime's packages: npm install --prefix deploy/workflows/runtime
 *
 * Run with: pnpm --filter api exec tsx src/connections/proxy.db.test.ts
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { ConnectionWriteEvent } from "../access/connection-write-event";
import { hashApiKey } from "../auth/api-key.middleware";
import { User } from "../database/schema";
import {
  SourceConnection,
  Workspace,
  WorkspaceMember,
} from "../database/workspace-schema";
import { loggingMiddleware } from "../logging";
import { workflowRuntimeRoutes } from "../routes/workflows";
import { encryptString } from "../services/crypto.service";
import { databaseConnectionService } from "../services/database-connection.service";
import { setTransportForTests } from "./forward";
import { connectionRequest } from "./proxy.service";

const WORKER_KEY = "revops_worker_proxy_key_tests_only";
const PERSON_KEY = "revops_person_proxy_key_tests_only";
const CLOSE_KEY = "api_closekey_do_not_leak_4f9a2c";
const PROBO_TOKEN = "probo_token_do_not_leak_8d1e7b";

type Connection = {
  get: (path: string, options?: unknown) => Promise<unknown>;
  post: (path: string, body?: unknown, options?: unknown) => Promise<unknown>;
  request: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: unknown;
  }>;
};
type Mako = { connection: (id: string) => Connection };

type Sent = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

/** The refusal's message, or "ok". */
const attempt = (run: () => Promise<unknown>): Promise<string> =>
  run().then(
    () => "ok",
    (error: Error) => error.message,
  );

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // The source connection manager reads through the main connection.
  process.env.DATABASE_URL = mongo.getUri();
  process.env.DATABASE_NAME = mongoose.connection.db?.databaseName ?? "test";
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);

  const sent: Sent[] = [];
  setTransportForTests(async (url, options) => {
    sent.push({
      url,
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
    // A careless service echoing what it was sent.
    return {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-echo-auth": options.headers.authorization ?? "",
        "set-cookie": "s=1",
      },
      body: Buffer.from(
        JSON.stringify({ ok: true, youSent: options.headers, url }),
      ),
    };
  });

  const app = new Hono();
  app.use("*", loggingMiddleware({}));
  app.route("/api/workflows/runtime", workflowRuntimeRoutes);
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise(resolve => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const ws = new Types.ObjectId();
    await User.create({ _id: "deployer", email: "deployer@example.com" });
    await WorkspaceMember.create({
      workspaceId: ws,
      userId: "deployer",
      role: "owner",
      joinedAt: new Date(),
    });
    const key = (name: string, value: string, scopes: string[]) => ({
      _id: new Types.ObjectId(),
      name,
      keyHash: hashApiKey(value),
      prefix: value.slice(0, 14),
      scopes,
      createdAt: new Date(),
      createdBy: "deployer",
    });
    await Workspace.collection.insertOne({
      _id: ws,
      name: "t",
      slug: `t-${ws}`,
      createdBy: "deployer",
      settings: {},
      apiKeys: [
        key("Workflows worker", WORKER_KEY, [
          "mcp",
          "query:write",
          "workflows:runtime",
        ]),
        // `mako workflow run` / a sandbox run: the person's own grant.
        key("Mine", PERSON_KEY, ["mcp", "workflows:run"]),
      ],
      workflows: {
        live: {
          sha: "a".repeat(40),
          tree: "t",
          names: ["fr-offer-to-cash", "other-flow"],
        },
      },
    });
    const settings = { sync_batch_size: 100, rate_limit_delay_ms: 0 };
    const close = await SourceConnection.create({
      workspaceId: ws,
      name: "ch_close",
      type: "close",
      config: { api_key: encryptString(CLOSE_KEY) },
      settings,
      createdBy: "deployer",
      writers: [{ principal: "workflow:fr-offer-to-cash", where: "/task/" }],
    });
    await SourceConnection.create({
      workspaceId: ws,
      name: "probo",
      type: "http",
      config: {
        base_url: "https://api.probo.example.com/graphql",
        auth_scheme: "bearer",
        token: encryptString(PROBO_TOKEN),
        graphql: true,
      },
      settings,
      createdBy: "deployer",
    });

    const running = new AsyncLocalStorage<string>();
    (globalThis as { makoWorkflow?: unknown }).makoWorkflow = running;
    const load = async (apiKey: string): Promise<Mako> => {
      process.env.MAKO_URL = `http://127.0.0.1:${port}`;
      process.env.MAKO_API_KEY = apiKey;
      const file = path.resolve(
        __dirname,
        "../../../deploy/workflows/runtime/defaults/lib/mako.ts",
      );
      return (await import(
        `${pathToFileURL(file).href}?proxy=${encodeURIComponent(apiKey)}`
      )) as Mako;
    };
    const events = async (expected: number) => {
      for (let i = 0; i < 60; i++) {
        const found = await ConnectionWriteEvent.find({})
          .sort({ at: 1 })
          .lean();
        if (found.length >= expected) return found;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return ConnectionWriteEvent.find({}).sort({ at: 1 }).lean();
    };

    const worker = await load(WORKER_KEY);

    // A read passes for a workflow on no list, by connection name.
    const lead = await running.run("other-flow", () =>
      worker.connection("ch_close").request("GET", "/lead/", undefined),
    );
    assert.equal(lead.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://api.close.com/api/v1/lead/");
    assert.equal(
      sent[0].headers.authorization,
      `Basic ${Buffer.from(`${CLOSE_KEY}:`).toString("base64")}`,
    );
    // No secret in the answer: not in its headers, not echoed in its body.
    const text = JSON.stringify(lead);
    assert.ok(!text.includes(CLOSE_KEY), "the key is not in the answer");
    assert.ok(
      !text.includes(Buffer.from(`${CLOSE_KEY}:`).toString("base64")),
      "the encoded key is not in the answer",
    );
    assert.equal(lead.headers["set-cookie"], undefined);
    assert.equal(lead.headers["x-echo-auth"], undefined);

    // Close's list-as-POST is a read too.
    assert.equal(
      await running.run("other-flow", () =>
        attempt(() =>
          worker.connection(String(close._id)).post(
            "/lead/",
            { _params: {} },
            {
              headers: { "x-http-method-override": "GET" },
            },
          ),
        ),
      ),
      "ok",
    );
    assert.equal((await events(0)).length, 0, "reads are not in the write log");

    // An unlisted workflow's write is refused and recorded; nothing is sent.
    const before = sent.length;
    const refused = await running.run("other-flow", () =>
      attempt(() =>
        worker.connection("ch_close").post("/task/", { text: "x" }),
      ),
    );
    assert.match(
      refused,
      /^workflow:other-flow is not allowed to write to ch_close/,
    );
    assert.equal(sent.length, before);
    let recorded = await events(1);
    assert.equal(recorded[0].principal, "workflow:other-flow");
    assert.equal(recorded[0].target, "POST /task/");
    assert.equal(recorded[0].allowed, false);

    // The listed workflow writes, within its path, as itself.
    assert.equal(
      await running.run("fr-offer-to-cash", () =>
        attempt(() =>
          worker
            .connection("ch_close")
            .post("/task/", { lead_id: "lead_1", text: "Call" }),
        ),
      ),
      "ok",
    );
    assert.equal(sent.length, before + 1);
    assert.equal(sent.at(-1)?.method, "POST");
    assert.deepEqual(JSON.parse(sent.at(-1)?.body ?? "{}"), {
      lead_id: "lead_1",
      text: "Call",
    });
    recorded = await events(2);
    assert.equal(recorded[1].principal, "workflow:fr-offer-to-cash");
    assert.equal(recorded[1].allowed, true);

    // Outside its path, the same workflow is refused.
    assert.match(
      await running.run("fr-offer-to-cash", () =>
        attempt(() =>
          worker.connection("ch_close").request("DELETE", "/lead/lead_1/"),
        ),
      ),
      /not allowed to write/,
    );

    // A path outside the base URL is refused for everyone, before sending.
    const sentBefore = sent.length;
    assert.match(
      await running.run("fr-offer-to-cash", () =>
        attempt(() => worker.connection("ch_close").get("/../../admin")),
      ),
      /must stay under the connection's base URL/,
    );
    assert.equal(sent.length, sentBefore);

    // A person's own run acts as the person: the workflow it names grants nothing.
    const person = await load(PERSON_KEY);
    assert.match(
      await running.run("fr-offer-to-cash", () =>
        attempt(() =>
          person.connection("ch_close").post("/task/", { text: "x" }),
        ),
      ),
      /^user:deployer is not allowed to write to ch_close/,
    );
    recorded = await events(4);
    assert.equal(recorded.at(-1)?.principal, "user:deployer");
    assert.equal(recorded.at(-1)?.allowed, false);
    // ...and reads like anyone.
    assert.equal(
      await running.run("fr-offer-to-cash", () =>
        attempt(() => person.connection("ch_close").get("/me/")),
      ),
      "ok",
    );

    // GraphQL on an http connection: a query reads, a mutation writes.
    assert.equal(
      await running.run("other-flow", () =>
        attempt(() =>
          worker.connection("probo").post("/", { query: "{ viewer { id } }" }),
        ),
      ),
      "ok",
    );
    assert.equal(sent.at(-1)?.url, "https://api.probo.example.com/graphql");
    assert.equal(sent.at(-1)?.headers.authorization, `Bearer ${PROBO_TOKEN}`);
    assert.match(
      await running.run("other-flow", () =>
        attempt(() =>
          worker
            .connection("probo")
            .post("/", { query: "mutation { deleteUser(id: 1) }" }),
        ),
      ),
      /not allowed to write to probo/,
    );

    // An agent only reads, whoever it acts for.
    const agentWrite = await connectionRequest({
      workspaceId: String(ws),
      connection: "ch_close",
      request: { method: "POST", path: "/task/" },
      readOnly: true,
      actor: "workflow:fr-offer-to-cash",
    }).then(
      () => "ok",
      (error: Error) => error.message,
    );
    assert.match(agentWrite, /^Agents only read/);
    const agentRead = await connectionRequest({
      workspaceId: String(ws),
      connection: "ch_close",
      request: { method: "GET", path: "/lead/" },
      readOnly: true,
    });
    assert.equal(agentRead.read, true);

    // No one identified: the write is refused.
    const nobody = await connectionRequest({
      workspaceId: String(ws),
      connection: "ch_close",
      request: { method: "POST", path: "/task/" },
    }).then(
      () => "ok",
      (error: Error) => error.message,
    );
    assert.match(nobody, /could not tell who is writing/);

    // Another workspace's connection does not exist here.
    const elsewhere = await connectionRequest({
      workspaceId: String(new Types.ObjectId()),
      connection: String(close._id),
      request: { method: "GET", path: "/lead/" },
    }).then(
      () => "ok",
      (error: Error) => error.message,
    );
    assert.match(elsewhere, /^No connection/);

    // Live reads off: reads are refused too.
    await SourceConnection.updateOne(
      { _id: close._id },
      { $set: { liveReads: false } },
    );
    assert.match(
      await running.run("other-flow", () =>
        attempt(() => worker.connection("ch_close").get("/lead/")),
      ),
      /Live reads are off/,
    );

    console.info("connection proxy tests passed");
  } finally {
    setTransportForTests(null);
    (
      server as unknown as { closeAllConnections(): void }
    ).closeAllConnections();
    server.close();
    await new Promise(resolve => setTimeout(resolve, 300));
    // The source connection manager's own client to the main database.
    await databaseConnectionService.closeAllConnections();
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
