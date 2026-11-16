/**
 * The drain's guards, against mocked box operations: nothing is killed
 * unless the key is the recorded old key and no Mako box started after the
 * swap. Aura's boxes (no makoAppsSessionKey) are never candidates.
 */
import { describe, expect, it, vi } from "vitest";
import {
  drainOldBoxes,
  foreignOriginSessionKeys,
  sha256Hex,
  type DrainBox,
} from "./box-drain";
import { parseDrainArgs } from "../scripts/e2b-drain-old-boxes";

const OLD_KEY = "old-key-for-tests";
const SWAP = new Date("2026-11-16T15:00:00Z");

const mako = (id: string, startedAt: string): DrainBox => ({
  sandboxId: id,
  state: "paused",
  startedAt: new Date(startedAt),
  sessionKey: `ws:${id}`,
});

function ops(boxes: DrainBox[]) {
  return {
    listBoxes: vi.fn(async () => boxes),
    kill: vi.fn(async () => undefined),
  };
}

const opts = (over: Partial<Parameters<typeof drainOldBoxes>[1]> = {}) => ({
  apiKey: OLD_KEY,
  expectKeySha256: sha256Hex(OLD_KEY),
  swapTime: SWAP,
  apply: true,
  ...over,
});

describe("drainOldBoxes", () => {
  it("kills only Mako boxes, and only with the old key", async () => {
    const o = ops([
      mako("a", "2026-11-10T00:00:00Z"),
      mako("b", "2026-11-16T14:00:00Z"),
      {
        sandboxId: "aura",
        state: "running",
        startedAt: new Date("2026-11-20T00:00:00Z"),
      },
    ]);
    const report = await drainOldBoxes(o, opts());
    expect(report.aborted).toBeUndefined();
    expect(report.killed).toEqual(["a", "b"]);
    expect(o.kill).toHaveBeenCalledTimes(2);
  });

  it("aborts on a key that is not the recorded old key", async () => {
    const o = ops([mako("a", "2026-11-10T00:00:00Z")]);
    const report = await drainOldBoxes(o, opts({ apiKey: "new-project-key" }));
    expect(report.aborted).toMatch(/does not match/);
    expect(o.listBoxes).not.toHaveBeenCalled();
    expect(o.kill).not.toHaveBeenCalled();
  });

  it("aborts when a Mako box started after the swap", async () => {
    const o = ops([
      mako("a", "2026-11-10T00:00:00Z"),
      mako("late", "2026-11-16T15:30:00Z"),
    ]);
    const report = await drainOldBoxes(o, opts());
    expect(report.aborted).toMatch(/1 Mako box/);
    expect(report.startedAfterSwap).toEqual(["late"]);
    expect(o.kill).not.toHaveBeenCalled();
  });

  it("dry run kills nothing and reports the gate count", async () => {
    const o = ops([mako("a", "2026-11-10T00:00:00Z")]);
    const report = await drainOldBoxes(o, opts({ apply: false }));
    expect(report).toMatchObject({ candidates: 1, startedAfterSwap: [] });
    expect(o.kill).not.toHaveBeenCalled();
  });

  it("refuses a malformed hash or swap time", async () => {
    const o = ops([]);
    expect(
      (await drainOldBoxes(o, opts({ expectKeySha256: "abc" }))).aborted,
    ).toMatch(/sha256/);
    expect(
      (await drainOldBoxes(o, opts({ swapTime: new Date("nope") }))).aborted,
    ).toMatch(/swap time/);
  });

  it("ignores sessions the pre-save dry run classed foreign-origin", async () => {
    const o = ops([
      mako("a", "2026-11-10T00:00:00Z"),
      mako("laptop", "2026-11-16T16:00:00Z"),
    ]);
    const ignore = foreignOriginSessionKeys(
      [
        '{"mode":"dry-run"}',
        '{"sessionKey":"ws:laptop","action":"foreign-origin"}',
        '{"sessionKey":"ws:a","action":"would-save"}',
        "not json",
      ].join("\n"),
    );
    expect([...ignore]).toEqual(["ws:laptop"]);
    const report = await drainOldBoxes(o, opts({ ignoreSessionKeys: ignore }));
    expect(report.aborted).toBeUndefined();
    expect(report.ignored).toBe(1);
    expect(report.killed).toEqual(["a"]);
  });

  it("a failed kill is reported and the rest continue", async () => {
    const o = ops([
      mako("a", "2026-11-10T00:00:00Z"),
      mako("b", "2026-11-11T00:00:00Z"),
    ]);
    o.kill.mockRejectedValueOnce(new Error("gone"));
    const report = await drainOldBoxes(o, opts());
    expect(report.failed).toEqual([{ sandboxId: "a", error: "gone" }]);
    expect(report.killed).toEqual(["b"]);
  });
});

describe("e2b-drain-old-boxes arguments", () => {
  it("requires the hash and the swap time; dry run by default", () => {
    expect(() => parseDrainArgs([])).toThrow(/expect-key-sha256/);
    expect(() => parseDrainArgs(["--expect-key-sha256", "x"])).toThrow(
      /swap-time/,
    );
    expect(
      parseDrainArgs(["--expect-key-sha256", "x", "--swap-time", "t"]),
    ).toEqual({ apply: false, expectKeySha256: "x", swapTime: "t" });
  });
});
