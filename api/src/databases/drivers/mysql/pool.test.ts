/**
 * The MySQL pool lets go of idle connections before the server does.
 *
 * In prod the API logged "Connection lost: The server closed the
 * connection." 4 times in 3 hours, each 30 s after an hourly binding build.
 * maxIdle equalled connectionLimit (2), which switches mysql2's idle reaper
 * off, so idleTimeout never ran and the server's wait_timeout closed the
 * connection instead. The engine then logged an error and tore the pool down.
 */
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IDatabaseConnection } from "../../../database/workspace-schema";

const log = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../../logging", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../logging")>()),
  loggers: { db: () => log },
}));

const createPool = vi.hoisted(() => vi.fn());
vi.mock("mysql2/promise", () => ({ createPool, createConnection: vi.fn() }));

import { MYSQL_POOL_OPTIONS } from "./config";
import { MySQLEngine } from "./engine";

const database = {
  _id: "6577f0f0f0f0f0f0f0f0f0f0",
  type: "mysql",
  name: "mysql-conn",
  connection: { host: "db.internal", database: "app" },
} as unknown as IDatabaseConnection;

function lostConnection(): Error {
  return Object.assign(
    new Error("Connection lost: The server closed the connection."),
    { code: "PROTOCOL_CONNECTION_LOST", fatal: true },
  );
}

function fakePool() {
  const pool = Object.assign(new EventEmitter(), {
    end: vi.fn(async () => undefined),
  });
  createPool.mockReturnValue(pool);
  return pool;
}

/** A pooled connection whose execute() and stream run the given script. */
function fakeConnection(opts: {
  execute?: () => Promise<unknown>;
  rows?: () => AsyncIterable<unknown>;
}) {
  return {
    threadId: null,
    query: vi.fn(async () => [[], []]),
    execute: vi.fn(opts.execute ?? (async () => [[{ id: 1 }], []])),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    destroy: vi.fn(),
    connection: {
      query: () => ({
        stream: () => Readable.from(opts.rows ? opts.rows() : []),
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MySQL pool options", () => {
  it("reaps idle connections well before a server's wait_timeout", async () => {
    fakePool();
    await new MySQLEngine().getPool(database);

    const options = createPool.mock.calls[0][0];
    expect(options).toMatchObject(MYSQL_POOL_OPTIONS);
    // mysql2 runs its idle reaper only when maxIdle < connectionLimit.
    expect(options.maxIdle).toBeLessThan(options.connectionLimit);
    expect(options.idleTimeout).toBeLessThanOrEqual(10_000);
    expect(options.enableKeepAlive).toBe(true);
  });
});

describe("a pooled connection the server closes", () => {
  it("is dropped quietly when idle: no error log, the pool lives", async () => {
    const pool = fakePool();
    const engine = new MySQLEngine();
    await engine.getPool(database);
    const connection = new EventEmitter();
    pool.emit("connection", connection);
    pool.emit("acquire", connection);
    pool.emit("release", connection);

    connection.emit("error", lostConnection());

    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      "MySQL server closed an idle pooled connection",
      expect.objectContaining({ key: `${database._id}:app` }),
    );
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("still logs an error when lost while checked out", async () => {
    const pool = fakePool();
    await new MySQLEngine().getPool(database);
    const connection = new EventEmitter();
    pool.emit("connection", connection);
    pool.emit("acquire", connection);

    connection.emit("error", lostConnection());

    expect(log.error).toHaveBeenCalledWith(
      "MySQL pool connection error",
      expect.anything(),
    );
    expect(pool.end).toHaveBeenCalledOnce();
  });
});

describe("a read that loses its connection", () => {
  function engineWith(...connections: ReturnType<typeof fakeConnection>[]) {
    const engine = new MySQLEngine();
    const getConnection = vi.fn();
    for (const c of connections) getConnection.mockResolvedValueOnce(c);
    vi.spyOn(engine, "getPool").mockResolvedValue({ getConnection } as never);
    return { engine, getConnection };
  }

  it("runs once more on a fresh connection, with no error log", async () => {
    const dead = fakeConnection({
      execute: async () => Promise.reject(lostConnection()),
    });
    const fresh = fakeConnection({});
    const { engine, getConnection } = engineWith(dead, fresh);

    const result = await engine.executeQuery(database, "SELECT 1", {
      readOnly: true,
    });

    expect(result).toMatchObject({ success: true, data: [{ id: 1 }] });
    expect(getConnection).toHaveBeenCalledTimes(2);
    expect(dead.destroy).toHaveBeenCalledOnce();
    expect(dead.release).not.toHaveBeenCalled();
    expect(fresh.release).toHaveBeenCalledOnce();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("retries only once", async () => {
    const reject = async () => Promise.reject(lostConnection());
    const { engine, getConnection } = engineWith(
      fakeConnection({ execute: reject }),
      fakeConnection({ execute: reject }),
      fakeConnection({}),
    );

    const result = await engine.executeQuery(database, "SELECT 1", {
      readOnlyTransaction: true,
    });

    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch(/Connection lost/);
    expect(getConnection).toHaveBeenCalledTimes(2);
  });

  it("never re-runs a statement that may write", async () => {
    const { engine, getConnection } = engineWith(
      fakeConnection({ execute: async () => Promise.reject(lostConnection()) }),
      fakeConnection({}),
    );

    const result = await engine.executeQuery(database, "UPDATE t SET a = 1");

    expect(result).toMatchObject({ success: false });
    expect(getConnection).toHaveBeenCalledOnce();
  });

  it("re-streams when no rows went out yet", async () => {
    const dead = fakeConnection({
      // eslint-disable-next-line require-yield
      rows: async function* () {
        throw lostConnection();
      },
    });
    const fresh = fakeConnection({
      rows: async function* () {
        yield { id: 1 };
        yield { id: 2 };
      },
    });
    const { engine, getConnection } = engineWith(dead, fresh);
    const ids: unknown[] = [];

    const result = await engine.executeStreamingQuery(database, "SELECT id", {
      batchSize: 5,
      readOnly: true,
      onBatch: async rows => {
        ids.push(...rows.map(r => r.id));
      },
    });

    expect(result).toEqual({ success: true, totalRows: 2 });
    expect(ids).toEqual([1, 2]);
    expect(getConnection).toHaveBeenCalledTimes(2);
  });

  it("fails rather than hand rows out twice once a batch went out", async () => {
    const midway = fakeConnection({
      rows: async function* () {
        yield { id: 1 };
        throw lostConnection();
      },
    });
    const { engine, getConnection } = engineWith(midway, fakeConnection({}));
    const ids: unknown[] = [];

    const result = await engine.executeStreamingQuery(database, "SELECT id", {
      batchSize: 1,
      readOnly: true,
      onBatch: async rows => {
        ids.push(...rows.map(r => r.id));
      },
    });

    expect(result).toMatchObject({ success: false, totalRows: 1 });
    expect(ids).toEqual([1]);
    expect(getConnection).toHaveBeenCalledOnce();
    expect(midway.destroy).toHaveBeenCalledOnce();
  });
});
