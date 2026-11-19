/**
 * A flow step refused by a box memory gate sleeps and runs again, under a new
 * step id, without using an Inngest retry. Free memory is then the cap on how
 * many steps run in one box at once (19 Nov 2026: a new resync cron overfilled
 * RealAdvisor's connector sync box).
 */
import { describe, expect, it, vi } from "vitest";
import { BoxLowMemoryError } from "../../../apps/sandbox/box-memory";
import {
  BOX_MEMORY_MAX_WAITS,
  BOX_MEMORY_WAIT_JITTER_MS,
  BOX_MEMORY_WAIT_MS,
  withBoxMemoryWaits,
} from "./box-memory-wait";

/** Inngest's step tools, run inline, recording every step id. */
function fakeStep() {
  const ids: string[] = [];
  const sleeps: Array<[string, number]> = [];
  const step = {
    run: vi.fn(async (id: string, fn: () => Promise<unknown>) => {
      ids.push(id);
      return fn();
    }),
    sleep: vi.fn(async (id: string, ms: number) => {
      sleeps.push([id, ms]);
    }),
  };
  return { step, ids, sleeps };
}

const lowMemory = () =>
  new BoxLowMemoryError("box has 83 MB of memory free", 83, 600);

describe("withBoxMemoryWaits", () => {
  it("runs a step that is not refused once, under its own id", async () => {
    const { step, ids, sleeps } = fakeStep();
    const out = await withBoxMemoryWaits(step, "sync-leads-chunk-3", () =>
      Promise.resolve({ rows: 10 }),
    );
    expect(out).toEqual({ result: { rows: 10 }, waits: 0 });
    expect(ids).toEqual(["sync-leads-chunk-3"]);
    expect(sleeps).toEqual([]);
  });

  it("sleeps 60 to 90 s after a refusal and runs again under a new id", async () => {
    const { step, ids, sleeps } = fakeStep();
    const fn = vi
      .fn<() => Promise<{ rows: number }>>()
      .mockRejectedValueOnce(lowMemory())
      .mockRejectedValueOnce(lowMemory())
      .mockResolvedValueOnce({ rows: 7 });
    const onWait = vi.fn();
    const out = await withBoxMemoryWaits(step, "sync-leads-chunk-3", fn, {
      onWait,
      random: () => 0.5,
    });
    expect(out).toEqual({ result: { rows: 7 }, waits: 2 });
    expect(ids).toEqual([
      "sync-leads-chunk-3",
      "sync-leads-chunk-3-after-memory-wait-1",
      "sync-leads-chunk-3-after-memory-wait-2",
    ]);
    const ms = BOX_MEMORY_WAIT_MS + BOX_MEMORY_WAIT_JITTER_MS / 2;
    expect(sleeps).toEqual([
      ["sync-leads-chunk-3-memory-wait-1", ms],
      ["sync-leads-chunk-3-memory-wait-2", ms],
    ]);
    expect(onWait).toHaveBeenCalledTimes(2);
    expect(onWait).toHaveBeenLastCalledWith(2, {
      message: "box has 83 MB of memory free",
      availableMb: 83,
      retryInMs: ms,
    });
  });

  it("throws any other error at once", async () => {
    const { step, sleeps } = fakeStep();
    await expect(
      withBoxMemoryWaits(step, "s", () => Promise.reject(new Error("401"))),
    ).rejects.toThrow("401");
    expect(sleeps).toEqual([]);
  });

  it("throws the refusal after the last wait (20 by default)", async () => {
    const { step, ids, sleeps } = fakeStep();
    await expect(
      withBoxMemoryWaits(step, "s", () => Promise.reject(lowMemory())),
    ).rejects.toBeInstanceOf(BoxLowMemoryError);
    expect(BOX_MEMORY_MAX_WAITS).toBe(20);
    expect(sleeps).toHaveLength(20);
    expect(ids).toHaveLength(21);
  });
});
