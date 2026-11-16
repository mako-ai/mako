import { describe, expect, it } from "vitest";
import { createKeyedSingleFlight } from "./single-flight";

describe("createKeyedSingleFlight", () => {
  it("skips a tick while the same key's run is in flight, then runs again", async () => {
    const once = createKeyedSingleFlight();
    let finish!: () => void;
    let runs = 0;
    const run = () => {
      runs++;
      return new Promise<void>(r => (finish = r));
    };
    expect(once("ws1", run)).toBe(true);
    await Promise.resolve();
    expect(once("ws1", run)).toBe(false);
    expect(runs).toBe(1);
    finish();
    await new Promise(r => setTimeout(r, 0));
    expect(once("ws1", run)).toBe(true);
    await Promise.resolve();
    expect(runs).toBe(2);
  });

  it("runs another key at once, and a failed run frees its key", async () => {
    const once = createKeyedSingleFlight();
    expect(once("ws1", () => new Promise(() => {}))).toBe(true);
    expect(once("ws2", () => Promise.reject(new Error("503")))).toBe(true);
    await new Promise(r => setTimeout(r, 0));
    expect(once("ws2", async () => undefined)).toBe(true);
  });
});
