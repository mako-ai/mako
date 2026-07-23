import { describe, expect, it } from "vitest";
import {
  appendAssistantText,
  mapAcpToolStatus,
  resolveAcpToolName,
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
});
