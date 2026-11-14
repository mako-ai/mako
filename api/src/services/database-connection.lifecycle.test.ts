/**
 * Connection-pool lifecycle and cancellation in databaseConnectionService
 * (review-backend.md #2, #3, #4, #5, #11). Everything below runs against
 * fakes — no database is contacted.
 *
 *  - invalidateConnection(id) evicts every cache for that id (pg, mysql,
 *    mongo, the generic MSSQL cache, every registered driver) and only it;
 *  - Cloud SQL / D1 / KV resolve to the registry's instances (one set);
 *  - concurrent first Mongo connects share one client; a stale client's
 *    close cannot evict its replacement; a connection test pools nothing;
 *  - Postgres streams through one DECLARE CURSOR + FETCH, in the query's
 *    own row order, never LIMIT/OFFSET pages;
 *  - Postgres cancels on the signal alone, using client.processID;
 *  - MySQL queries are registered and cancelled with KILL QUERY.
 *
 * Run: tsx src/services/database-connection.lifecycle.test.ts
 */
import assert from "node:assert/strict";
import { DatabaseConnectionService } from "./database-connection.service";
import { databaseRegistry } from "../databases/registry";
import type { DatabaseDriver } from "../databases/driver";

const ID = "6577f0f0f0f0f0f0f0f0f0f0";
const OTHER = "6577f0f0f0f0f0f0f0f0f0f1";

function conn(type: string, id = ID): any {
  return {
    _id: { toString: () => id },
    type,
    name: `${type}-conn`,
    connection: { host: "127.0.0.1", port: 1, database: "app" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function testInvalidateConnection() {
  const svc = new DatabaseConnectionService() as any;
  const closed: string[] = [];
  const closable = (name: string) => ({
    end: async () => void closed.push(name),
    close: async () => void closed.push(name),
  });

  svc.postgresPools.set(`${ID}:app`, {
    pool: closable("pg:app"),
    lastUsed: new Date(),
  });
  svc.postgresPools.set(`${ID}:other`, {
    pool: closable("pg:other"),
    lastUsed: new Date(),
  });
  svc.postgresPools.set(`${OTHER}:app`, {
    pool: closable("pg:keep"),
    lastUsed: new Date(),
  });
  svc.mysqlPools.set(`${ID}:app`, {
    pool: closable("mysql:app"),
    lastUsed: new Date(),
  });
  svc.mongoConnections.set(`datasource:${ID}`, {
    client: closable("mongo"),
    db: {},
    lastUsed: new Date(),
    context: "datasource",
    identifier: ID,
  });
  svc.connections.set(ID, closable("mssql"));

  // Every registered driver's cache is honoured, and one throwing cache
  // does not keep the rest serving the old configuration.
  const driverCalls: string[] = [];
  const fakeDriver = (type: string, fail = false): DatabaseDriver => ({
    getMetadata: () => ({ type, displayName: type, consoleLanguage: "sql" }),
    getTreeRoot: async () => [],
    getChildren: async () => [],
    executeQuery: async () => ({ success: true }),
    closeConnection: async (id: string) => {
      driverCalls.push(`${type}:${id}`);
      if (fail) throw new Error("boom");
    },
  });
  databaseRegistry.register(fakeDriver("lifecycle-failing", true));
  databaseRegistry.register(fakeDriver("lifecycle-fake"));

  await svc.invalidateConnection(ID);

  assert.deepEqual(
    closed.sort(),
    ["mongo", "mssql", "mysql:app", "pg:app", "pg:other"].sort(),
  );
  assert.deepEqual([...svc.postgresPools.keys()], [`${OTHER}:app`]);
  assert.equal(svc.mysqlPools.size, 0);
  assert.equal(svc.mongoConnections.size, 0);
  assert.equal(svc.connections.size, 0);
  assert.ok(driverCalls.includes(`lifecycle-failing:${ID}`));
  assert.ok(
    driverCalls.includes(`lifecycle-fake:${ID}`),
    "a failing cache does not stop the next one",
  );
  // The registry is process-wide: stop the failing fake failing.
  databaseRegistry.register(fakeDriver("lifecycle-failing"));

  // closeConnection (the delete route) is the same eviction.
  svc.postgresPools.set(`${ID}:app`, {
    pool: closable("pg:again"),
    lastUsed: new Date(),
  });
  await svc.closeConnection(ID);
  assert.equal(svc.postgresPools.has(`${ID}:app`), false);
  await svc.closeAllConnections();
}

async function testSharedDriverInstances() {
  const svc = new DatabaseConnectionService() as any;
  for (const type of ["cloudsql-postgres", "cloudflare-d1", "cloudflare-kv"]) {
    const getter =
      type === "cloudsql-postgres"
        ? "cloudSqlDriver"
        : type === "cloudflare-d1"
          ? "d1Driver"
          : "kvDriver";
    assert.equal(
      svc[getter],
      databaseRegistry.getDriver(type),
      `${type}: the service uses the registry's instance`,
    );
  }
  // index.ts registers through getOrRegister, so it gets the same object.
  assert.equal(
    databaseRegistry.getOrRegister("cloudsql-postgres", () => {
      throw new Error("must not construct a second instance");
    }),
    svc.cloudSqlDriver,
  );
  await svc.closeAllConnections();
}

async function testMongoDedupeAndGuard() {
  const svc = new DatabaseConnectionService() as any;
  const gate = deferred<void>();
  let creates = 0;
  const client = { close: async () => undefined };
  svc.createMongoConnection = async (context: string, identifier: string) => {
    creates++;
    await gate.promise;
    const entry = {
      client,
      db: { name: "db" },
      lastUsed: new Date(),
      context,
      identifier,
    };
    svc.mongoConnections.set(`${context}:${identifier}`, entry);
    return { client, db: entry.db };
  };
  const config = { connectionString: "mongodb://x", database: "db" };
  const first = svc.getMongoConnection("datasource", ID, config);
  const second = svc.getMongoConnection("datasource", ID, config);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(creates, 1, "concurrent first connects share one client");
  assert.equal(a.client, b.client);
  assert.equal(svc.mongoConnecting.size, 0, "in-flight entry is cleared");

  // Reuse needs no ping (the old health check cost a round trip per query).
  await svc.getMongoConnection("datasource", ID, config);
  assert.equal(creates, 1);

  // A replaced client's late close/error must not evict the live entry.
  const live = { close: async () => undefined };
  svc.mongoConnections.set(`datasource:${ID}`, {
    client: live,
    db: {},
    lastUsed: new Date(),
    context: "datasource",
    identifier: ID,
  });
  assert.equal(svc.forgetMongoClient(`datasource:${ID}`, client), false);
  assert.equal(svc.mongoConnections.get(`datasource:${ID}`).client, live);
  assert.equal(svc.forgetMongoClient(`datasource:${ID}`, live), true);
  assert.equal(svc.mongoConnections.size, 0);

  // Invalidating while a connect is in flight closes that client once it
  // lands instead of leaving it pooled with the retired configuration.
  const slow = deferred<void>();
  let closedInFlight = 0;
  const pendingClient = {
    close: async () => {
      closedInFlight++;
    },
  };
  svc.createMongoConnection = async (context: string, identifier: string) => {
    await slow.promise;
    svc.mongoConnections.set(`${context}:${identifier}`, {
      client: pendingClient,
      db: {},
      lastUsed: new Date(),
      context,
      identifier,
    });
    return { client: pendingClient, db: {} };
  };
  const connecting = svc.getMongoConnection("datasource", ID, config);
  const invalidating = svc.invalidateConnection(ID);
  slow.resolve();
  await connecting;
  await invalidating;
  assert.equal(closedInFlight, 1);
  assert.equal(svc.mongoConnections.size, 0);

  // A connection test (often an unsaved candidate with a random _id) never
  // goes through the pool.
  let pooled = 0;
  svc.getMongoConnection = async () => {
    pooled++;
    throw new Error("must not pool");
  };
  const test = await svc.testConnection({
    _id: { toString: () => "candidate" },
    type: "mongodb",
    connection: { connectionString: "mongodb://" },
  });
  assert.equal(test.success, false);
  assert.equal(pooled, 0, "testConnection uses a throwaway client");
  await svc.closeAllConnections();
}

/** A fake pg client: a cursor over `rows`, recording every statement. */
function fakePgClient(rows: Array<Record<string, unknown>>) {
  const statements: string[] = [];
  let cursor = 0;
  const client = {
    processID: 4242,
    released: [] as unknown[],
    statements,
    hang: null as null | {
      promise: Promise<never>;
      reject: (e: unknown) => void;
    },
    async query(input: string | { text: string }) {
      const text = typeof input === "string" ? input : input.text;
      statements.push(text);
      if (client.hang && text.startsWith("FETCH")) return client.hang.promise;
      const fetch = /^FETCH (\d+) FROM/.exec(text);
      if (fetch) {
        const n = Number(fetch[1]);
        const batch = rows.slice(cursor, cursor + n);
        cursor += n;
        return { rows: batch, fields: [{ name: "id", dataTypeID: 23 }] };
      }
      return { rows: [], fields: [] };
    },
    release(destroy?: unknown) {
      client.released.push(destroy);
    },
  };
  return client;
}

async function testPostgresCursorStreaming() {
  const svc = new DatabaseConnectionService() as any;
  // Deliberately not sorted: the stream must keep the server's order.
  const rows = [5, 3, 9, 1, 7, 2, 8].map(id => ({ id }));
  const client = fakePgClient(rows);
  svc.getPostgresPool = async () => ({ connect: async () => client });

  const batches: number[][] = [];
  const result = await svc.executeStreamingQuery(
    conn("postgresql"),
    "SELECT id FROM t -- trailing comment",
    {
      batchSize: 3,
      onBatch: async (batch: Array<{ id: number }>) => {
        batches.push(batch.map(r => r.id));
      },
    },
  );
  assert.deepEqual(result, { success: true, totalRows: 7 });
  assert.deepEqual(batches, [[5, 3, 9], [1, 7, 2], [8]]);
  assert.equal(
    client.statements.filter(s => /DECLARE _mako_rows NO SCROLL CURSOR/.test(s))
      .length,
    1,
    "the query is declared once",
  );
  assert.ok(
    client.statements.every(s => !/\bOFFSET\b/i.test(s)),
    "no OFFSET paging",
  );
  assert.ok(client.statements.includes("FETCH 3 FROM _mako_rows"));
  assert.equal(client.statements.at(-1), "COMMIT");
  assert.ok(
    !client.statements.some(s => /pg_backend_pid/.test(s)),
    "no pid round trip",
  );

  // Read-only streaming uses the same cursor, in a READ ONLY transaction.
  const ro = fakePgClient(rows);
  svc.getPostgresPool = async () => ({ connect: async () => ro });
  const roResult = await svc.executeStreamingQuery(
    conn("postgresql"),
    "SELECT id FROM t",
    { readOnly: true, batchSize: 100, onBatch: async () => undefined },
  );
  assert.equal(roResult.success, true);
  assert.equal(roResult.totalRows, 7);
  assert.ok(ro.statements.includes("BEGIN TRANSACTION READ ONLY"));
  await svc.closeAllConnections();
}

async function testPostgresSignalCancel() {
  const svc = new DatabaseConnectionService() as any;
  const client = fakePgClient([]);
  const hang = deferred<never>();
  client.hang = { promise: hang.promise, reject: hang.reject };
  hang.promise.catch(() => undefined);
  svc.getPostgresPool = async () => ({ connect: async () => client });
  const cancels: number[] = [];
  svc.cancelPostgresBackend = async (_db: unknown, pid: number) => {
    cancels.push(pid);
    hang.reject(new Error("canceling statement due to user request"));
    return { success: true };
  };

  // No executionId: the signal alone cancels the server-side statement.
  const controller = new AbortController();
  const running = svc.executeQueryReadingRows(conn("postgresql"), "SELECT 1", {
    signal: controller.signal,
    onRows: () => undefined,
  });
  await tick();
  await tick();
  controller.abort();
  const result = await running;
  assert.deepEqual(result, { success: false, error: "Query cancelled" });
  assert.deepEqual(cancels, [4242], "pg_cancel_backend(client.processID)");
  assert.deepEqual(
    client.released,
    [true],
    "a client a cancel was aimed at is destroyed, not pooled",
  );
  await svc.closeAllConnections();
}

async function testMySQLCancel() {
  const svc = new DatabaseConnectionService() as any;
  const makeConnection = () => {
    const kill = deferred<never>();
    kill.promise.catch(() => undefined);
    return {
      threadId: 77,
      kill,
      released: 0,
      destroyed: 0,
      query: async () => [[], []],
      execute: async () => kill.promise,
      commit: async () => undefined,
      rollback: async () => undefined,
      release() {
        this.released++;
      },
      destroy() {
        this.destroyed++;
      },
    };
  };
  let connection = makeConnection();
  svc.getMySQLPool = async () => ({ getConnection: async () => connection });
  const kills: number[] = [];
  svc.killMySQLQuery = async (running: { threadId: number }) => {
    kills.push(running.threadId);
    const error = Object.assign(new Error("Query execution was interrupted"), {
      code: "ER_QUERY_INTERRUPTED",
    });
    connection.kill.reject(error);
    return { success: true };
  };

  // By executionId (agent Stop / detached hard cap → cancelQuery).
  const running = svc.executeMySQLQuery(conn("mysql"), "SELECT SLEEP(100)", {
    executionId: "exec-mysql",
  });
  await tick();
  await tick();
  assert.equal(
    svc.runningMySQLQueries.get("exec-mysql")?.threadId,
    77,
    "a running MySQL query is registered",
  );
  const cancel = await svc.cancelQuery("exec-mysql");
  assert.deepEqual(cancel, { success: true });
  assert.deepEqual(await running, { success: false, error: "Query cancelled" });
  assert.deepEqual(kills, [77]);
  assert.equal(svc.runningMySQLQueries.size, 0);
  assert.equal(connection.destroyed, 1, "a killed connection is retired");
  assert.equal(connection.released, 0);

  // By signal alone.
  connection = makeConnection();
  const controller = new AbortController();
  const bySignal = svc.executeMySQLQuery(conn("mysql"), "SELECT SLEEP(100)", {
    signal: controller.signal,
  });
  await tick();
  await tick();
  controller.abort();
  assert.deepEqual(await bySignal, {
    success: false,
    error: "Query cancelled",
  });
  assert.deepEqual(kills, [77, 77]);

  // A query that finishes normally releases its connection to the pool.
  connection = makeConnection();
  connection.execute = async () => [[{ a: 1 }], []] as never;
  const ok = await svc.executeMySQLQuery(conn("mysql"), "SELECT 1", {
    executionId: "exec-ok",
  });
  assert.equal(ok.success, true);
  assert.equal(connection.released, 1);
  assert.equal(svc.runningMySQLQueries.size, 0);
  await svc.closeAllConnections();
}

async function main() {
  await testInvalidateConnection();
  await testSharedDriverInstances();
  await testMongoDedupeAndGuard();
  await testPostgresCursorStreaming();
  await testPostgresSignalCancel();
  await testMySQLCancel();
  // eslint-disable-next-line no-console
  console.log("database-connection lifecycle tests passed");
}

main()
  .then(() => {
    // Pools and drivers can hold handles open; exit explicitly so this
    // CLI-style test (run via `tsx` in the api `test` script) never hangs CI.
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  })
  .catch(error => {
    console.error(error);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });
