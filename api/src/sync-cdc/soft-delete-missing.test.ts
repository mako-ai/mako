import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SOFT_DELETE_MISSING_MAX_IDS,
  softDeleteMissingRows,
} from "./soft-delete-missing";
import { buildCdcEntityLayout } from "./adapters/registry";

/**
 * A complete full read of a small entity soft-deletes the live rows it no
 * longer lists (sync-cdc/soft-delete-missing.ts). Each guard has a test that
 * proves the destination is never asked to write.
 */

const layout = buildCdcEntityLayout({
  entity: "users",
  tableName: "users",
  deleteMode: "soft",
  writeMode: "append_dedup",
});

const countLiveRows = vi.fn();
const softDeleteRowsNotIn = vi.fn();
const adapter = {
  destinationType: "bigquery",
  countLiveRows,
  softDeleteRowsNotIn,
};

const run = (over: Partial<Parameters<typeof softDeleteMissingRows>[0]> = {}) =>
  softDeleteMissingRows({
    adapter,
    layout,
    ids: ["a", "b", "c"],
    overflowed: false,
    deleteMode: "soft",
    ...over,
  });

describe("soft-delete rows missing from a full read", () => {
  beforeEach(() => {
    countLiveRows.mockReset();
    softDeleteRowsNotIn.mockReset();
    softDeleteRowsNotIn.mockResolvedValue({ marked: 1 });
  });

  it("happy path: a removed id is soft-deleted", async () => {
    countLiveRows.mockResolvedValue({ live: 4, missing: 1 });
    const out = await run();
    expect(out).toEqual({ status: "deleted", marked: 1 });
    expect(countLiveRows).toHaveBeenCalledWith(layout, "id", ["a", "b", "c"]);
    expect(softDeleteRowsNotIn).toHaveBeenCalledWith(layout, "id", [
      "a",
      "b",
      "c",
    ]);
  });

  it("no change: 0 missing means no UPDATE", async () => {
    countLiveRows.mockResolvedValue({ live: 3, missing: 0 });
    expect(await run()).toEqual({ status: "unchanged" });
    expect(softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("guard 1: an empty listing never deletes", async () => {
    const out = await run({ ids: [] });
    expect(out.status).toBe("skipped");
    expect(countLiveRows).not.toHaveBeenCalled();
    expect(softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("guard 2: under 50% of the live rows never deletes, and warns", async () => {
    countLiveRows.mockResolvedValue({ live: 10, missing: 7 });
    const warn = vi.fn();
    const out = await run({ logger: { log: warn } });
    expect(out.status).toBe("skipped");
    expect(softDeleteRowsNotIn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("3 ids against 10 live rows"),
      expect.anything(),
    );
  });

  it("guard 2: exactly 50% still deletes", async () => {
    countLiveRows.mockResolvedValue({ live: 6, missing: 3 });
    expect((await run()).status).toBe("deleted");
  });

  it("guard 3: a hard-delete flow never deletes", async () => {
    expect((await run({ deleteMode: "hard" })).status).toBe("skipped");
    expect((await run({ deleteMode: undefined })).status).toBe("skipped");
    expect(countLiveRows).not.toHaveBeenCalled();
    expect(softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("append and overwrite flows never delete", async () => {
    for (const writeMode of ["append", "overwrite"] as const) {
      const out = await run({ layout: { ...layout, writeMode } });
      expect(out.status).toBe("skipped");
    }
    expect(softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("guard 5: more than the id cap never deletes", async () => {
    const out = await run({ overflowed: true });
    expect(out.status).toBe("skipped");
    expect(SOFT_DELETE_MISSING_MAX_IDS).toBe(10_000);
    expect(countLiveRows).not.toHaveBeenCalled();
    expect(softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("an empty destination table never deletes", async () => {
    countLiveRows.mockResolvedValue({ live: 0, missing: 0 });
    expect((await run()).status).toBe("skipped");
    expect(softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("a failed count never deletes", async () => {
    countLiveRows.mockResolvedValue(undefined);
    expect((await run()).status).toBe("skipped");
    expect(softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("a composite key never deletes", async () => {
    const out = await run({ layout: { ...layout, keyColumns: ["a", "b"] } });
    expect(out.status).toBe("skipped");
    expect(softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("a destination without the methods is unsupported, and a no-op", async () => {
    const out = await run({ adapter: { destinationType: "clickhouse" } });
    expect(out).toEqual({ status: "unsupported" });
    expect(softDeleteRowsNotIn).not.toHaveBeenCalled();
  });

  it("duplicate listed ids count once", async () => {
    countLiveRows.mockResolvedValue({ live: 4, missing: 1 });
    await run({ ids: ["a", "a", "b", "c", "c"] });
    expect(countLiveRows).toHaveBeenCalledWith(layout, "id", ["a", "b", "c"]);
  });
});
