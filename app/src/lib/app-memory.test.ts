import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_DUCKDB_GLOBAL_BUDGET,
  APP_DUCKDB_RELEASE_MESSAGE,
  APP_FRAME_MAX_BYTES,
  type AppFrameMemory,
  clearAppFrame,
  forgetAppFrame,
  framesToRelease,
  reportAppFrameMemory,
  resetAppFrameMemory,
  setAppFrameVisible,
} from "./app-memory";

const GiB = 1024 ** 3;
const frame = (bytes: number, shownAt: number, visible = false) =>
  ({ bytes, shownAt, visible }) satisfies AppFrameMemory;

describe("framesToRelease", () => {
  it("asks nobody while the frames fit", () => {
    const frames = new Map([
      ["a", frame(1 * GiB, 1)],
      ["b", frame(1 * GiB, 2, true)],
    ]);
    expect(framesToRelease(frames)).toEqual([]);
  });

  it("asks the least recently shown first, until the rest fit", () => {
    const frames = new Map([
      ["new", frame(1 * GiB, 30)],
      ["old", frame(1 * GiB, 10)],
      ["mid", frame(1 * GiB, 20)],
      ["front", frame(1 * GiB, 40, true)],
    ]);
    expect(framesToRelease(frames)).toEqual(["old", "mid"]);
  });

  it("never asks the frame on screen, even alone over budget", () => {
    const frames = new Map([["front", frame(3 * GiB, 1, true)]]);
    expect(framesToRelease(frames)).toEqual([]);
  });

  it("skips frames that hold nothing", () => {
    const frames = new Map([
      ["empty", frame(0, 1)],
      ["full", frame(1.5 * GiB, 2)],
      ["front", frame(1 * GiB, 3, true)],
    ]);
    expect(framesToRelease(frames)).toEqual(["full"]);
  });

  it("defaults to a 2 GiB budget", () => {
    expect(APP_DUCKDB_GLOBAL_BUDGET).toBe(2 * GiB);
  });
});

describe("the page's frames", () => {
  let now = 1000;
  beforeEach(() => {
    resetAppFrameMemory();
    vi.spyOn(Date, "now").mockImplementation(() => (now += 10));
  });
  afterEach(() => vi.restoreAllMocks());

  const win = () =>
    ({ postMessage: vi.fn() }) as unknown as Window & {
      postMessage: ReturnType<typeof vi.fn>;
    };

  it("opening app after app asks the oldest background frame to release", () => {
    const a = win();
    const b = win();
    const c = win();
    setAppFrameVisible("a", true);
    reportAppFrameMemory("a", a, "null", 1 * GiB);
    setAppFrameVisible("a", false);
    setAppFrameVisible("b", true);
    reportAppFrameMemory("b", b, "https://b.makoapps.dev", 0.8 * GiB);
    expect(a.postMessage).not.toHaveBeenCalled();
    setAppFrameVisible("b", false);
    setAppFrameVisible("c", true);
    reportAppFrameMemory("c", c, "null", 0.5 * GiB);
    // 2.3 GiB: a, shown longest ago, goes; b and c stay.
    expect(a.postMessage).toHaveBeenCalledWith(
      { type: APP_DUCKDB_RELEASE_MESSAGE },
      "*",
    );
    expect(b.postMessage).not.toHaveBeenCalled();
    expect(c.postMessage).not.toHaveBeenCalled();
    reportAppFrameMemory("a", a, "null", 0);

    // Reopening a bumps it: b is now the oldest.
    setAppFrameVisible("c", false);
    setAppFrameVisible("a", true);
    reportAppFrameMemory("a", a, "null", 1 * GiB);
    expect(b.postMessage).toHaveBeenCalledWith(
      { type: APP_DUCKDB_RELEASE_MESSAGE },
      "https://b.makoapps.dev",
    );
    expect(c.postMessage).not.toHaveBeenCalled();
  });

  it("a closed frame no longer counts", () => {
    const a = win();
    const b = win();
    reportAppFrameMemory("a", a, "null", 1.5 * GiB);
    forgetAppFrame("a");
    setAppFrameVisible("b", true);
    reportAppFrameMemory("b", b, "null", 1 * GiB);
    expect(a.postMessage).not.toHaveBeenCalled();
  });

  it("ignores a report that is not a byte count", () => {
    const a = win();
    reportAppFrameMemory("a", a, "null", Number.NaN);
    reportAppFrameMemory("a", a, "null", -1);
    reportAppFrameMemory("b", win(), "null", 2.5 * GiB);
    expect(a.postMessage).not.toHaveBeenCalled();
  });
});

describe("the frame lifecycle in the ledger", () => {
  const win = () => ({ postMessage: vi.fn() }) as unknown as Window;
  const asks = (w: Window) =>
    (w.postMessage as ReturnType<typeof vi.fn>).mock.calls.length;
  beforeEach(() => {
    vi.useFakeTimers();
    resetAppFrameMemory();
  });
  afterEach(() => {
    resetAppFrameMemory();
    vi.useRealTimers();
  });

  it("never asks the tab coming on screen when the old tab hides first", () => {
    const a = win();
    const b = win();
    setAppFrameVisible("a", true);
    reportAppFrameMemory("b", b, "null", 1 * GiB);
    vi.advanceTimersByTime(1);
    reportAppFrameMemory("a", a, "null", 1.5 * GiB);
    expect(asks(b)).toBe(1);
    (b.postMessage as ReturnType<typeof vi.fn>).mockClear();
    setAppFrameVisible("a", false);
    setAppFrameVisible("b", true);
    vi.advanceTimersByTime(1);
    expect(asks(b)).toBe(0);
    expect(asks(a)).toBe(1);
  });

  it("a replaced iframe leaves the count", () => {
    const victim = win();
    reportAppFrameMemory("replaced", win(), "null", 1.5 * GiB);
    clearAppFrame("replaced");
    setAppFrameVisible("front", true);
    reportAppFrameMemory("victim", victim, "null", 0.6 * GiB);
    reportAppFrameMemory("front", win(), "null", 0.6 * GiB);
    expect(asks(victim)).toBe(0);
  });

  it("asks again while the page is quiet, and stops when the total fits", () => {
    const a = win();
    setAppFrameVisible("front", true);
    vi.advanceTimersByTime(1);
    reportAppFrameMemory("a", a, "null", 1 * GiB);
    reportAppFrameMemory("front", win(), "null", 1.5 * GiB);
    expect(asks(a)).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(asks(a)).toBe(2);
    reportAppFrameMemory("a", a, "null", 0);
    vi.advanceTimersByTime(60_000);
    expect(asks(a)).toBe(2);
  });

  it("skips a frame that cannot release and asks the next one", () => {
    const kept = win();
    const next = win();
    setAppFrameVisible("kept", false);
    reportAppFrameMemory("kept", kept, "null", 1.4 * GiB, false);
    vi.advanceTimersByTime(5);
    setAppFrameVisible("next", false);
    reportAppFrameMemory("next", next, "null", 0.5 * GiB);
    vi.advanceTimersByTime(5);
    setAppFrameVisible("front", true);
    reportAppFrameMemory("front", win(), "null", 0.5 * GiB);
    expect(asks(kept)).toBe(0);
    expect(asks(next)).toBe(1);
  });

  it("clamps a report to what a WASM heap can address", () => {
    expect(APP_FRAME_MAX_BYTES).toBe(4 * GiB);
    const a = win();
    setAppFrameVisible("liar", true);
    reportAppFrameMemory("a", a, "null", 1 * GiB);
    reportAppFrameMemory("liar", win(), "null", 1e300);
    // The total stays finite, so the ledger still drains: a tells the truth.
    reportAppFrameMemory("a", a, "null", 0);
    vi.advanceTimersByTime(10_000);
    expect(asks(a)).toBe(1);
  });
});
