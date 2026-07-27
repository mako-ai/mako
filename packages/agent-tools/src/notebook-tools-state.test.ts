import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NOTEBOOK_SOURCE_PREVIEW_CHARS,
  editNotebookCellSchema,
  notebookCellResourceVersion,
  readNotebookCellRange,
  searchNotebookCells,
  summarizeNotebookCell,
} from "./notebook-tools";

describe("notebook cell manifest", () => {
  it("returns metadata and a bounded preview instead of full source", () => {
    const source = "x".repeat(NOTEBOOK_SOURCE_PREVIEW_CHARS + 5_000);
    const summary = summarizeNotebookCell({
      id: "cell-1",
      type: "sql",
      connectionId: "connection-1",
      source,
      outputs: [{ type: "sql" }],
      executionCount: 3,
    });

    assert.equal(summary.cellId, "cell-1");
    assert.equal(summary.sourceLength, source.length);
    assert.equal(
      summary.sourcePreview.length,
      NOTEBOOK_SOURCE_PREVIEW_CHARS + 1,
    );
    assert.equal(summary.sourcePreview.includes(source), false);
    assert.equal(summary.outputCount, 1);
    assert.equal(summary.executionCount, 3);
  });

  it("changes the resource version when source or cell metadata changes", () => {
    assert.notEqual(
      notebookCellResourceVersion({ source: "select 1", type: "sql" }),
      notebookCellResourceVersion({ source: "select 2", type: "sql" }),
    );
    assert.notEqual(
      notebookCellResourceVersion({
        source: "select 1",
        type: "sql",
        connectionId: "a",
      }),
      notebookCellResourceVersion({
        source: "select 1",
        type: "sql",
        connectionId: "b",
      }),
    );
    assert.notEqual(
      notebookCellResourceVersion({ source: "same" }, 1),
      notebookCellResourceVersion({ source: "same" }, 2),
    );
  });
});

describe("notebook resource protocol", () => {
  it("searches selected cell types and returns bounded snippets", () => {
    const result = searchNotebookCells(
      [
        { id: "markdown", type: "markdown", source: "needle in prose" },
        { id: "sql", type: "sql", source: "select *\nfrom needle_table" },
      ],
      "needle",
      { cellTypes: ["sql"], contextLines: 1 },
    );

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.cellId, "sql");
    assert.equal(result.matches[0]?.line, 2);
    assert.match(result.matches[0]?.snippet ?? "", /select \*/);
  });

  it("paginates search matches deterministically", () => {
    const cells = [{ id: "cell", type: "code", source: "hit\nhit\nhit" }];
    const first = searchNotebookCells(cells, "hit", { maxResults: 1 });
    assert.equal(first.matches[0]?.line, 1);
    assert.equal(first.nextOffset, 1);

    const second = searchNotebookCells(cells, "hit", {
      maxResults: 1,
      offset: first.nextOffset,
    });
    assert.equal(second.matches[0]?.line, 2);
  });

  it("reads cell source with line and character continuation", () => {
    const lines = Array.from(
      { length: 500 },
      (_, index) => `line ${index + 1}`,
    );
    const range = readNotebookCellRange(lines.join("\n"), 10, 500);
    assert.equal(range.startLine, 10);
    assert.equal(range.endLine, 409);
    assert.equal(range.nextStartLine, 410);
    assert.equal(range.hasMore, true);
  });
});

describe("editNotebookCellSchema", () => {
  it("requires a complete targeted replacement pair", () => {
    const parsed = editNotebookCellSchema.safeParse({
      cellId: "cell",
      oldString: "before",
    });
    assert.equal(parsed.success, false);
  });

  it("rejects full and targeted replacement in one call", () => {
    const parsed = editNotebookCellSchema.safeParse({
      cellId: "cell",
      source: "full",
      oldString: "before",
      newString: "after",
    });
    assert.equal(parsed.success, false);
  });
});
