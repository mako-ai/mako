/**
 * The connection proxy end to end: the runtime's own `lib/mako.ts`
 * `connection()` (deploy/workflows/runtime/defaults), run inside the
 * AsyncLocalStorage worker.mjs sets, calls Mako's runtime route over real
 * HTTP with the worker's key or a person's own key. In-memory Mongo; only the
 * service on the other side is replaced (setTransportForTests).
 *
 * Pins: live reads are off on a connection that never had the field; once
 * on, a read passes for an unlisted workflow; an unlisted write is refused
 * and recorded; with `workflow:*` listed any deployed workflow writes (they
 * share one identity), the worker naming none does not; an allowed write is
 * recorded before it is sent, with its outcome after, and is not sent when
 * it cannot be recorded; a person's own run acts as
 * the person, whatever workflow it names; agents and unidentified callers
 * only read; a name two connections share is refused. What is a read, where
 * a path may go and that no answer carries the key are pinned without a
 * database in callable.test.ts.
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
import { ConnectionRequestError, setTransportForTests } from "./forward";
import { connectorRegistry } from "../connectors/registry";
import { createSourceConnection } from "../connectors/source-connection-create.service";
import { connectionRequest } from "./proxy.service";

const WORKER_KEY = "revops_worker_proxy_key_tests_only";
const PERSON_KEY = "revops_person_proxy_key_tests_only";
const CLOSE_KEY = "api_closekey_do_not_leak_4f9a2c";

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
  /** The allowed writes in the log when each request was sent. */
  const loggedAtSend: { status?: number }[][] = [];
  const transportBack: Parameters<typeof setTransportForTests>[0] = async (
    url,
    options,
  ) => {
    loggedAtSend.push(
      await ConnectionWriteEvent.find({ allowed: true }).sort({ at: 1 }).lean(),
    );
    sent.push({
      url,
      method: options.method,
      headers: options.headers,
      body: options.body,
    });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ ok: true })),
    };
  };
  setTransportForTests(transportBack);

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
    });
    const twin = {
      workspaceId: ws,
      type: "close",
      config: { api_key: encryptString(CLOSE_KEY) },
      settings,
      createdBy: "deployer",
      liveReads: true,
    };
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

    // A connection made before live reads existed has no field: reads are off
    // until an admin turns them on. Writes do not depend on it.
    assert.match(
      await running.run("other-flow", () =>
        attempt(() => worker.connection("ch_close").get("/lead/")),
      ),
      /Live reads are off for ch_close/,
    );
    assert.equal(sent.length, 0, "a refused read is never sent");
    await SourceConnection.updateMany({}, { $set: { liveReads: true } });

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
    assert.equal((await events(0)).length, 0, "reads are not in the write log");

    // An unlisted workflow's write is refused and recorded; nothing is sent.
    const before = sent.length;
    const refused = await running.run("other-flow", () =>
      attempt(() =>
        worker.connection("ch_close").post("/task/", { text: "x" }),
      ),
    );
    assert.equal(
      refused,
      "workflow:other-flow is not allowed to write to ch_close. Ask one of this connection's managers or the workspace owner to allow All deployed workflows on the connection's Access tab.",
    );
    assert.equal(sent.length, before);
    let recorded = await events(1);
    assert.equal(recorded[0].principal, "workflow:other-flow");
    assert.equal(recorded[0].target, "POST /task/");
    assert.equal(recorded[0].allowed, false);

    // Deployed workflows are listed together: any of them writes, as itself.
    await SourceConnection.updateOne(
      { _id: close._id },
      { $set: { writers: [{ principal: "workflow:*" }] } },
    );
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
    // Recorded before it was sent, its outcome after.
    assert.equal(loggedAtSend.at(-1)?.length, 1);
    assert.equal(loggedAtSend.at(-1)?.[0].status, undefined);
    assert.equal(recorded[1].status, 200);
    assert.equal(
      await running.run("other-flow", () =>
        attempt(() => worker.connection("ch_close").post("/task/", {})),
      ),
      "ok",
    );
    // The worker naming no deployed workflow is not one of them.
    assert.match(
      await running.run("not-deployed", () =>
        attempt(() => worker.connection("ch_close").post("/task/", {})),
      ),
      /^worker:workflows is not allowed to write to ch_close/,
    );

    // A write the log cannot take is not sent; a refusal is still answered.
    const realCreate = ConnectionWriteEvent.create.bind(ConnectionWriteEvent);
    (ConnectionWriteEvent as unknown as { create: unknown }).create =
      async () => {
        throw new Error("log down");
      };
    const sentBeforeLogDown = sent.length;
    try {
      const down = await running
        .run("fr-offer-to-cash", () =>
          worker.connection("ch_close").request("POST", "/task/", {}),
        )
        .then(
          answer => ({
            status: answer.status,
            text: JSON.stringify(answer.body),
          }),
          (error: { status?: number; message: string }) => ({
            status: error.status,
            text: error.message,
          }),
        );
      assert.equal(down.status, 503, down.text);
      assert.match(
        down.text,
        /Mako could not record this write, so it was not sent\./,
      );
      assert.match(
        await running.run("not-deployed", () =>
          attempt(() => worker.connection("ch_close").post("/task/", {})),
        ),
        /^worker:workflows is not allowed/,
      );
    } finally {
      (ConnectionWriteEvent as unknown as { create: unknown }).create =
        realCreate;
    }
    assert.equal(sent.length, sentBeforeLogDown);

    // A write that gets no answer is recorded with why.
    setTransportForTests(async () => {
      throw new Error("Refused: a private address");
    });
    assert.match(
      await running.run("fr-offer-to-cash", () =>
        attempt(() => worker.connection("ch_close").post("/task/", {})),
      ),
      /private address|failed/i,
    );
    setTransportForTests(transportBack);
    const failed = await ConnectionWriteEvent.findOne({})
      .sort({ at: -1 })
      .lean();
    assert.equal(failed?.allowed, true);
    assert.match(failed?.error ?? "", /a private address/);
    assert.equal(failed?.status, undefined);
    await ConnectionWriteEvent.deleteMany({});

    // A listed writer writes anywhere through the connection: no path limit.
    assert.equal(
      (
        await running.run("fr-offer-to-cash", () =>
          worker.connection("ch_close").request("DELETE", "/lead/lead_1/"),
        )
      ).status,
      200,
    );

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
    recorded = await events(2);
    assert.equal(recorded.at(-1)?.principal, "user:deployer");
    assert.equal(recorded.at(-1)?.allowed, false);
    // ...and reads like anyone.
    assert.equal(
      await running.run("fr-offer-to-cash", () =>
        attempt(() => person.connection("ch_close").get("/me/")),
      ),
      "ok",
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
    // Recorded as the agent's attempt, which no writers list can name.
    recorded = await events(3);
    assert.equal(recorded.at(-1)?.principal, "agent:workflow:fr-offer-to-cash");
    assert.equal(recorded.at(-1)?.allowed, false);

    // A viewer never writes, even when listed.
    await WorkspaceMember.create({
      workspaceId: ws,
      userId: "vera",
      role: "viewer",
      joinedAt: new Date(),
    });
    await SourceConnection.updateOne(
      { _id: close._id },
      { $push: { writers: { principal: "user:vera" } } },
    );
    const sentBeforeViewer = sent.length;
    const viewerWrite = await connectionRequest({
      workspaceId: String(ws),
      connection: "ch_close",
      request: { method: "POST", path: "/task/" },
      actor: "user:vera",
    }).then(
      () => "ok",
      (error: Error) => error.message,
    );
    assert.match(viewerWrite, /^Viewers can't write through a connection/);
    assert.equal(sent.length, sentBeforeViewer);
    recorded = await events(4);
    assert.equal(recorded.at(-1)?.principal, "user:vera");
    assert.equal(recorded.at(-1)?.allowed, false);
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

    // Two connections with one name: a name is refused, the id still works.
    const [dupA] = await SourceConnection.create([
      { ...twin, name: "dup_name" },
      { ...twin, name: "dup_name" },
    ]);
    const byName = await connectionRequest({
      workspaceId: String(ws),
      connection: "dup_name",
      request: { method: "GET", path: "/lead/" },
    }).then(
      () => null,
      (error: ConnectionRequestError) => error,
    );
    assert.equal(byName?.status, 409);
    assert.equal(
      byName?.message,
      "Several connections are called dup_name; use its id.",
    );
    const byId = await connectionRequest({
      workspaceId: String(ws),
      connection: String(dupA._id),
      request: { method: "GET", path: "/lead/" },
    });
    assert.equal(byId.status, 200);

    // Live reads turned off again: reads are refused.
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

    // Every new connection starts with live reads off, a Custom API too.
    await connectorRegistry.ready();
    const custom = await createSourceConnection({
      workspaceId: String(ws),
      userId: "deployer",
      name: "new_custom",
      type: "custom_api",
      config: { base_url: "https://x.example.com", token: "t0ken_value" },
    });
    assert.equal(custom.liveReads, undefined);
    const builtin = await createSourceConnection({
      workspaceId: String(ws),
      userId: "deployer",
      name: "new_close",
      type: "close",
      config: { api_key: "k3y_value" },
    });
    assert.equal(builtin.liveReads, undefined);

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
