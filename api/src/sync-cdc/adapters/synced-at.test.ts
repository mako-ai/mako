import { describe, it, expect } from "vitest";
import { withSyncedAt } from "../normalization";

/**
 * `withSyncedAt` is the single source of truth every destination adapter uses
 * to stamp `_syncedAt` on materialized rows. The contract: `_syncedAt` reflects
 * the destination write time and is refreshed on every insert/update, so it
 * must always override whatever `_syncedAt` rode along in the source payload.
 */
describe("withSyncedAt", () => {
  it("stamps a fresh _syncedAt on the row", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const row = withSyncedAt({ id: "1", name: "ada" }, now);
    expect(row._syncedAt).toBe(now);
    expect(row.id).toBe("1");
    expect(row.name).toBe("ada");
  });

  it("overrides a stale _syncedAt carried in the source payload", () => {
    const stale = new Date("2020-01-01T00:00:00.000Z");
    const now = new Date("2026-06-30T11:00:00.000Z");
    const row = withSyncedAt(
      { id: "1", _syncedAt: stale, _mako_ingest_seq: 7 },
      now,
    );
    expect(row._syncedAt).toBe(now);
    expect(row._syncedAt).not.toBe(stale);
    // Other system/metadata columns are preserved untouched.
    expect(row._mako_ingest_seq).toBe(7);
  });

  it("does not mutate the input row", () => {
    const input = { id: "1", _syncedAt: new Date("2020-01-01T00:00:00.000Z") };
    const before = input._syncedAt;
    const out = withSyncedAt(input, new Date("2026-06-30T11:00:00.000Z"));
    expect(input._syncedAt).toBe(before);
    expect(out).not.toBe(input);
  });

  it("defaults to the current time when no timestamp is provided", () => {
    const t0 = Date.now();
    const row = withSyncedAt({ id: "1" });
    const t1 = Date.now();
    expect(row._syncedAt).toBeInstanceOf(Date);
    const stamped = row._syncedAt.getTime();
    expect(stamped).toBeGreaterThanOrEqual(t0);
    expect(stamped).toBeLessThanOrEqual(t1);
  });
});
