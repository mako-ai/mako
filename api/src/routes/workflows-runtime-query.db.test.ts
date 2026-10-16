/**
 * The worker's query route (lib/mako `query()`): rows come back whole and a
 * page at a time, behind the worker's key, and a write needs the workflow on
 * the connection's writers list.
 *
 * In-memory Mongo. The SQL runs on a real Postgres when
 * MAKO_TEST_POSTGRES_URL is set (e.g. postgres://me@localhost:5432/postgres;
 * the test makes and drops its own schema); otherwise the Postgres driver is
 * replaced by a small in-memory table that answers the same statements, so
 * everything above the driver (auth, access checks, paging) still runs.
 *
 * Run with: pnpm --filter api exec tsx src/routes/workflows-runtime-query.db.test.ts
 */
import assert from "node:assert/strict";
import { Hono } from "hono";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

import { asSystem } from "../access/connection-writes";
import { hashApiKey } from "../auth/api-key.middleware";
import { User } from "../database/schema";
import {
  DatabaseConnection,
  QueryExecution,
  Workspace,
  WorkspaceMember,
} from "../database/workspace-schema";
import { loggingMiddleware } from "../logging";
import { databaseConnectionService } from "../services/database-connection.service";
import { WORKER_KEY_SCOPES, workerKeyName } from "../workflows/worker-key";
import { workflowRuntimeRoutes } from "./workflows";

const WORKER_KEY = "revops_worker_query_route_key_tests";
const OTHER_KEY = "revops_person_query_route_key_tests";
const ROWS = 650;
const LONG = "x".repeat(5000);
const SCHEMA = `mako_wq_${Date.now().toString(36)}`;
const SELECT = `SELECT id, body FROM ${SCHEMA}.items ORDER BY id`;
const UPDATE = `UPDATE ${SCHEMA}.items SET body = 'changed' WHERE id <= 3`;

type Page = {
  rows: Array<{ id: number; body: string }>;
  fields: Array<{ name: string }>;
  rowCount: number;
  nextCursor?: string;
  error?: string;
};

const app = new Hono();
app.use("*", loggingMiddleware({}));
app.route("/api/workflows/runtime", workflowRuntimeRoutes);

const post = async (
  key: string,
  body: unknown,
  workflow?: string,
): Promise<{ status: number; page: Page }> => {
  const res = await app.request("/api/workflows/runtime/query", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(workflow ? { "x-mako-workflow": workflow } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, page: (await res.json()) as Page };
};

/** An in-memory `items` table answering the statements this test sends. */
function stubPostgres() {
  const items = Array.from({ length: ROWS }, (_, i) => ({
    id: i + 1,
    body: i === 0 ? LONG : `row ${i + 1}`,
  }));
  (
    databaseConnectionService as unknown as {
      executePostgreSQLQuery: (db: unknown, q: string) => Promise<unknown>;
    }
  ).executePostgreSQLQuery = async (_db, q) => {
    const page = q.match(
      /^SELECT \* FROM \(\n([\s\S]*)\n\) AS _mako_preview LIMIT (\d+) OFFSET (\d+)$/,
    );
    if (page && page[1] === SELECT) {
      const offset = Number(page[3]);
      return {
        success: true,
        data: items.slice(offset, offset + Number(page[2])),
        fields: [{ name: "id" }, { name: "body" }],
      };
    }
    if (q === UPDATE) {
      for (const item of items.slice(0, 3)) item.body = "changed";
      return { success: true, data: [], rowCount: 3 };
    }
    return { success: false, error: `Unexpected query: ${q}` };
  };
}

async function main() {
  const postgresUrl = process.env.MAKO_TEST_POSTGRES_URL;
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  const ws = new Types.ObjectId();
  let db: { _id: Types.ObjectId } | null = null;
  try {
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
        key(workerKeyName(), WORKER_KEY, WORKER_KEY_SCOPES),
        // May query and write, but is not the worker.
        key("Mine", OTHER_KEY, ["mcp", "query:write"]),
      ],
      workflows: {
        live: {
          sha: "a".repeat(40),
          tree: "t",
          names: ["crm-chat-classifier", "other-flow"],
        },
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
      writers: [{ principal: "workflow:crm-chat-classifier", where: SCHEMA }],
    });
    const connectionId = String(db._id);

    if (postgresUrl) {
      // Set up as Mako itself: not checked against the writers list.
      const setup = await asSystem(() =>
        databaseConnectionService.executeQuery(
          db as never,
          `CREATE SCHEMA ${SCHEMA};
         CREATE TABLE ${SCHEMA}.items (id int PRIMARY KEY, body text NOT NULL);
         INSERT INTO ${SCHEMA}.items
           SELECT i, CASE WHEN i = 1 THEN repeat('x', 5000) ELSE 'row ' || i END
           FROM generate_series(1, ${ROWS}) AS i;`,
        ),
      );
      assert.equal(setup.success, true, setup.error);
    } else {
      stubPostgres();
    }

    // Only the worker's key: none, or a key without workflows:runtime.
    assert.equal((await post("", { connectionId, query: SELECT })).status, 401);
    assert.equal(
      (await post(OTHER_KEY, { connectionId, query: SELECT })).status,
      403,
    );
    // The body is checked.
    assert.equal((await post(WORKER_KEY, { connectionId })).status, 400);
    for (const maxRows of [0, 501, 1.5, "10"]) {
      assert.equal(
        (await post(WORKER_KEY, { connectionId, query: SELECT, maxRows }))
          .status,
        400,
        `maxRows ${maxRows}`,
      );
    }

    // A read: whole values, no LIMIT added, 500 rows a page.
    const first = await post(WORKER_KEY, { connectionId, query: SELECT });
    assert.equal(first.status, 200, first.page.error);
    assert.equal(first.page.rows.length, 500);
    assert.equal(first.page.rowCount, 500);
    assert.equal(first.page.rows[0].body, LONG, "a long cell comes back whole");
    assert.deepEqual(
      first.page.fields.map(f => f.name),
      ["id", "body"],
    );
    assert.ok(first.page.nextCursor);
    const last = await post(WORKER_KEY, {
      connectionId,
      query: SELECT,
      cursor: first.page.nextCursor,
    });
    assert.equal(last.status, 200, last.page.error);
    assert.equal(last.page.rows.length, ROWS - 500);
    assert.equal(last.page.rows.at(-1)?.id, ROWS);
    assert.equal(last.page.nextCursor, undefined);

    // Smaller pages, followed to the end, give every row once.
    const ids: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { status, page } = await post(WORKER_KEY, {
        connectionId,
        query: SELECT,
        maxRows: 100,
        cursor,
      });
      assert.equal(status, 200, page.error);
      ids.push(...page.rows.map(r => r.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 7);
    assert.deepEqual(
      ids,
      Array.from({ length: ROWS }, (_, i) => i + 1),
    );

    // A cursor belongs to its query.
    const mismatch = await post(WORKER_KEY, {
      connectionId,
      query: `${SELECT} DESC`,
      cursor: first.page.nextCursor,
    });
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.page.error ?? "", /cursor/);

    // A deployed workflow not on the writers list may read, not write.
    const refused = await post(
      WORKER_KEY,
      { connectionId, query: UPDATE },
      "other-flow",
    );
    assert.equal(refused.status, 400);
    assert.match(
      refused.page.error ?? "",
      /^workflow:other-flow is not allowed to write to local_pg/,
    );
    const read = await post(
      WORKER_KEY,
      { connectionId, query: SELECT, maxRows: 3 },
      "other-flow",
    );
    assert.equal(read.status, 200, read.page.error);
    assert.equal(read.page.rows[0].body, LONG, "the refused write ran nowhere");

    // The listed workflow writes, inside its schema; rowCount is the rows
    // it changed.
    const wrote = await post(
      WORKER_KEY,
      { connectionId, query: UPDATE },
      "crm-chat-classifier",
    );
    assert.equal(wrote.status, 200, wrote.page.error);
    assert.equal(wrote.page.rowCount, 3);
    assert.deepEqual(wrote.page.rows, []);
    // A write has no pages.
    assert.equal(
      (
        await post(
          WORKER_KEY,
          { connectionId, query: UPDATE, cursor: first.page.nextCursor },
          "crm-chat-classifier",
        )
      ).status,
      400,
    );
    const after = await post(WORKER_KEY, {
      connectionId,
      query: SELECT,
      maxRows: 4,
    });
    assert.deepEqual(
      after.page.rows.map(r => r.body),
      ["changed", "changed", "changed", "row 4"],
    );

    // Each query is in the workspace's query history, like the agent's.
    for (let i = 0; i < 50; i++) {
      if ((await QueryExecution.countDocuments({ workspaceId: ws })) > 0) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(
      (await QueryExecution.countDocuments({
        workspaceId: ws,
        source: "agent",
      })) > 0,
    );

    console.log(
      `workflow runtime query tests passed (${postgresUrl ? "real Postgres" : "stubbed driver"})`,
    );
  } finally {
    if (postgresUrl && db) {
      // As Mako itself, like the setup.
      const target = db;
      const dropped = await asSystem(() =>
        databaseConnectionService.executeQuery(
          target as never,
          `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`,
        ),
      );
      if (!dropped.success) console.error("DROP failed", dropped.error);
      await databaseConnectionService.closeConnection(String(db._id));
    }
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
