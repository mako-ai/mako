/**
 * Second review of PR #1190: the per-process inline build cap.
 */
import { describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({
  running: 0,
  peak: 0,
  mode: "ok" as "ok" | "throw-first" | "hang-first-two",
  calls: 0,
  count: 20,
}));

vi.mock("../services/artifact-store.service", () => ({
  getArtifactStore: () => ({
    type: "gcs",
    exists: vi.fn(async () => false),
    putBuffer: vi.fn(async () => undefined),
  }),
  getArtifactSourceStore: () => null,
}));
vi.mock("../inngest/functions/apps-binding-refresh", () => ({
  requestBindingRefreshes: vi.fn(async () => undefined),
}));
vi.mock("./bindings.service", () => ({
  bindingArtifactKey: vi.fn((b: { name: string }) => b.name),
  bindingArtifactKeyByName: vi.fn(),
  materializeAppBinding: vi.fn(async () => {
    const call = seen.calls++;
    seen.running += 1;
    seen.peak = Math.max(seen.peak, seen.running);
    try {
      if (seen.mode === "hang-first-two" && call < 2) {
        await new Promise(() => undefined); // a socket that never answers
      }
      await new Promise(resolve => setTimeout(resolve, 2));
      if (seen.mode === "throw-first" && call === 0) throw new Error("boom");
      return { rowCount: 1 };
    } finally {
      seen.running -= 1;
    }
  }),
  readBindingsTolerant: vi.fn(async () => ({
    bindings: Array.from({ length: seen.count }, (_, i) => ({
      name: `b${i}`,
      connectionId: "c",
      materialization: "parquet",
    })),
    skipped: [],
  })),
}));
vi.mock("../database/workspace-schema", () => ({
  AppProject: { updateOne: vi.fn(async () => ({ matchedCount: 1 })) },
}));

import { ensureDeploymentBindings } from "./deployment.service";
import type { IAppProject } from "../database/workspace-schema";

const project = (n: number) =>
  ({
    _id: { toString: () => `6a9411eb4c8b33609a65e66${n}` },
    workspaceId: { toString: () => "ws" },
  }) as unknown as IAppProject;
const walk = (n: number) =>
  ensureDeploymentBindings(project(n), `${n}`.repeat(40));

const reset = (mode: typeof seen.mode, count = 20) => {
  seen.mode = mode;
  seen.calls = 0;
  seen.running = 0;
  seen.peak = 0;
  seen.count = count;
};

describe("inline build slots (order matters: the last test leaks slots)", () => {
  it("HELD: 5 concurrent walks all finish, peak 2, no deadlock", async () => {
    reset("ok");
    const done = await Promise.all([
      walk(1),
      walk(2),
      walk(3),
      walk(4),
      walk(5),
    ]);
    expect(done.every(d => d.materialized.length === 20)).toBe(true);
    expect(seen.peak).toBe(2);
    expect(seen.calls).toBe(100);
  }, 30_000);

  it("HELD: a thrown build releases its slot, and other walks finish", async () => {
    reset("throw-first");
    const results = await Promise.allSettled([walk(1), walk(2), walk(3)]);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    reset("ok", 4);
    await walk(4);
    expect(seen.peak).toBe(2); // the count came back to 0, not stuck at 1 or 2
  }, 30_000);

  it("DEFECT: two builds that hang must not stop every other app's publish in this process", async () => {
    reset("hang-first-two", 1);
    // The real limit is 30 minutes; the behaviour is the same at 100 ms.
    process.env.APPS_DEPLOY_INLINE_BUILD_TIMEOUT_MS = "100";
    const first = walk(1);
    const second = walk(2);
    await expect(first).rejects.toThrow("timed out");
    await expect(second).rejects.toThrow("timed out");
    delete process.env.APPS_DEPLOY_INLINE_BUILD_TIMEOUT_MS;
    const third = await Promise.race([
      walk(3).then(() => "finished"),
      new Promise(resolve => setTimeout(() => resolve("blocked"), 2_000)),
    ]);
    expect(third).toBe("finished");
  }, 30_000);
});
