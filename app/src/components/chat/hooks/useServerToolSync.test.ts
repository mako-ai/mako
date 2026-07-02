// @vitest-environment jsdom
/**
 * useServerToolSync — dbt git/checkout chat-stream backstop.
 *
 * Regression coverage for "the UI doesn't follow the agent's branch": a
 * server-side dbt_switch_branch only reached open tabs via the workspace SSE
 * poke (dbt.checkout.updated), so a dead/dropped stream left the tab
 * rendering the old branch/tree until a manual reload. The hook now also
 * reconciles off the resumable chat stream when git tool results arrive.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { UIMessage } from "ai";

const stores = vi.hoisted(() => {
  const dbtState = {
    projects: [] as Array<{ _id: string; repo?: { owner: string } }>,
    filePathsByProject: {} as Record<string, string[]>,
    gitStatusByProject: {} as Record<string, unknown>,
    applyRemoteFileUpdate: vi.fn(),
    applyRemoteGitUpdate: vi.fn(),
    applyRemoteCheckoutUpdate: vi.fn(),
    fetchGitStatus: vi.fn(),
  };
  return {
    dbtState,
    consoleState: { tabs: {}, openConsoleFromServer: vi.fn() },
    realtimeState: { syncRevisions: vi.fn() },
    appState: { openApps: {}, fetchApp: vi.fn(), bumpPreview: vi.fn() },
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
vi.mock("../../../store/appStore", () => ({
  useAppStore: { getState: () => stores.appState },
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

function markProjectLoaded(withRepo = true) {
  stores.dbtState.projects = [
    { _id: PROJECT, ...(withRepo ? { repo: { owner: "acme" } } : {}) },
  ];
  stores.dbtState.filePathsByProject = { [PROJECT]: ["models/a.sql"] };
  stores.dbtState.gitStatusByProject = { [PROJECT]: { branch: "main" } };
}

beforeEach(() => {
  vi.clearAllMocks();
  stores.dbtState.projects = [];
  stores.dbtState.filePathsByProject = {};
  stores.dbtState.gitStatusByProject = {};
});

describe("dbt checkout-moving tools (branch follow)", () => {
  it("follows a dbt_switch_branch result onto the new branch", () => {
    markProjectLoaded();
    render(
      toolMessage("dbt_switch_branch", { success: true, branch: "feat/x" }),
    );
    expect(stores.dbtState.applyRemoteCheckoutUpdate).toHaveBeenCalledWith(
      WS,
      PROJECT,
      "feat/x",
    );
  });

  it("follows dbt_commit_to_branch onto the promoted branch", () => {
    markProjectLoaded();
    render(
      toolMessage("dbt_commit_to_branch", { success: true, branch: "feat/y" }),
    );
    expect(stores.dbtState.applyRemoteCheckoutUpdate).toHaveBeenCalledWith(
      WS,
      PROJECT,
      "feat/y",
    );
  });

  it("handles each tool call once across re-renders (dedupe)", () => {
    markProjectLoaded();
    const messages = toolMessage("dbt_switch_branch", {
      success: true,
      branch: "feat/x",
    });
    const { rerender } = render(messages);
    rerender({ messages: [...messages] });
    expect(stores.dbtState.applyRemoteCheckoutUpdate).toHaveBeenCalledTimes(1);
  });

  it("ignores results for projects this window never loaded", () => {
    render(
      toolMessage("dbt_switch_branch", { success: true, branch: "feat/x" }),
    );
    expect(stores.dbtState.applyRemoteCheckoutUpdate).not.toHaveBeenCalled();
  });

  it("ignores failed tool results", () => {
    markProjectLoaded();
    render(toolMessage("dbt_switch_branch", { success: false }));
    expect(stores.dbtState.applyRemoteCheckoutUpdate).not.toHaveBeenCalled();
  });
});

describe("dbt git-surface tools (no checkout move)", () => {
  it("refetches tree + status after dbt_sync_from_repo", () => {
    markProjectLoaded();
    render(
      toolMessage("dbt_sync_from_repo", { success: true, branch: "main" }),
    );
    // Sync carries `branch` in its output but does NOT move the checkout —
    // it must reconcile via the git-update path, not the checkout path.
    expect(stores.dbtState.applyRemoteGitUpdate).toHaveBeenCalledWith(
      WS,
      PROJECT,
    );
    expect(stores.dbtState.applyRemoteCheckoutUpdate).not.toHaveBeenCalled();
  });

  it("refetches tree + status after dbt_commit_and_push", () => {
    markProjectLoaded();
    render(
      toolMessage("dbt_commit_and_push", { success: true, branch: "main" }),
    );
    expect(stores.dbtState.applyRemoteGitUpdate).toHaveBeenCalledWith(
      WS,
      PROJECT,
    );
  });
});

describe("dbt file mutation tools", () => {
  it("pulls the file AND refreshes git status after edit_dbt_file", () => {
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
    expect(stores.dbtState.fetchGitStatus).toHaveBeenCalledWith(WS, PROJECT);
  });

  it("skips the git-status refresh for non-repo projects", () => {
    markProjectLoaded(false);
    render(
      toolMessage(
        "modify_dbt_file",
        { success: true },
        { input: { path: "models/a.sql" } },
      ),
    );
    expect(stores.dbtState.applyRemoteFileUpdate).toHaveBeenCalled();
    expect(stores.dbtState.fetchGitStatus).not.toHaveBeenCalled();
  });
});
