import { describe, expect, it, vi } from "vitest";
import type { IDatabaseConnection } from "../database/workspace-schema";
import { executeCheckedQuery } from "./checked-query";
import { allEngines, engineFor } from "./engines";

// No _id/workspaceId: a connection being tested, which the write rules pass.
const connection = (type: string) =>
  ({ type, name: type, connection: {} }) as unknown as IDatabaseConnection;

describe("executeCheckedQuery", () => {
  it("refuses read-only execution the analyzer cannot vouch for", async () => {
    const run = vi.fn();
    expect(
      await executeCheckedQuery(
        connection("postgresql"),
        { collection: "c", operation: "find" },
        { readOnly: true },
        run,
      ),
    ).toMatchObject({ success: false, error: /only supports SQL strings/ });
    expect(
      await executeCheckedQuery(
        connection("postgresql"),
        "DELETE FROM t",
        { readOnly: true },
        run,
      ),
    ).toMatchObject({ success: false });
    expect(
      await executeCheckedQuery(
        connection("cloudflare-kv"),
        "SELECT 1",
        { readOnly: true },
        run,
      ),
    ).toMatchObject({ success: false, error: /not supported for/ });
    expect(run).not.toHaveBeenCalled();
  });

  it("runs a MongoDB read read-only and refuses a write", async () => {
    const run = vi.fn(
      async (_db: unknown, _query: unknown, _options?: unknown) => ({
        success: true,
        data: [],
      }),
    );
    for (const query of [
      "db.users.find({ active: true }).limit(5).toArray()",
      "db.users.aggregate([{ $group: { _id: '$plan', n: { $sum: 1 } } }]).toArray()",
      "db.users.countDocuments({})",
      { collection: "users", operation: "find", filter: {} },
      { collection: "users", operation: "aggregate", pipeline: [] },
    ]) {
      expect(
        await executeCheckedQuery(
          connection("mongodb"),
          query,
          { readOnly: true },
          run,
        ),
      ).toEqual({ success: true, data: [] });
    }
    expect(run).toHaveBeenCalledTimes(5);
    expect(run.mock.calls[0][2]).toMatchObject({ readOnly: true });

    run.mockClear();
    for (const query of [
      "db.users.deleteMany({})",
      "db.users.insertOne({ a: 1 })",
      "db.users.aggregate([{ $out: 'copy' }]).toArray()",
      "db.users.aggregate([{ $merge: { into: 'copy' } }]).toArray()",
      "db.runCommand({ drop: 'users' })",
      'db.users["deleteMany"]({})',
      { collection: "users", operation: "deleteMany", filter: {} },
      {
        collection: "users",
        operation: "aggregate",
        pipeline: [{ $out: "copy" }],
      },
    ]) {
      expect(
        await executeCheckedQuery(
          connection("mongodb"),
          query,
          { readOnly: true },
          run,
        ),
      ).toMatchObject({ success: false, error: /read-only/ });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("runs a checked query and turns a throw into a failure", async () => {
    const run = vi.fn(async () => ({ success: true, data: [] }));
    expect(
      await executeCheckedQuery(
        connection("postgresql"),
        "SELECT 1",
        { readOnly: true },
        run,
      ),
    ).toEqual({ success: true, data: [] });
    expect(
      await executeCheckedQuery(connection("mysql"), "SELECT 1", {}, () => {
        throw new Error("connect ECONNREFUSED");
      }),
    ).toEqual({ success: false, error: "connect ECONNREFUSED" });
  });

  it("answers an unknown type without throwing", async () => {
    expect(await executeCheckedQuery(connection("oracle"), "SELECT 1")).toEqual(
      { success: false, error: "Unsupported database type: oracle" },
    );
  });
});

describe("engines", () => {
  it("shares one engine between PostgreSQL and Redshift", () => {
    expect(engineFor("redshift")).toBe(engineFor("postgresql"));
    expect(engineFor("mssql")).toBeDefined();
    expect(engineFor("oracle")).toBeUndefined();
    const engines = allEngines();
    expect(new Set(engines).size).toBe(engines.length);
  });
});
