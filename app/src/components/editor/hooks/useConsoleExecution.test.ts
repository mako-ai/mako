// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ConsoleTab } from "../../../store/lib/types";

const executeQuery = vi.fn();
const cancelQuery = vi.fn();
const storeState = {
  tabs: {} as Record<string, Partial<ConsoleTab>>,
  executeQuery,
  cancelQuery,
};
vi.mock("../../../store/consoleStore", () => {
  const useConsoleStore = (selector: (s: typeof storeState) => unknown) =>
    selector(storeState);
  useConsoleStore.getState = () => storeState;
  return { useConsoleStore };
});
vi.mock("../../../lib/analytics", () => ({ trackEvent: vi.fn() }));

import { useConsoleExecution } from "./useConsoleExecution";

const feedback = {
  showError: vi.fn(),
  closeError: vi.fn(),
  setErrorPreviewRetry: vi.fn(),
  showSnackbar: vi.fn(),
  hideSnackbar: vi.fn(),
};

const setup = (consoleTabs: ConsoleTab[] = []) => {
  const onExecuted = vi.fn();
  const hook = renderHook(
    ({ tabs }: { tabs: ConsoleTab[] }) =>
      useConsoleExecution({
        workspaceId: "ws",
        consoleTabs: tabs,
        feedback,
        onExecuted,
      }),
    { initialProps: { tabs: consoleTabs } },
  );
  return { ...hook, onExecuted };
};

beforeEach(() => {
  vi.clearAllMocks();
  storeState.tabs = {
    t1: {
      id: "t1",
      kind: "console",
      content: "select 1",
      connectionId: "c1",
      databaseName: "db",
    },
  };
});

describe("useConsoleExecution", () => {
  it("stores a successful page and pages forward with its cursor", async () => {
    executeQuery.mockResolvedValue({
      success: true,
      rows: [{ a: 1 }],
      pageInfo: {
        pageSize: 1,
        hasMore: true,
        nextCursor: "next",
        returnedRows: 1,
        capApplied: false,
      },
    });
    const { result, onExecuted } = setup();

    await act(() => result.current.execute("t1", "select 1", "c1"));
    expect(result.current.tabResults.t1?.results).toEqual([{ a: 1 }]);
    expect(result.current.executingTabs.t1).toBe(false);
    expect(onExecuted).toHaveBeenCalledWith("t1");
    expect(executeQuery.mock.calls[0][3]).toMatchObject({
      pageSize: 500,
      cursor: null,
      consoleId: "t1",
    });

    await act(() => result.current.nextPage("t1"));
    expect(executeQuery.mock.calls[1][3]).toMatchObject({
      cursor: "next",
      currentPage: 2,
      cursorHistory: [null, "next"],
      pageSize: 1,
      databaseName: "db",
    });
  });

  it("offers an admin retry for a PREVIEW_BLOCKED query", async () => {
    executeQuery.mockResolvedValue({
      success: false,
      error: "blocked",
      code: "PREVIEW_BLOCKED",
    });
    const { result } = setup();
    await act(() => result.current.execute("t1", "drop x", "c1"));
    expect(feedback.showError).toHaveBeenCalledWith("blocked");
    expect(feedback.setErrorPreviewRetry).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: "t1", contentToExecute: "drop x" }),
    );
    expect(result.current.tabResults.t1).toBeNull();
  });

  it("does not surface a cancelled query as an error", async () => {
    executeQuery.mockResolvedValue({
      success: false,
      error: "Query cancelled",
    });
    const { result } = setup();
    await act(() => result.current.execute("t1", "select 1", "c1"));
    expect(feedback.showError).not.toHaveBeenCalled();
  });

  it("refuses to run without a connection", async () => {
    const { result } = setup();
    await act(() => result.current.execute("t1", "select 1", undefined));
    expect(feedback.showError).toHaveBeenCalledWith(
      "No database connection selected",
    );
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it("renders a persisted lastRun artifact for a tab with no results", () => {
    const tab = {
      id: "t1",
      lastRun: {
        at: "2026-01-01T00:00:00.000Z",
        status: "success",
        durationMs: 3,
        sampleRows: [{ x: 1 }],
      },
    } as unknown as ConsoleTab;
    const { result } = setup([tab]);
    expect(result.current.tabResults.t1?.results).toEqual([{ x: 1 }]);
  });

  it("tracks agent-driven runs from window events", () => {
    const { result } = setup();
    act(() => {
      window.dispatchEvent(
        new CustomEvent("console-execution-start", {
          detail: { consoleId: "t1" },
        }),
      );
    });
    expect(result.current.executingTabs.t1).toBe(true);
    act(() => {
      window.dispatchEvent(
        new CustomEvent("console-execution-result", {
          detail: { consoleId: "t1", result: null },
        }),
      );
    });
    expect(result.current.executingTabs.t1).toBe(false);
    expect(result.current.tabResults.t1).toBeNull();
  });

  it("forgets a dropped tab", async () => {
    executeQuery.mockResolvedValue({ success: true, rows: [] });
    const { result } = setup();
    await act(() => result.current.execute("t1", "select 1", "c1"));
    act(() => result.current.dropTab("t1"));
    expect("t1" in result.current.tabResults).toBe(false);
  });
});
