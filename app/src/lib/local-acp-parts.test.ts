import { describe, expect, it } from "vitest";
import {
  appendAssistantText,
  mapAcpToolStatus,
  resolveAcpToolName,
  resolveAcpToolTitle,
  upsertAcpToolPart,
} from "./local-acp-parts";

describe("local-acp-parts", () => {
  it("strips mcp__mako-workspace__ for manifest-friendly names", () => {
    expect(
      resolveAcpToolName({
        _meta: {
          claudeCode: { toolName: "mcp__mako-workspace__list_connections" },
        },
      }),
    ).toBe("list_connections");
    expect(
      resolveAcpToolName({
        name: "mcp__mako__sql_execute_query",
      }),
    ).toBe("sql_execute_query");
    expect(resolveAcpToolName({ name: "Bash" })).toBe("Bash");
  });

  it("drops raw MCP ids from tool titles so native labels/icons win", () => {
    expect(
      resolveAcpToolTitle(
        {
          title: "mcp__mako-workspace__app_edit_file",
          name: "mcp__mako-workspace__app_edit_file",
        },
        "app_edit_file",
      ),
    ).toBeUndefined();
    expect(
      resolveAcpToolTitle({ title: "Editing App.tsx" }, "app_edit_file"),
    ).toBe("Editing App.tsx");
  });

  it("maps ACP statuses to UIMessage tool states", () => {
    expect(mapAcpToolStatus("pending")).toBe("input-available");
    expect(mapAcpToolStatus("in_progress")).toBe("output-streaming");
    expect(mapAcpToolStatus("completed")).toBe("output-available");
    expect(mapAcpToolStatus("failed")).toBe("output-error");
  });

  it("upserts tool parts by toolCallId and preserves text", () => {
    let parts = appendAssistantText([], "Hello ");
    parts = upsertAcpToolPart(parts, {
      toolCallId: "t1",
      name: "mcp__mako-workspace__sql_execute_query",
      title: "Run SQL",
      status: "pending",
      rawInput: { query: "select 1" },
    });
    parts = appendAssistantText(parts, "world");
    parts = upsertAcpToolPart(parts, {
      toolCallId: "t1",
      status: "completed",
      rawOutput: { rows: [[1]] },
    });

    expect(parts[0]).toMatchObject({ type: "text", text: "Hello " });
    expect(parts[1]).toMatchObject({
      type: "dynamic-tool",
      toolCallId: "t1",
      toolName: "sql_execute_query",
      title: "Run SQL",
      state: "output-available",
      input: { query: "select 1" },
      output: { rows: [[1]] },
    });
    expect(parts[2]).toMatchObject({ type: "text", text: "world" });
  });

  it("does not keep mcp__* titles that would override native card labels", () => {
    const parts = upsertAcpToolPart([], {
      toolCallId: "t2",
      name: "mcp__mako-workspace__app_edit_file",
      title: "mcp__mako-workspace__app_edit_file",
      status: "in_progress",
      rawInput: { path: "src/App.tsx" },
    });
    expect(parts[0]).toMatchObject({
      type: "dynamic-tool",
      toolName: "app_edit_file",
      title: undefined,
    });
  });
});
