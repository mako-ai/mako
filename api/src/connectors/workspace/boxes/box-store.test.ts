/**
 * The Mongo box store against a real (in-memory) Mongo: the compare-and-set
 * rules the scheduler relies on when several API instances share boxes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  ConnectorBox,
  ConnectorBoxTemplate,
  MongoBoxStore,
  type BoxRecord,
} from "./box-store";

let mongo: MongoMemoryServer;
const store = new MongoBoxStore();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await ConnectorBox.init();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await ConnectorBox.deleteMany({});
  await ConnectorBoxTemplate.deleteMany({});
});

const at = (offsetMs = 0) => new Date(Date.UTC(2026, 10, 16, 9) + offsetMs);

function record(overrides: Partial<BoxRecord> = {}): BoxRecord {
  return {
    boxId: `cbx_${Math.random().toString(16).slice(2)}`,
    key: "conn-a:hash-1",
    workspaceId: "ws1",
    connectionId: "conn-a",
    bundleHash: "hash-1",
    state: "idle",
    leasedBy: null,
    leasedAt: null,
    heartbeatAt: null,
    deadline: null,
    createdAt: at(),
    lastUsedAt: at(),
    priorUseAt: null,
    failures: 0,
    runs: 0,
    boxSeconds: 0,
    draining: false,
    runtimeId: null,
    fromTemplate: null,
    stateChangedAt: at(),
    killedAt: null,
    killReason: null,
    ...overrides,
  };
}

const patch = { leasedAt: at(), heartbeatAt: at(), deadline: at(60_000) };

describe("MongoBoxStore", () => {
  it("lets exactly one of many concurrent claims take a box", async () => {
    await store.insert(record());
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.claimReusable("conn-a:hash-1", `run_${i}`, patch),
      ),
    );
    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(await store.countLeased("conn-a:hash-1")).toBe(1);
  });

  it("prefers an idle box to a paused one, and never claims across keys or draining boxes", async () => {
    await store.insert(record({ boxId: "paused", state: "paused" }));
    await store.insert(record({ boxId: "idle", state: "idle" }));
    await store.insert(
      record({ boxId: "other", key: "conn-b:hash-1", connectionId: "conn-b" }),
    );
    await store.insert(record({ boxId: "draining", draining: true }));

    const first = await store.claimReusable("conn-a:hash-1", "run_1", patch);
    const second = await store.claimReusable("conn-a:hash-1", "run_2", patch);
    const third = await store.claimReusable("conn-a:hash-1", "run_3", patch);

    expect(first).toMatchObject({ box: { boxId: "idle" }, from: "idle" });
    expect(second).toMatchObject({ box: { boxId: "paused" }, from: "paused" });
    expect(third).toBeNull();
  });

  it("releases only the lease that holds the box", async () => {
    await store.insert(
      record({ boxId: "b", state: "leased", leasedBy: "run_1" }),
    );

    expect(
      await store.transition(
        "b",
        { state: "leased", leasedBy: "run_2" },
        {
          state: "idle",
        },
      ),
    ).toBeNull();
    const released = await store.transition(
      "b",
      { state: "leased", leasedBy: "run_1" },
      { state: "idle", leasedBy: null },
      { runs: 1, failures: 1, boxSeconds: 2.5 },
    );
    expect(released).toMatchObject({
      state: "idle",
      runs: 1,
      failures: 1,
      boxSeconds: 2.5,
    });
  });

  it("matches lastUsedAt so the reaper never pauses a box used since it looked", async () => {
    await store.insert(record({ boxId: "b", lastUsedAt: at(1_000) }));
    expect(
      await store.transition(
        "b",
        { state: "idle", lastUsedAt: at() },
        {
          state: "pausing",
        },
      ),
    ).toBeNull();
    expect(
      await store.transition(
        "b",
        { state: "idle", lastUsedAt: at(1_000) },
        {
          state: "pausing",
        },
      ),
    ).toMatchObject({ state: "pausing" });
  });

  it("drains only the connection's other hashes and lists live boxes", async () => {
    await store.insert(
      record({ boxId: "old", key: "conn-a:hash-0", bundleHash: "hash-0" }),
    );
    await store.insert(record({ boxId: "new" }));
    await store.insert(
      record({
        boxId: "b-old",
        key: "conn-b:hash-0",
        connectionId: "conn-b",
        bundleHash: "hash-0",
      }),
    );
    await store.insert(
      record({ boxId: "dead", state: "killed", killedAt: at() }),
    );

    expect(await store.drainOtherHashes("conn-a", "hash-1")).toBe(1);
    expect((await store.get("old"))?.draining).toBe(true);
    expect((await store.get("b-old"))?.draining).toBe(false);
    expect((await store.listLive()).map(b => b.boxId).sort()).toEqual([
      "b-old",
      "new",
      "old",
    ]);
  });

  it("stores, touches and expires templates", async () => {
    await store.putTemplate({
      templateKey: "k",
      snapshotId: "snap",
      createdAt: at(),
      lastUsedAt: at(),
    });
    expect(await store.getTemplate("k")).toMatchObject({ snapshotId: "snap" });
    expect(await store.staleTemplates(at(1))).toHaveLength(1);
    await store.touchTemplate("k", at(10));
    expect(await store.staleTemplates(at(1))).toHaveLength(0);
    await store.deleteTemplate("k");
    expect(await store.getTemplate("k")).toBeNull();
  });
});
