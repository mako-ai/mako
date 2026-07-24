import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildAcpUiContextBlock, prependAcpUiContext } from "./acp-ui-context";

vi.mock("../store/consoleStore", () => ({
  useConsoleStore: {
    getState: () => ({
      tabs: {},
      activeTabId: null,
    }),
  },
}));

vi.mock("../store/schemaStore", () => ({
  useSchemaStore: {
    getState: () => ({ connections: [] }),
  },
}));

vi.mock("../store/uiStore", () => ({
  selectActiveExplorer: () => null,
  useUIStore: {
    getState: () => ({}),
  },
}));

vi.mock("../store/appStore", () => ({
  useAppStore: {
    getState: () => ({
      openApps: {
        app1: { title: "Demo App" },
      },
      activeAppId: "app1",
      previewErrors: {
        app1: [{ message: "boom", source: "runtime" }],
      },
    }),
  },
}));

vi.mock("../agent-runtime/request-context", () => ({
  buildChatRequestBody: () => ({
    activeView: "console",
    activeExplorer: null,
    openTabs: [],
    openConsoles: [],
    activeDashboardContext: null,
  }),
}));

describe("buildAcpUiContextBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes open apps and preview errors", () => {
    const block = buildAcpUiContextBlock({ workspaceId: "w1" });
    expect(block).toContain("Mako Desktop UI context");
    expect(block).toContain("openApps");
    expect(block).toContain("Demo App");
    expect(block).toContain("boom");
    expect(block).toContain("mako-desktop__run_app");
  });
});

describe("prependAcpUiContext", () => {
  it("prepends context above the user message", () => {
    expect(prependAcpUiContext("hello", "[ctx]")).toBe(
      "[ctx]\n\n[User message]\nhello",
    );
  });
});
