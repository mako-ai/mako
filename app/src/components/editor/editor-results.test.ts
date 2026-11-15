import { describe, expect, it } from "vitest";
import {
  buildResultsContext,
  nextPageOptions,
  omitKey,
  paginationFromPage,
  previousPageOptions,
  resultFromLastRun,
  saveDialogDefaultName,
} from "./editor-results";
import type { QueryResult, TabPaginationState } from "./types";

const result = (over: Partial<QueryResult> = {}): QueryResult => ({
  results: [
    { a: 1, b: 2 },
    { a: 3, b: 4 },
  ],
  executedAt: "2026-01-01T00:00:00.000Z",
  resultCount: 2,
  ...over,
});

describe("buildResultsContext", () => {
  it("reports no results for a missing result", () => {
    expect(buildResultsContext(null, "table", null)).toEqual({
      viewMode: "table",
      chartSpec: null,
      hasResults: false,
      rowCount: 0,
      columns: [],
      sampleRows: [],
    });
  });

  it("prefers declared fields over row keys", () => {
    const ctx = buildResultsContext(
      result({ fields: ["x", { name: "y" }, { originalName: "z" }] }),
      "chart",
      null,
    );
    expect(ctx.columns).toEqual(["x", "y"]);
    expect(ctx.rowCount).toBe(2);
    expect(ctx.viewMode).toBe("chart");
  });

  it("falls back to the first row's keys and caps sample rows at 5", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: i }));
    const ctx = buildResultsContext(result({ results: rows }), "table", null);
    expect(ctx.columns).toEqual(["id"]);
    expect(ctx.sampleRows).toHaveLength(5);
    expect(ctx.rowCount).toBe(8);
  });

  it("wraps a non-array result as one row", () => {
    const ctx = buildResultsContext(
      result({ results: { k: 1 } as unknown as QueryResult["results"] }),
      "json",
      null,
    );
    expect(ctx.rowCount).toBe(1);
    expect(ctx.columns).toEqual(["k"]);
  });
});

describe("resultFromLastRun", () => {
  const lastRun = {
    at: "2026-01-02T00:00:00.000Z",
    status: "success" as const,
    durationMs: 12,
    rowCount: 40,
    sampleRows: [{ a: 1 }],
    source: "agent",
  };

  it("ignores missing, failed, or row-less runs", () => {
    expect(resultFromLastRun(null, undefined)).toBeNull();
    expect(
      resultFromLastRun({ ...lastRun, status: "error" }, undefined),
    ).toBeNull();
    expect(
      resultFromLastRun({ ...lastRun, sampleRows: undefined }, undefined),
    ).toBeNull();
  });

  it("renders the artifact when nothing is shown yet", () => {
    const r = resultFromLastRun({ ...lastRun, source: "user" }, undefined);
    expect(r).toMatchObject({
      results: [{ a: 1 }],
      executedAt: lastRun.at,
      resultCount: 40,
      executionTime: 12,
      pageInfo: null,
    });
  });

  it("only replaces shown results with a strictly newer agent run", () => {
    const older = result({ executedAt: "2026-01-01T00:00:00.000Z" });
    const same = result({ executedAt: lastRun.at });
    expect(resultFromLastRun(lastRun, older)).not.toBeNull();
    expect(resultFromLastRun(lastRun, same)).toBeNull();
    expect(resultFromLastRun({ ...lastRun, source: "user" }, older)).toBeNull();
    // An explicitly cleared (null) result is still "shown": only agent wins.
    expect(resultFromLastRun(lastRun, null)).toBeNull();
  });
});

describe("pagination", () => {
  const tab = { databaseId: "db", databaseName: "name" };
  const page2: TabPaginationState = {
    currentPage: 2,
    cursorHistory: [null, "c1"],
    nextCursor: "c2",
    hasMore: true,
    pageSize: 100,
    capApplied: false,
  };

  it("derives the state of a fetched page", () => {
    expect(paginationFromPage(null, undefined)).toEqual({
      currentPage: 1,
      cursorHistory: [null],
      nextCursor: null,
      hasMore: false,
      pageSize: 500,
      capApplied: false,
    });
    expect(
      paginationFromPage(
        {
          pageSize: 50,
          hasMore: true,
          nextCursor: "n",
          returnedRows: 50,
          capApplied: true,
        },
        { currentPage: 3, cursorHistory: [null, "a", "b"] },
      ),
    ).toEqual({
      currentPage: 3,
      cursorHistory: [null, "a", "b"],
      nextCursor: "n",
      hasMore: true,
      pageSize: 50,
      capApplied: true,
    });
  });

  it("moves forward with the next cursor", () => {
    expect(nextPageOptions(tab, page2)).toEqual({
      databaseId: "db",
      databaseName: "name",
      cursor: "c2",
      currentPage: 3,
      cursorHistory: [null, "c1", "c2"],
      pageSize: 100,
    });
    expect(nextPageOptions(tab, { ...page2, nextCursor: null })).toBeNull();
    expect(nextPageOptions(tab, null)).toBeNull();
  });

  it("moves back to the previous cursor", () => {
    expect(previousPageOptions(tab, page2)).toEqual({
      databaseId: "db",
      databaseName: "name",
      cursor: null,
      currentPage: 1,
      cursorHistory: [null],
      pageSize: 100,
    });
    expect(previousPageOptions(tab, { ...page2, currentPage: 1 })).toBeNull();
    // Never leaves the history empty.
    expect(
      previousPageOptions(tab, { ...page2, cursorHistory: ["x"] })
        ?.cursorHistory,
    ).toEqual([null]);
  });
});

describe("saveDialogDefaultName", () => {
  const tab = { filePath: "dir/q", title: "q" };
  it("names each save flow", () => {
    expect(saveDialogDefaultName(undefined, "new")).toBe("");
    expect(saveDialogDefaultName(tab, "new")).toBe("q");
    expect(saveDialogDefaultName(tab, "rename-move")).toBe("dir/q");
    expect(saveDialogDefaultName(tab, "save-as-copy")).toBe("dir/q (copy)");
    expect(
      saveDialogDefaultName({ filePath: undefined, title: "" }, "save-as-copy"),
    ).toBe("");
  });
});

describe("omitKey", () => {
  it("copies without the key", () => {
    const src = { a: 1, b: 2 };
    expect(omitKey(src, "a")).toEqual({ b: 2 });
    expect(src).toEqual({ a: 1, b: 2 });
  });
});
