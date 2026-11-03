/**
 * Workflow code a person runs themselves (`mako workflow run`, a sandbox run)
 * calls the worker's SQL, model and agent routes with the person's own login
 * or key, as that person: the rights they have over /api/mcp, no more. The
 * workflow name they send grants nothing. The deployed worker's key keeps
 * the workflow's rights, and the worker's other routes stay the worker's.
 *
 * Real auth middleware and routes over HTTP, in-memory Mongo. The SQL runs
 * on a real Postgres when MAKO_TEST_POSTGRES_URL is set (the test makes and
 * drops its own schema); otherwise a stand-in answers the driver calls. The
 * AI gateway is a stand-in that records what it was sent.
 *
 * Run with: pnpm --filter api exec tsx src/routes/workflows-runtime-person.db.test.ts
 */
import assert from "node:assert/strict";
import { Hono } from "hono";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { asSystem } from "../access/connection-writes";
import { hashApiKey } from "../auth/api-key.middleware";
import { mintMcpAccessTokenForUser } from "../auth/mcp-oauth.service";
import { User } from "../database/schema";
import {
  DatabaseConnection,
  Workspace,
  WorkspaceMember,
} from "../database/workspace-schema";
import { loggingMiddleware } from "../logging";
import { databaseConnectionService } from "../services/database-connection.service";
import { WORKER_KEY_SCOPES, workerKeyName } from "../workflows/worker-key";
import { workflowRuntimeRoutes } from "./workflows";

const WORKER_KEY = "revops_worker_runtime_person_tests_";
const NO_RUN_KEY = "revops_person_without_run_scope_xx";
const SCHEMA = `mako_rp_${Date.now().toString(36)}`;
const WRITE = (table: string) =>
  `INSERT INTO ${SCHEMA}.${table} (id) VALUES (1)`;

const app = new Hono();
app.use("*", loggingMiddleware({}));
app.route("/api/workflows/runtime", workflowRuntimeRoutes);

const call = async (
  method: "GET" | "POST",
  path: string,
  key: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const res = await app.request(`/api/workflows/runtime${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

async function main() {
  const postgresUrl = process.env.MAKO_TEST_POSTGRES_URL;
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  process.env.AI_GATEWAY_API_KEY = "gateway-key";
  const ws = new Types.ObjectId();
  let db: { _id: Types.ObjectId } | null = null;
  try {
    for (const id of ["deployer", "marc"]) {
      await User.create({ _id: id, email: `${id}@example.com` });
      await WorkspaceMember.create({
        workspaceId: ws,
        userId: id,
        role: id === "deployer" ? "owner" : "member",
        joinedAt: new Date(),
      });
    }
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
    await Workspace.collection.insertOne({
      _id: ws,
      name: "t",
      slug: `t-${ws}`,
      createdBy: "deployer",
      settings: {},
      apiKeys: [
        key(workerKeyName(), WORKER_KEY, WORKER_KEY_SCOPES, "deployer"),
        key("Marc's MCP", NO_RUN_KEY, ["mcp", "query:write"], "marc"),
      ],
      workflows: {
        live: { sha: "a".repeat(40), tree: "t", names: ["billing-sync"] },
      },
    });
    db = await DatabaseConnection.create({
      workspaceId: ws,
      name: "local_pg",
      type: "postgresql",
      connection: postgresUrl
        ? {
            connectionString: postgresUrl,
            database: new URL(postgresUrl).pathname.slice(1) || "postgres",
          }
        : { host: "stub", database: "stub" },
      createdBy: "deployer",
      writers: [
        { principal: "user:marc", where: `${SCHEMA}.marcs` },
        { principal: "workflow:billing-sync", where: `${SCHEMA}.workflows` },
      ],
    });
    const connectionId = String(db._id);
    const target = db;
    if (postgresUrl) {
      const setup = await asSystem(() =>
        databaseConnectionService.executeQuery(
          target as never,
          `CREATE SCHEMA ${SCHEMA};
           CREATE TABLE ${SCHEMA}.marcs (id int);
           CREATE TABLE ${SCHEMA}.workflows (id int);`,
        ),
      );
      assert.equal(setup.success, true, JSON.stringify(setup));
    } else {
      const service = databaseConnectionService as unknown as Record<
        "executePostgreSQLQuery" | "executePostgreSQLCursor",
        (db: unknown, q: string) => Promise<unknown>
      >;
      service.executePostgreSQLQuery = service.executePostgreSQLCursor =
        async () => ({ success: true, data: [{ one: 1 }], rowCount: 1 });
    }
    const query = (key: string, sql: string, workflow?: string) =>
      call(
        "POST",
        "/query",
        key,
        { connectionId, query: sql },
        workflow ? { "x-mako-workflow": workflow } : {},
      );

    // A person's login (`mako login`, an MCP OAuth token) reads through /query,
    // with or without a workflow's name, a draft's too.
    const { accessToken: login } = await mintMcpAccessTokenForUser({
      userId: "marc",
      workspaceId: String(ws),
    });
    for (const workflow of [undefined, "billing-sync", "draft-flow"]) {
      const res = await query(login, "SELECT 1 AS one", workflow);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.rows, [{ one: 1 }]);
    }
    // As themselves over /api/mcp: a login reads only, and naming the
    // workflow does not give it the workflow's write.
    let res = await query(login, WRITE("workflows"), "billing-sync");
    assert.equal(res.status, 400);

    // A person's login calls a model route; Mako's gateway key goes on.
    const sent: Array<{ url: string; auth: string | null }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      sent.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(
        JSON.stringify({ content: [], finishReason: "stop" }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;
    try {
      res = await call(
        "POST",
        "/ai/language-model",
        login,
        { prompt: [] },
        {
          "ai-language-model-id": "anthropic/claude-haiku-4.5",
          "ai-language-model-specification-version": "3",
        },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const gateway = sent.filter(s => s.url.includes("/language-model"));
    assert.equal(gateway.length, 1, JSON.stringify(sent.map(s => s.url)));
    assert.equal(gateway[0].auth, "Bearer gateway-key");

    // The deployed worker is unchanged: the workflow's rights.
    res = await query(WORKER_KEY, WRITE("workflows"), "billing-sync");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    if (postgresUrl) {
      res = await query(WORKER_KEY, WRITE("marcs"), "billing-sync");
      assert.equal(res.status, 400, "not the workflow's table");
    }

    // A person's credential stays out of the worker's own routes.
    for (const path of ["/head", "/source/" + "a".repeat(40)]) {
      const head = await call("GET", path, login);
      assert.equal(head.status, 403, path);
    }
    // And a key needs the workflows:run grant for the runtime routes at all.
    res = await query(NO_RUN_KEY, "SELECT 1 AS one");
    assert.equal(res.status, 403);

    console.log(
      `workflow runtime person tests passed${postgresUrl ? " (real Postgres)" : ""}`,
    );
  } finally {
    if (postgresUrl && db) {
      const target = db;
      await asSystem(() =>
        databaseConnectionService.executeQuery(
          target as never,
          `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`,
        ),
      ).catch(() => undefined);
    }
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
