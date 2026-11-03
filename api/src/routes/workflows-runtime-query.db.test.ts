/**
 * The worker's query route (lib/mako `query()` / `execute()`): a statement
 * runs once, its rows come back whole up to a cap counted while reading, a
 * timeout cancels it, it is behind the worker's key, and a write needs the
 * workflow on the connection's writers list.
 *
 * In-memory Mongo. The SQL runs on a real Postgres when
 * MAKO_TEST_POSTGRES_URL is set (e.g. postgres://me@localhost:5432/postgres;
 * the test makes and drops its own schema); otherwise the Postgres reads and
 * writes are answered by a small in-memory stand-in, so everything above the
 * driver (auth, access checks, cap, timeout) still runs.
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
// Each row draws from a sequence: its last value says how often the
// statement ran.
const COUNTED = `SELECT id, nextval('${SCHEMA}.calls') AS n FROM ${SCHEMA}.items ORDER BY id`;
const HUGE = `SELECT g, repeat('x', 100) AS pad FROM generate_series(1, 5000000) AS g`;
const WIDE = `SELECT g, repeat('x', 1000000) AS pad FROM generate_series(1, 60) AS g`;
const SLOW = "SELECT pg_sleep(5)";
const RETURNING = `UPDATE ${SCHEMA}.items SET body = 'changed' WHERE id <= 3 RETURNING id`;
const UPDATE = `UPDATE ${SCHEMA}.items SET body = 'again' WHERE id <= 5`;

type Answer = {
  rows: Array<Record<string, unknown>>;
  fields: Array<{ name: string }>;
  rowCount: number;
  error?: string;
};

const app = new Hono();
app.use("*", loggingMiddleware({}));
app.route("/api/workflows/runtime", workflowRuntimeRoutes);

const post = async (
  key: string,
  body: unknown,
  workflow?: string,
): Promise<{ status: number; answer: Answer; ms: number }> => {
  const started = Date.now();
  const res = await app.request("/api/workflows/runtime/query", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(workflow ? { "x-mako-workflow": workflow } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    answer: (await res.json()) as Answer,
    ms: Date.now() - started,
  };
};

/**
 * Stands in for Postgres: the cursor read hands rows over a batch at a time
 * as the real one does, and counts how often a statement ran and how many
 * batches were read.
 */
function stubPostgres() {
  const items = Array.from({ length: ROWS }, (_, i) => ({
    id: i + 1,
    body: i === 0 ? LONG : `row ${i + 1}`,
  }));
  const stats = { runs: new Map<string, number>(), batches: 0, sequence: 0 };
  const ran = (q: string) => stats.runs.set(q, (stats.runs.get(q) ?? 0) + 1);
  const service = databaseConnectionService as unknown as {
    executePostgreSQLCursor: (
      db: unknown,
      q: string,
      o: { onRows: (rows: Record<string, unknown>[]) => void },
    ) => Promise<unknown>;
    executePostgreSQLQuery: (db: unknown, q: string) => Promise<unknown>;
  };
  service.executePostgreSQLCursor = async (_db, q, { onRows }) => {
    ran(q);
    const rowAt = (i: number): Record<string, unknown> | null => {
      if (q === SELECT) return items[i] ?? null;
      if (q === COUNTED) {
        return items[i] ? { id: items[i].id, n: ++stats.sequence } : null;
      }
      if (q === HUGE) {
        return i < 5_000_000 ? { g: i + 1, pad: "x".repeat(100) } : null;
      }
      if (q === WIDE) {
        return i < 60 ? { g: i + 1, pad: "x".repeat(1_000_000) } : null;
      }
      throw new Error(`Unexpected read: ${q}`);
    };
    if (q === SLOW) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      return { success: true, data: [{ pg_sleep: "" }] };
    }
    const rows: Record<string, unknown>[] = [];
    try {
      for (let i = 0; ; i += 1000) {
        const batch: Record<string, unknown>[] = [];
        for (let j = i; j < i + 1000; j++) {
          const row = rowAt(j);
          if (!row) break;
          batch.push(row);
        }
        stats.batches++;
        onRows(batch);
        rows.push(...batch);
        if (batch.length < 1000) break;
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
    return {
      success: true,
      data: rows,
      rowCount: rows.length,
      fields: Object.keys(rows[0] ?? {}).map(name => ({ name })),
    };
  };
  service.executePostgreSQLQuery = async (_db, q) => {
    ran(q);
    if (q === RETURNING) {
      for (const item of items.slice(0, 3)) item.body = "changed";
      return {
        success: true,
        data: [{ id: 1 }, { id: 2 }, { id: 3 }],
        rowCount: 3,
      };
    }
    if (q === UPDATE) {
      for (const item of items.slice(0, 5)) item.body = "again";
      return { success: true, data: [], rowCount: 5 };
    }
    return { success: false, error: `Unexpected query: ${q}` };
  };
  return stats;
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
      writers: [{ principal: "workflow:crm-chat-classifier" }],
    });
    const connectionId = String(db._id);
    const target = db;
    let stats: ReturnType<typeof stubPostgres> | null = null;

    if (postgresUrl) {
      // Set up as Mako itself: not checked against the writers list.
      const setup = await asSystem(() =>
        databaseConnectionService.executeQuery(
          target as never,
          `CREATE SCHEMA ${SCHEMA};
           CREATE SEQUENCE ${SCHEMA}.calls;
           CREATE TABLE ${SCHEMA}.items (id int PRIMARY KEY, body text NOT NULL);
           INSERT INTO ${SCHEMA}.items
             SELECT i, CASE WHEN i = 1 THEN repeat('x', 5000) ELSE 'row ' || i END
             FROM generate_series(1, ${ROWS}) AS i;`,
        ),
      );
      assert.equal(setup.success, true, setup.error);
    } else {
      stats = stubPostgres();
    }
    /** How often COUNTED ran: the sequence, or the stand-in's count. */
    const runsOfCounted = async () => {
      if (stats) return stats.runs.get(COUNTED) ?? 0;
      const r = await asSystem(() =>
        databaseConnectionService.executeQuery(
          target as never,
          `SELECT last_value FROM ${SCHEMA}.calls`,
        ),
      );
      const last = Number(
        (r.data as Array<{ last_value: string }>)[0].last_value,
      );
      return last / ROWS;
    };

    // Only the worker's key: none, or a key without workflows:runtime.
    assert.equal((await post("", { connectionId, query: SELECT })).status, 401);
    assert.equal(
      (await post(OTHER_KEY, { connectionId, query: SELECT })).status,
      403,
    );
    // The body is checked.
    assert.equal((await post(WORKER_KEY, { connectionId })).status, 400);
    for (const maxRows of [0, 100_001, 1.5, "10"]) {
      assert.equal(
        (await post(WORKER_KEY, { connectionId, query: SELECT, maxRows }))
          .status,
        400,
        `maxRows ${maxRows}`,
      );
    }
    assert.equal(
      (
        await post(WORKER_KEY, {
          connectionId,
          query: SELECT,
          timeoutMs: 16 * 60_000,
        })
      ).status,
      400,
    );

    // A read: every row, whole values, no LIMIT added.
    const all = await post(WORKER_KEY, { connectionId, query: SELECT });
    assert.equal(all.status, 200, all.answer.error);
    assert.equal(all.answer.rows.length, ROWS);
    assert.equal(all.answer.rowCount, ROWS);
    assert.equal(all.answer.rows[0].body, LONG, "a long cell comes back whole");
    assert.deepEqual(
      all.answer.fields.map(f => f.name),
      ["id", "body"],
    );
    assert.deepEqual(
      all.answer.rows.map(r => r.id),
      Array.from({ length: ROWS }, (_, i) => i + 1),
    );

    // The statement runs once, whatever the size of the result.
    const counted = await post(
      WORKER_KEY,
      { connectionId, query: COUNTED },
      "crm-chat-classifier",
    );
    assert.equal(counted.status, 200, counted.answer.error);
    assert.equal(counted.answer.rows.length, ROWS);
    assert.equal(await runsOfCounted(), 1, "the statement ran exactly once");

    // The cap is counted while reading: past it the read stops.
    const huge = await post(WORKER_KEY, { connectionId, query: HUGE });
    assert.equal(huge.status, 400);
    assert.match(
      huge.answer.error ?? "",
      /more than 100000 rows\. Aggregate or filter in SQL/,
    );
    if (stats) {
      assert.ok(
        stats.batches > 100 && stats.batches < 110,
        `read ${stats.batches} batches of 5000`,
      );
    }
    // maxRows lowers it.
    const low = await post(WORKER_KEY, {
      connectionId,
      query: SELECT,
      maxRows: 100,
    });
    assert.equal(low.status, 400);
    assert.match(low.answer.error ?? "", /more than 100 rows/);
    // And bytes count too.
    const wide = await post(WORKER_KEY, { connectionId, query: WIDE });
    assert.equal(wide.status, 400);
    assert.match(wide.answer.error ?? "", /over 50 MB/);

    // A timeout cancels the statement.
    const slow = await post(WORKER_KEY, {
      connectionId,
      query: SLOW,
      timeoutMs: 1000,
    });
    assert.equal(slow.status, 400);
    assert.match(slow.answer.error ?? "", /did not finish within 1s/);
    assert.ok(slow.ms < 3000, `answered after ${slow.ms}ms`);
    if (postgresUrl) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const active = await asSystem(() =>
        databaseConnectionService.executeQuery(
          target as never,
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE '%pg_sleep(5)%' AND state = 'active' AND pid <> pg_backend_pid()",
        ),
      );
      assert.equal(
        (active.data as Array<{ n: number }>)[0].n,
        0,
        "the database stopped the statement",
      );
    }

    // A deployed workflow not on the writers list may read, not write.
    const refused = await post(
      WORKER_KEY,
      { connectionId, query: RETURNING },
      "other-flow",
    );
    assert.equal(refused.status, 400);
    assert.match(
      refused.answer.error ?? "",
      /^workflow:other-flow is not allowed to write to local_pg/,
    );
    const read = await post(
      WORKER_KEY,
      { connectionId, query: SELECT },
      "other-flow",
    );
    assert.equal(read.status, 200, read.answer.error);
    assert.equal(
      read.answer.rows[0].body,
      LONG,
      "the refused write ran nowhere",
    );

    // The listed workflow writes through query(): its RETURNING rows come
    // back.
    const returning = await post(
      WORKER_KEY,
      { connectionId, query: RETURNING },
      "crm-chat-classifier",
    );
    assert.equal(returning.status, 200, returning.answer.error);
    assert.deepEqual(returning.answer.rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.equal(returning.answer.rowCount, 3);
    // And as execute() sends it: rowCount is the rows it changed.
    const updated = await post(
      WORKER_KEY,
      { connectionId, query: UPDATE },
      "crm-chat-classifier",
    );
    assert.equal(updated.status, 200, updated.answer.error);
    assert.equal(updated.answer.rowCount, 5);
    assert.deepEqual(updated.answer.rows, []);
    if (stats) {
      assert.equal(stats.runs.get(RETURNING), 1);
      assert.equal(stats.runs.get(UPDATE), 1);
    }
    const after = await post(WORKER_KEY, { connectionId, query: SELECT });
    assert.deepEqual(
      after.answer.rows.slice(0, 6).map(r => r.body),
      ["again", "again", "again", "again", "again", "row 6"],
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
