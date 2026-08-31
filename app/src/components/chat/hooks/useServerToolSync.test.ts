// @vitest-environment jsdom
/**
 * useServerToolSync — dbt file-mutation chat-stream backstop.
 *
 * Server-side dbt file tools only reach open tabs via the workspace SSE poke
 * (dbt.file.updated); a dead/dropped stream would leave the tab rendering
 * stale content until a manual reload. The hook also reconciles off the
 * resumable chat stream when file tool results arrive.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { UIMessage } from "ai";

const stores = vi.hoisted(() => {
  const dbtState = {
    projects: [] as Array<{ _id: string }>,
    filePathsByProject: {} as Record<string, string[]>,
    applyRemoteFileUpdate: vi.fn(),
  };
  return {
    dbtState,
    consoleState: { tabs: {}, openConsoleFromServer: vi.fn() },
    realtimeState: { syncRevisions: vi.fn() },
  };
});

vi.mock("../../../store/dbtStore", () => ({
  useDbtStore: { getState: () => stores.dbtState },
}));
vi.mock("../../../store/consoleStore", () => ({
  useConsoleStore: { getState: () => stores.consoleState },
}));
vi.mock("../../../store/realtimeStore", () => ({
  useRealtimeStore: { getState: () => stores.realtimeState },
}));

import { useServerToolSync } from "./useServerToolSync";

const WS = "ws1";
const PROJECT = "p1";

function toolMessage(
  toolName: string,
  output: Record<string, unknown>,
  opts: { toolCallId?: string; input?: Record<string, unknown> } = {},
): UIMessage[] {
  return [
    {
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: `tool-${toolName}`,
          state: "output-available",
          toolCallId: opts.toolCallId ?? "call-1",
          input: { projectId: PROJECT, ...opts.input },
          output,
        },
      ],
    },
  ] as unknown as UIMessage[];
}

function render(messages: UIMessage[]) {
  return renderHook(
    props =>
      useServerToolSync({
        chatId: "chat1",
        workspaceId: WS,
        messages: props.messages,
      }),
    { initialProps: { messages } },
  );
}

function markProjectLoaded() {
  stores.dbtState.projects = [{ _id: PROJECT }];
  stores.dbtState.filePathsByProject = { [PROJECT]: ["models/a.sql"] };
}

beforeEach(() => {
  vi.clearAllMocks();
  stores.dbtState.projects = [];
  stores.dbtState.filePathsByProject = {};
});

describe("dbt file mutation tools", () => {
  it("pulls the file after edit_dbt_file", () => {
    markProjectLoaded();
    render(
      toolMessage(
        "edit_dbt_file",
        { success: true },
        { input: { path: "models/a.sql" } },
      ),
    );
    expect(stores.dbtState.applyRemoteFileUpdate).toHaveBeenCalledWith(
      WS,
      PROJECT,
      "models/a.sql",
      false,
    );
  });

  it("drops the file after delete_dbt_file", () => {
    markProjectLoaded();
    render(
      toolMessage(
        "delete_dbt_file",
        { success: true },
        { input: { path: "models/a.sql" } },
      ),
    );
    expect(stores.dbtState.applyRemoteFileUpdate).toHaveBeenCalledWith(
      WS,
      PROJECT,
      "models/a.sql",
      true,
    );
  });

  it("handles each tool call once across re-renders (dedupe)", () => {
    markProjectLoaded();
    const messages = toolMessage(
      "modify_dbt_file",
      { success: true },
      { input: { path: "models/a.sql" } },
    );
    const { rerender } = render(messages);
    rerender({ messages: [...messages] });
    expect(stores.dbtState.applyRemoteFileUpdate).toHaveBeenCalledTimes(1);
  });

  it("ignores results for projects this window never loaded", () => {
    render(
      toolMessage(
        "modify_dbt_file",
        { success: true },
        { input: { path: "models/a.sql" } },
      ),
    );
    expect(stores.dbtState.applyRemoteFileUpdate).not.toHaveBeenCalled();
  });

  it("ignores failed tool results", () => {
    markProjectLoaded();
    render(
      toolMessage(
        "modify_dbt_file",
        { success: false },
        { input: { path: "models/a.sql" } },
      ),
    );
    expect(stores.dbtState.applyRemoteFileUpdate).not.toHaveBeenCalled();
  });
});
