/**
 * A flow step refused by a box memory gate sleeps and runs again, under a new
 * step id, without using an Inngest retry. Free memory is then the cap on how
 * many steps run in one box at once (19 Nov 2026: a new resync cron overfilled
 * RealAdvisor's connector sync box).
 */
import { describe, expect, it, vi } from "vitest";
import {
  BoxLowMemoryError,
  boxLowMemoryRefusal,
} from "../../../apps/sandbox/box-memory";
import { ConnectorBoxLowMemoryError } from "../../../connectors/workspace/sync-box";
import { isTransientIndexFailure } from "../../../connectors/workspace/transient-failure";
import {
  SchemaResolutionError,
  resolveEntitySchema,
} from "../../../sync/sync-orchestrator";
import { backfillFailureUpdate } from "./failure";
import { isInfrastructureFailure } from "./infra-failure";
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

/**
 * 19 Nov 2026, 05:56 UTC: the memory gate refused schema resolution in a
 * chunk step. SchemaResolutionError wrapped the refusal, `instanceof` missed
 * it, and the run failed a 16-hour CDC backfill. A refusal must wait however
 * it is wrapped, and must never count as the connector's failure.
 */
describe("a wrapped refusal", () => {
  const refusal = () =>
    new ConnectorBoxLowMemoryError("connector-sync:v2:ws1", 573);

  it("schema resolution refused once waits, then resolves on the next attempt", async () => {
    const { step, ids, sleeps } = fakeStep();
    const schema = { entity: "activities:Meeting", fields: {} };
    const resolveSchema = vi
      .fn<(entity: string) => Promise<unknown>>()
      .mockRejectedValueOnce(refusal())
      .mockResolvedValueOnce(schema);
    const out = await withBoxMemoryWaits(
      step,
      "sync-activities-chunk-0",
      () =>
        resolveEntitySchema({
          entity: "activities:Meeting",
          workspaceId: "ws1",
          connector: { resolveSchema },
          context: "syncChunk",
        }),
      { random: () => 0 },
    );
    expect(out).toEqual({ result: schema, waits: 1 });
    expect(resolveSchema).toHaveBeenCalledTimes(2);
    expect(ids).toEqual([
      "sync-activities-chunk-0",
      "sync-activities-chunk-0-after-memory-wait-1",
    ]);
    expect(sleeps).toEqual([
      ["sync-activities-chunk-0-memory-wait-1", BOX_MEMORY_WAIT_MS],
    ]);
  });

  it("finds the refusal under any cause chain, or by its words alone", () => {
    const schemaError = new SchemaResolutionError(
      "activities:Meeting",
      "syncChunk",
      refusal(),
    );
    const chunkError = new Error(`Sync chunk failed: ${schemaError.message}`, {
      cause: schemaError,
    });
    expect(boxLowMemoryRefusal(chunkError)?.availableMb).toBe(573);
    // An Inngest replay, or a wrapper that keeps only the message.
    const textOnly = boxLowMemoryRefusal(new Error(chunkError.message));
    expect(textOnly).toBeInstanceOf(BoxLowMemoryError);
    expect(textOnly?.availableMb).toBe(573);
    expect(textOnly?.requiredMb).toBe(600);
    expect(boxLowMemoryRefusal(new Error("401: key revoked"))).toBeNull();
  });

  it("a step that must not throw returns its giveUp value after the last wait", async () => {
    const { step, sleeps } = fakeStep();
    const out = await withBoxMemoryWaits(
      step,
      "batch-0",
      (): Promise<{ next: string; reason?: string }> =>
        Promise.reject(refusal()),
      {
        maxWaits: 2,
        giveUp: r => ({ next: "stop", reason: r.message }),
      },
    );
    expect(sleeps).toHaveLength(2);
    expect(out.waits).toBe(2);
    expect(out.result.next).toBe("stop");
    expect(out.result.reason).toContain("573 MB of memory free");
  });

  it("the prod failure is the platform's: it never counts toward the 10 resume attempts", () => {
    const schemaError = new SchemaResolutionError(
      "activities:Meeting",
      "syncChunk",
      refusal(),
    );
    const message = `Flow failed: ${schemaError.message}`;
    expect(isInfrastructureFailure(message)).toBe(true);
    expect(isTransientIndexFailure(message)).toBe(true);
    const update = backfillFailureUpdate(message);
    expect(update.$inc).toEqual({ "backfillState.infraFailures": 1 });
    expect(update.$inc).not.toHaveProperty("backfillState.consecutiveFailures");
  });
});
