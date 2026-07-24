import { describe, expect, it } from "vitest";
import {
  appendAssistantReasoning,
  appendAssistantText,
  coerceAcpToolPayload,
  isAcpCodexCommentaryPhase,
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

  it("normalizes Codex Mcp.Server.Tool Title forms to snake_case ids", () => {
    expect(
      resolveAcpToolName({
        title: "Mcp.Mako-Workspace.Sql Execute Query",
      }),
    ).toBe("sql_execute_query");
    expect(
      resolveAcpToolName({
        name: "Mcp.Mako-Desktop.List Open Consoles",
      }),
    ).toBe("list_open_consoles");
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
      resolveAcpToolTitle(
        { title: "Mcp.Mako-Workspace.Sql Execute Query" },
        "sql_execute_query",
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

  it("unwraps MCP CallToolResult envelopes so SQL row counts are visible", () => {
    const payload = {
      success: true,
      rowCount: 42,
      data: [{ id: 1 }, { id: 2 }],
    };
    expect(
      coerceAcpToolPayload({
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }),
    ).toEqual(payload);
    expect(
      coerceAcpToolPayload([{ type: "text", text: JSON.stringify(payload) }]),
    ).toEqual(payload);
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

  it("maps agent_thought_chunk text onto reasoning parts", () => {
    let parts = appendAssistantReasoning(
      [{ type: "text", text: "" }],
      "Considering the schema…",
    );
    expect(parts).toEqual([
      {
        type: "reasoning",
        text: "Considering the schema…",
        state: "streaming",
      },
    ]);
    parts = appendAssistantReasoning(parts, " then joins.");
    expect(parts).toEqual([
      {
        type: "reasoning",
        text: "Considering the schema… then joins.",
        state: "streaming",
      },
    ]);
    parts = upsertAcpToolPart(parts, {
      toolCallId: "t3",
      name: "sql_execute_query",
      status: "completed",
      rawOutput: { ok: true },
    });
    expect(parts[0]).toMatchObject({
      type: "reasoning",
      state: "done",
    });
    parts = appendAssistantReasoning(parts, "Next step.");
    expect(parts[2]).toMatchObject({
      type: "reasoning",
      text: "Next step.",
      state: "streaming",
    });
  });

  it("ignores whitespace-only thought chunks before real text", () => {
    const parts = appendAssistantReasoning(
      [{ type: "text", text: "" }],
      "\n\n",
    );
    expect(parts).toEqual([{ type: "text", text: "" }]);
  });

  it("keeps an empty streaming Thinking placeholder open on whitespace", () => {
    const seeded = [
      { type: "reasoning" as const, text: "", state: "streaming" as const },
    ];
    expect(appendAssistantReasoning(seeded, "\n\n")).toEqual(seeded);
    expect(appendAssistantReasoning(seeded, "Hello")).toEqual([
      { type: "reasoning", text: "Hello", state: "streaming" },
    ]);
  });

  it("detects Codex commentary-phase message chunks", () => {
    expect(
      isAcpCodexCommentaryPhase({
        _meta: { codex: { phase: "commentary" } },
      }),
    ).toBe(true);
    expect(
      isAcpCodexCommentaryPhase({
        _meta: { codex: { phase: "final_answer" } },
      }),
    ).toBe(false);
    expect(isAcpCodexCommentaryPhase({})).toBe(false);
  });
});
