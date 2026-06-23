// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleRevisionSyncEntry } from "../lib/api-types";
import { useConsoleStore } from "./consoleStore";

const CONSOLE_ID = "507f1f77bcf86cd799439011";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  useConsoleStore.setState({
    tabs: {},
    tabOrder: [],
    activeTabId: null,
    loading: {},
    error: {},
  });
});

describe("consoleStore beginAgentReview", () => {
  it("fast-forwards matching agent-origin entries without opening a diff", () => {
    useConsoleStore.getState().openTab(
      {
        id: CONSOLE_ID,
        title: "Draft",
        content: "select 1;",
        isSaved: false,
        kind: "console",
        draftRevision: 1,
      },
      { replacePristine: false },
    );
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const entry: ConsoleRevisionSyncEntry = {
      id: CONSOLE_ID,
      content: "select 1;",
      name: "Agent Draft",
      draftRevision: 3,
      version: 2,
      isSaved: false,
      lastDraftOrigin: "agent",
    };

    useConsoleStore.getState().beginAgentReview(entry);

    const tab = useConsoleStore.getState().tabs[CONSOLE_ID];
    expect(tab?.content).toBe("select 1;");
    expect(tab?.draftRevision).toBe(3);
    expect(tab?.version).toBe(2);
    expect(tab?.title).toBe("Agent Draft");
    expect(
      dispatchSpy.mock.calls.some(
        ([event]) =>
          event instanceof CustomEvent && event.type === "console-agent-diff",
      ),
    ).toBe(false);
  });
});
