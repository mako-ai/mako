/**
 * A deployed workflow writes as itself, end to end: the runtime's own
 * `lib/mako.ts` (deploy/workflows/runtime/defaults), run inside the
 * AsyncLocalStorage worker.mjs sets, calls Mako's runtime query route over
 * real HTTP with the worker's key (and a person's key calls the MCP endpoint); Mako sees `workflow:<name>` and its writers list
 * decides. In-memory Mongo; only the BigQuery driver is stubbed, so a write
 * that passes the check "succeeds" without a warehouse.
 *
 * Needs the runtime's packages: npm install --prefix deploy/workflows/runtime
 *
 * Run with: pnpm --filter api exec tsx src/workflows/worker-identity.db.test.ts
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
  DatabaseConnection,
  Workspace,
  WorkspaceMember,
} from "../database/workspace-schema";
import { loggingMiddleware } from "../logging";
import { mcpProtocolRoutes } from "../routes/mcp-server.routes";
import { workflowRuntimeRoutes } from "../routes/workflows";
import { databaseConnectionService } from "../services/database-connection.service";

const WORKER_KEY = "revops_worker_identity_key_tests_only";
const PERSON_KEY = "revops_person_query_write_key_tests";
const MERGE =
  "MERGE INTO `realadvisor-prod.crm_ai_chat.chat_labels` T USING (SELECT 1 AS id) S ON T.id = S.id WHEN NOT MATCHED THEN INSERT (id) VALUES (S.id)";

/** Whether a query ran, and why not. */
type Answer = { success: boolean; error?: string };

type Mako = {
  query: (connection: string, sql: string) => Promise<unknown[]>;
  call: (name: string, input: Record<string, unknown>) => Promise<unknown>;
};

/** `query()` throws a refusal; as an answer, like sql_execute_query's. */
const attempt = (run: () => Promise<unknown>): Promise<Answer> =>
  run().then(
    () => ({ success: true }),
    (error: Error) => ({ success: false, error: error.message }),
  );

async function main() {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  const app = new Hono();
  app.use("*", loggingMiddleware({}));
  app.route("/api/mcp", mcpProtocolRoutes);
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
        // As on-push.ts makes the worker's key.
        key("Workflows worker", WORKER_KEY, [
          "mcp",
          "query:write",
          "workflows:runtime",
        ]),
        // A person's key that may write: it cannot name a workflow.
        key("Mine", PERSON_KEY, ["mcp", "query:write"]),
      ],
      // The worker is believed only for workflows deployed from main.
      workflows: {
        live: {
          sha: "a".repeat(40),
          tree: "t",
          names: ["crm-chat-classifier", "other-flow"],
        },
      },
    });
    const db = await DatabaseConnection.create({
      workspaceId: ws,
      name: "bigquery_write",
      type: "bigquery",
      connection: { project_id: "realadvisor-prod" },
      createdBy: "deployer",
      writers: [
        { principal: "workflow:crm-chat-classifier", where: "crm_ai_chat" },
      ],
    });
    const ran: string[] = [];
    (
      databaseConnectionService as unknown as {
        executeBigQueryQuery: (db: unknown, q: string) => Promise<unknown>;
      }
    ).executeBigQueryQuery = async (_db, q) => {
      ran.push(q);
      return { success: true, data: [], rowCount: 0 };
    };
    // A read is fetched a page at a time, with BigQuery's own pages.
    (
      databaseConnectionService as unknown as {
        executeBigQueryPreviewQuery: (
          db: unknown,
          q: string,
        ) => Promise<unknown>;
      }
    ).executeBigQueryPreviewQuery = async (_db, q) => {
      ran.push(q);
      return { success: true, rows: [], fields: [], pageInfo: {} };
    };

    // What the image runs: worker.mjs's storage, then the default helpers.
    const running = new AsyncLocalStorage<string>();
    (globalThis as { makoWorkflow?: unknown }).makoWorkflow = running;
    const load = async (apiKey: string): Promise<Mako> => {
      process.env.MAKO_URL = `http://127.0.0.1:${port}`;
      process.env.MAKO_API_KEY = apiKey;
      const file = path.resolve(
        __dirname,
        "../../../deploy/workflows/runtime/defaults/lib/mako.ts",
      );
      // A fresh module per key: it reads its key when loaded.
      return (await import(
        `${pathToFileURL(file).href}?key=${apiKey.slice(-6)}`
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
    const id = String(db._id);

    // The listed workflow writes, inside its own schema, as itself.
    const worker = await load(WORKER_KEY);
    const wrote = await running.run("crm-chat-classifier", () =>
      attempt(() => worker.query(id, MERGE)),
    );
    assert.equal(wrote.success, true, wrote.error);
    assert.equal(ran.length, 1, "the MERGE reached the driver");
    let recorded = await events(1);
    assert.equal(recorded[0].principal, "workflow:crm-chat-classifier");
    assert.equal(recorded[0].target, "crm_ai_chat.chat_labels");
    assert.equal(recorded[0].allowed, true);

    // Another workflow on the same worker is refused, by name, and recorded.
    const other = await running.run("other-flow", () =>
      attempt(() => worker.query(id, MERGE)),
    );
    assert.equal(other.success, false);
    assert.match(
      other.error ?? "",
      /^workflow:other-flow is not allowed to write to bigquery_write/,
    );
    assert.match(other.error ?? "", /Access tab/);
    assert.doesNotMatch(other.error ?? "", /allowAgentWrites|read-only/);
    recorded = await events(2);
    assert.equal(recorded[1].principal, "workflow:other-flow");
    assert.equal(recorded[1].allowed, false);
    assert.equal(recorded[1].target, "crm_ai_chat.chat_labels");

    // A name not deployed from main is not believed: the worker writes as
    // no one listable, never as the person who deployed it.
    const stranger = await running.run("not-deployed", () =>
      attempt(() => worker.query(id, MERGE)),
    );
    assert.equal(stranger.success, false);
    assert.match(
      stranger.error ?? "",
      /^worker:workflows is not allowed to write to bigquery_write/,
    );
    recorded = await events(3);
    assert.equal(recorded[2].principal, "worker:workflows");
    assert.equal(recorded[2].allowed, false);

    // A person's key naming a workflow is still the person. It has no
    // runtime scope, so it goes through the MCP tool.
    const person = await load(PERSON_KEY);
    const mine = (await running.run("crm-chat-classifier", () =>
      person.call("sql_execute_query", { connectionId: id, query: MERGE }),
    )) as Answer;
    assert.equal(mine.success, false);
    assert.match(
      mine.error ?? "",
      /^user:deployer is not allowed to write to bigquery_write/,
    );
    recorded = await events(4);
    assert.equal(recorded[3].principal, "user:deployer");
    assert.equal(recorded[3].allowed, false);
    assert.equal(ran.length, 1, "no refused write reached the driver");

    // A read needs no list.
    const read = await running.run("other-flow", () =>
      attempt(() =>
        worker.query(id, "SELECT 1 FROM `realadvisor-prod.crm_ai_chat.x`"),
      ),
    );
    assert.equal(read.success, true, read.error);
    assert.equal(ran.length, 2);

    console.log("workflow worker identity tests passed");
  } finally {
    // The MCP client keeps its connections open.
    server.closeAllConnections();
    server.close();
    // Query tracking is written without waiting: let it land.
    await new Promise(resolve => setTimeout(resolve, 300));
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
