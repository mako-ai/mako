import { describe, expect, it } from "vitest";
import {
  ShadowCompareRunner,
  canonicalizeForDiff,
  computeDiffPaths,
  type ShadowCompareEvent,
} from "./shadow-compare";

describe("shadow-compare", () => {
  it("canonicalizes key order, Dates, ObjectId-like values, null/undefined, and float epsilon", () => {
    const fakeOid = { toHexString: () => "6745F6F4A1B2C3D4E5F60718" };
    const ts = new Date("2026-11-26T18:00:00.123Z");

    const mongoDoc = {
      b: 2,
      a: 1,
      _id: fakeOid,
      createdAt: ts,
      costUsd: 0.123456781,
      optionalField: undefined,
    };
    const pgRow = {
      a: 1,
      _id: "6745f6f4a1b2c3d4e5f60718",
      b: 2,
      createdAt: "2026-11-26T18:00:00.123Z",
      costUsd: 0.123456782, // diff = 1e-9 < 1e-8 epsilon
      optionalField: null,
    };

    const diff = computeDiffPaths(mongoDoc, pgRow);
    expect(diff.equal).toBe(true);
    expect(diff.diffs).toEqual([]);

    expect(canonicalizeForDiff({ z: 1, a: undefined, b: null })).toEqual({
      z: 1,
    });
  });

  it("redacts secrets and PII into digests without leaking plaintext values", () => {
    const secretA = "super-secret-bcrypt-hash-ALPHA";
    const secretB = "super-secret-bcrypt-hash-BETA";
    const customSecret = "sk_live_private_credential_123";

    const diff = computeDiffPaths(
      {
        hashedPassword: secretA,
        email: "alice@example.com",
        title: "Old Title",
        nested: { customKey: customSecret },
      },
      {
        hashedPassword: secretB,
        email: "bob@example.com",
        title: "New Title",
        nested: { customKey: "other" },
      },
      { redactKeys: ["customKey"] },
    );

    expect(diff.equal).toBe(false);
    expect(diff.diffs.map(d => d.path)).toEqual([
      "email",
      "hashedPassword",
      "nested.customKey",
      "title",
    ]);

    const byPath = new Map(diff.diffs.map(d => [d.path, d]));
    expect(byPath.get("hashedPassword")?.redacted).toBe(true);
    expect(byPath.get("email")?.redacted).toBe(true);
    expect(byPath.get("nested.customKey")?.redacted).toBe(true);
    expect(byPath.get("title")?.redacted).toBe(false);

    // Ensure raw plaintext never appears anywhere in serialized diff output
    const serialized = JSON.stringify(diff);
    expect(serialized).not.toContain(secretA);
    expect(serialized).not.toContain(secretB);
    expect(serialized).not.toContain(customSecret);
    expect(serialized).not.toContain("alice@example.com");
  });

  it("enforces bounded concurrency semaphore and drops overflow cleanly", async () => {
    const events: ShadowCompareEvent[] = [];
    const runner = new ShadowCompareRunner({
      maxInflight: 2,
      onEvent: e => events.push(e),
    });

    const resolvers: Array<() => void> = [];
    const makeSlowRead = () =>
      new Promise<{ v: number }>(resolve => {
        resolvers.push(() => resolve({ v: 1 }));
      });

    const accepted1 = runner.schedule({
      domain: "chat",
      operation: "get",
      primaryStore: "mongo",
      primaryResult: { v: 1 },
      readShadow: makeSlowRead,
    });
    const accepted2 = runner.schedule({
      domain: "chat",
      operation: "get",
      primaryStore: "mongo",
      primaryResult: { v: 1 },
      readShadow: makeSlowRead,
    });
    const accepted3 = runner.schedule({
      domain: "chat",
      operation: "get",
      primaryStore: "mongo",
      primaryResult: { v: 1 },
      readShadow: async () => ({ v: 1 }),
    });

    expect(accepted1).toBe(true);
    expect(accepted2).toBe(true);
    expect(accepted3).toBe(false);
    expect(runner.inflightCount).toBe(2);

    // Release blocked shadow reads
    for (const r of resolvers) r();
    await runner.flush();

    expect(runner.inflightCount).toBe(0);
    expect(events.map(e => e.result)).toEqual(["dropped", "match", "match"]);
  });

  it("captures shadow read errors cleanly without rejecting", async () => {
    const events: ShadowCompareEvent[] = [];
    const runner = new ShadowCompareRunner({
      onEvent: e => events.push(e),
    });

    runner.schedule({
      domain: "auth",
      operation: "getUser",
      entityId: "u_1",
      primaryStore: "mongo",
      primaryResult: { id: "u_1" },
      readShadow: async () => {
        throw new Error("PG timeout");
      },
    });

    await runner.flush();
    expect(events).toHaveLength(1);
    expect(events[0].result).toBe("error");
    expect(events[0].errorMessage).toContain("PG timeout");
  });
});
