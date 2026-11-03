import { describe, expect, it } from "vitest";
import { buildChatRequestBody } from "./request-context";
import type { ConsoleTab } from "../store/lib/types";

const consoleTab: ConsoleTab = {
  id: "console_1",
  title: "Revenue Query",
  content: "select * from revenue",
  isSaved: true,
  kind: "console",
  connectionId: "conn_1",
  databaseName: "analytics",
};

describe("buildChatRequestBody", () => {
  it("builds console context on console turns", () => {
    const requestBody = buildChatRequestBody({
      messages: [],
      workspaceId: "ws_1",
      modelId: "model_1",
      chatId: "chat_1",
      tabs: [consoleTab],
      activeTabId: "console_1",
      activeTab: consoleTab,
      activeView: "console",
      activeExplorer: "consoles",
      activeConsoleId: "console_1",
      activeConsoleResults: {
        viewMode: "table",
        hasResults: true,
        rowCount: 1,
        columns: ["month", "revenue"],
        sampleRows: [{ month: "2026-01", revenue: 100 }],
        chartSpec: null,
      },
    });

    expect(requestBody.openTabs).toHaveLength(1);
    expect(requestBody.openTabs[0]).toMatchObject({
      id: "console_1",
      kind: "console",
      isActive: true,
      connectionId: "conn_1",
      databaseName: "analytics",
    });
    expect(requestBody.openConsoles).toHaveLength(1);
    expect(requestBody.consoleId).toBe("console_1");
  });

  it("carries entity ids for non-console tabs", () => {
    const flowTab: ConsoleTab = {
      id: "flow_tab_1",
      title: "Nightly sync",
      content: "",
      isSaved: true,
      kind: "flow-editor",
      metadata: { flowId: "flow_1", flowType: "scheduled" },
    };
    const notebookTab: ConsoleTab = {
      id: "nb_tab_1",
      title: "Notes",
      content: "",
      isSaved: true,
      kind: "notebook",
      metadata: { notebookId: "nb_1" },
    };

    const requestBody = buildChatRequestBody({
      messages: [],
      workspaceId: "ws_1",
      tabs: [flowTab, notebookTab],
      activeTabId: "flow_tab_1",
      activeTab: flowTab,
      activeView: "flow-editor",
      activeExplorer: "flows",
    });

    expect(requestBody.openConsoles).toEqual([]);
    expect(requestBody.tabKind).toBe("flow-editor");
    expect(requestBody.flowType).toBe("scheduled");
    expect(requestBody.openTabs).toEqual([
      expect.objectContaining({ id: "flow_tab_1", flowId: "flow_1" }),
      expect.objectContaining({ id: "nb_tab_1", notebookId: "nb_1" }),
    ]);
  });
});
