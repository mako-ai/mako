/**
 * The ad-hoc execute routes (POST …/databases/:id/execute and
 * POST …/execute) as workspace members with their own API keys. Users,
 * workspace, keys, connections and consoles live in PGlite. A separate
 * in-memory Mongo only holds the data the MongoDB queries run against:
 *
 * - a viewer only reads, even when on the connection's writers list;
 * - a request body cannot set the write check's own flags;
 * - results are capped at QUERY_EXECUTE_MAX_ROWS and marked `truncated`;
 * - a MongoDB shell query cannot reach the API process.
 *
 * Postgres is stubbed: only what reaches it is under test.
 *
 * Run with: pnpm --filter api exec tsx src/routes/workspace-execute-access.db.test.ts
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { OpenAPIHono } from "@hono/zod-openapi";

import { hashApiKey } from "../auth/api-key.middleware";
import { loggingMiddleware } from "../logging";
import { connectionsRepo } from "../repositories/connections";
import { consolesChartsRepo } from "../repositories/consoles-charts";
import { workspaceRepo } from "../repositories/workspaces";
import {
  ensureTestMember,
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
} from "../test-support/pg-test";
import { queryExecutionService } from "../services/query-execution.service";
import { databaseConnectionService } from "../services/database-connection.service";
import {
  workspaceDatabaseRoutes,
  workspaceExecuteRoutes,
} from "./workspace-databases";
import { consoleRoutes } from "./consoles";

const PEOPLE = ["owner", "marc", "nina", "vic"] as const;
type Person = (typeof PEOPLE)[number];
const ROLE: Record<Person, "owner" | "member" | "viewer"> = {
  owner: "owner",
  marc: "member",
  nina: "member",
  vic: "viewer",
};
const keyOf = (p: Person) => `revops_execute_access_${p}_tests_only`;
const CAP = 10;

const app = new OpenAPIHono();
// The request context names who is acting, as in the server (index.ts).
app.use("*", loggingMiddleware({}));
app.route("/api/workspaces/:workspaceId/databases", workspaceDatabaseRoutes);
app.route("/api/workspaces/:workspaceId/execute", workspaceExecuteRoutes);
app.route("/api/workspaces/:workspaceId/consoles", consoleRoutes);

interface ExecuteBody {
  success: boolean;
  error?: string;
  data?: unknown;
  rows?: unknown[];
  rowCount?: number;
  truncated?: boolean;
  rowLimit?: number;
  warnings?: string[];
}

async function main() {
  process.env.QUERY_EXECUTE_MAX_ROWS = String(CAP);
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  const mongo = await MongoMemoryServer.create();
  const mongoClient = await MongoClient.connect(mongo.getUri());
  const pgh = await setupPgTestDb();
  // Wait for fire-and-forget execution records before closing their database.
  const tracking = mock.method(queryExecutionService, "trackAsync");
  try {
    const ws = (await ensureTestWorkspace(pgh.db)).id;
    for (const p of PEOPLE) {
      await ensureTestUser(pgh.db, { id: p, email: `${p}@example.com` });
      await ensureTestMember(pgh.db, {
        workspaceId: ws,
        userId: p,
        role: ROLE[p],
      });
      await workspaceRepo.createApiKey({
        workspaceId: ws,
        name: p,
        keyHash: hashApiKey(keyOf(p)),
        prefix: keyOf(p).slice(0, 14),
        createdAt: new Date(),
        createdBy: p,
      });
    }

    // The data the queries run against: another database, same server.
    const shop = mongoClient.db("shop");
    await shop
      .collection("big")
      .insertMany(Array.from({ length: 25 }, (_, i) => ({ i })));
    await shop.collection("users").insertOne({ name: "ana" });

    // vic (a viewer) and marc are writers; nina is not.
    const mongoConn = await connectionsRepo.createDatabaseConnection({
      workspaceId: ws,
      name: "Shop",
      type: "mongodb",
      connection: { connectionString: mongo.getUri(), database: "shop" },
      createdBy: "owner",
      writers: [{ principal: "user:vic" }, { principal: "user:marc" }],
    });
    const pgConn = await connectionsRepo.createDatabaseConnection({
      workspaceId: ws,
      name: "Warehouse",
      type: "postgresql",
      connection: { host: "127.0.0.1", port: 1, database: "none" },
      createdBy: "owner",
      writers: [{ principal: "user:vic" }, { principal: "user:marc" }],
    });
    let pgSeen: { readOnlyTransaction?: boolean } | undefined;
    const seenReadOnly = () => pgSeen?.readOnlyTransaction;
    const service = databaseConnectionService as unknown as {
      executePostgreSQLQuery: (
        db: unknown,
        q: unknown,
        o?: { readOnlyTransaction?: boolean },
      ) => Promise<unknown>;
      executePostgreSQLCursor: (
        db: unknown,
        q: unknown,
        o: {
          readOnlyTransaction?: boolean;
          onRows: (r: Record<string, unknown>[]) => void;
        },
      ) => Promise<unknown>;
    };
    service.executePostgreSQLQuery = async (_db, _q, o) => {
      pgSeen = o;
      return { success: true, data: [], rowCount: 0 };
    };
    // A Postgres read of 1,000 rows a batch, stopping like the real cursor.
    let pgBatches = 0;
    service.executePostgreSQLCursor = async (_db, _q, o) => {
      pgSeen = o;
      pgBatches = 0;
      const rows: Record<string, unknown>[] = [];
      for (let at = 0; at < 100_000; at += 1000) {
        const batch = Array.from({ length: 1000 }, (_, i) => ({ n: at + i }));
        pgBatches++;
        rows.push(...batch);
        try {
          o.onRows(batch);
        } catch {
          break;
        }
      }
      return { success: true, data: rows, rowCount: rows.length, fields: [] };
    };

    const call = async (p: Person, path: string, body: unknown) => {
      const response = await app.request(path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keyOf(p)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json()) as ExecuteBody,
      };
    };
    const byId = (p: Person, conn: { id: string }, body: unknown) =>
      call(p, `/api/workspaces/${ws}/databases/${conn.id}/execute`, body);
    const adhoc = (p: Person, conn: { id: string }, body: object) =>
      call(p, `/api/workspaces/${ws}/execute`, {
        connectionId: conn.id,
        ...body,
      });
    const users = () => shop.collection("users").countDocuments();

    // ── A viewer only reads, even as a listed writer ─────────────────
    let res = await byId("vic", mongoConn, {
      query: "db.users.insertOne({ name: 'vic' })",
    });
    assert.equal(res.status, 403);
    assert.match(
      res.body.error ?? "",
      /Viewers can only run queries that read/,
    );
    res = await adhoc("vic", mongoConn, { query: "db.users.deleteMany({})" });
    assert.equal(res.status, 403);
    res = await adhoc("vic", mongoConn, {
      query: "db.users.deleteMany({})",
      mode: "preview",
    });
    assert.equal(res.status, 403);
    // The parsed check: a write spelled to dodge the pattern.
    res = await byId("vic", mongoConn, {
      query: "db.users['insertOne']({ name: 'vic' })",
    });
    assert.equal(res.status, 403);
    assert.equal(await users(), 1, "nothing written by the viewer");
    res = await byId("vic", pgConn, { query: "DELETE FROM t" });
    assert.equal(res.status, 403);
    // A viewer's read runs, and read-only where the engine enforces it.
    res = await byId("vic", mongoConn, { query: "db.users.find({})" });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    pgSeen = undefined;
    res = await byId("vic", pgConn, { query: "SHOW search_path" });
    assert.equal(res.body.success, true);
    assert.equal(seenReadOnly(), true);

    // ── Members keep their writes (as the writers list says) ─────────
    res = await byId("marc", mongoConn, {
      query: "db.users.insertOne({ name: 'marc' })",
    });
    assert.equal(res.body.success, true, res.body.error);
    assert.equal(await users(), 2);
    res = await adhoc("marc", mongoConn, {
      query: "db.users.deleteMany({ name: 'marc' })",
    });
    assert.equal(res.body.success, true, res.body.error);
    assert.equal(await users(), 1);
    // nina is no writer, and the body cannot make her one.
    res = await byId("nina", mongoConn, {
      query: "db.users.insertOne({ name: 'nina' })",
      options: { writeChecked: true, actor: "user:marc" },
    });
    assert.equal(res.body.success, false);
    assert.match(res.body.error ?? "", /only the people and workflows/);
    assert.equal(await users(), 1);
    pgSeen = undefined;
    await byId("nina", pgConn, {
      query: "SHOW search_path",
      options: { readOnlyTransaction: false, writeChecked: true },
    });
    assert.equal(seenReadOnly(), true, "nina reads read-only");

    // ── The row cap ──────────────────────────────────────────────────
    res = await byId("marc", mongoConn, { query: "db.big.find({})" });
    assert.equal(res.body.success, true);
    assert.equal((res.body.data as unknown[]).length, CAP);
    assert.equal(res.body.truncated, true);
    assert.equal(res.body.rowCount, CAP);
    assert.equal(res.body.rowLimit, CAP);
    res = await byId("marc", mongoConn, { query: "db.big.find({}).limit(4)" });
    assert.equal((res.body.data as unknown[]).length, 4);
    assert.equal(res.body.truncated, undefined);
    res = await adhoc("marc", mongoConn, { query: "db.big.find({})" });
    assert.equal(res.body.truncated, true);
    assert.equal((res.body.data as unknown[]).length, CAP);
    // A Mongo preview reads no more than the cap either, and says so.
    res = await adhoc("marc", mongoConn, {
      query: "db.big.find({})",
      mode: "preview",
      pageSize: 500,
    });
    assert.equal(res.body.success, true);
    assert.equal(res.body.rows?.length, CAP);
    assert.ok(
      res.body.warnings?.some(w => /server row cap/.test(w)),
      JSON.stringify(res.body.warnings),
    );
    // Postgres stops reading its cursor just past the cap.
    res = await byId("marc", pgConn, { query: "SELECT * FROM big" });
    assert.equal(res.body.success, true);
    assert.equal((res.body.data as unknown[]).length, CAP);
    assert.equal(res.body.truncated, true);
    assert.equal(pgBatches, 1, "one batch read, not the whole table");

    // ── No way into the API process ──────────────────────────────────
    for (const query of [
      "process.env",
      "this.constructor.constructor('return process')()",
      "require('child_process')",
      "db['constructor']",
    ]) {
      res = await byId("owner", mongoConn, { query });
      assert.equal(res.body.success, false, query);
      assert.doesNotMatch(JSON.stringify(res.body), /ENCRYPTION_KEY/, query);
    }

    // ── A saved console runs with the caller's role, not as an admin ──
    // (the console router gave every API key the admin role).
    const savedConsole = (code: string) =>
      consolesChartsRepo.createConsole({
        workspaceId: ws,
        name: `c-${code.slice(0, 12)}`,
        code,
        language: "mongodb",
        connectionId: mongoConn.id,
        createdBy: "owner",
        access: "workspace",
      });
    const runConsole = (p: Person, saved: { id: string }) =>
      call(p, `/api/workspaces/${ws}/consoles/${saved.id}/execute`, {});
    const writeConsole = await savedConsole(
      "db.users.insertOne({ name: 'from-console' })",
    );
    const before = await users();
    res = await runConsole("vic", writeConsole);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(
      res.body.error ?? "",
      /Viewers can only run queries that read/,
    );
    assert.equal(await users(), before, "the viewer's console wrote nothing");
    res = await runConsole("marc", writeConsole);
    assert.equal(res.body.success, true, res.body.error);
    assert.equal(await users(), before + 1);
    // A viewer's read console runs, capped like the other execute routes.
    res = await runConsole("vic", await savedConsole("db.big.find({})"));
    assert.equal(res.body.success, true, res.body.error);
    assert.equal(res.body.truncated, true);
    assert.equal(res.body.rowCount, CAP);

    console.info("workspace execute access tests passed");
  } finally {
    await databaseConnectionService.closeAllConnections();
    await Promise.all(tracking.mock.calls.map(call => call.result));
    tracking.mock.restore();
    await pgh.close();
    await mongoClient.close();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
