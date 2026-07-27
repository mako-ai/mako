import { beforeEach, describe, expect, it, vi } from "vitest";

const focusAppTab = vi.fn();
const fetchApp = vi.fn();
const bumpPreview = vi.fn();
const fetchList = vi.fn();

vi.mock("../app-runtime/shell", () => ({
  focusAppTab: (...args: unknown[]) => focusAppTab(...args),
}));

vi.mock("../store/appStore", () => ({
  useAppStore: {
    getState: () => ({
      openApps: mockOpenApps,
      fetchApp,
      bumpPreview,
      fetchList,
    }),
  },
}));

let mockOpenApps: Record<string, unknown> = {};

import {
  extractAppIdFromAcpTool,
  maybeFocusAppFromAcpTool,
} from "./acp-app-focus";

describe("acp-app-focus", () => {
  beforeEach(() => {
    mockOpenApps = {};
    focusAppTab.mockReset();
    fetchApp.mockReset();
    bumpPreview.mockReset();
    fetchList.mockReset();
    fetchApp.mockResolvedValue({ _id: "app1", title: "Cost Explorer" });
  });

  it("extracts appId from create_app output", () => {
    expect(
      extractAppIdFromAcpTool({
        rawOutput: { success: true, appId: "app1", title: "Cost Explorer" },
      }),
    ).toEqual({ appId: "app1", title: "Cost Explorer" });
  });

  it("extracts appId from create_preview_token input", () => {
    expect(
      extractAppIdFromAcpTool({
        rawInput: { appId: "app1" },
        rawOutput: { url: "https://example.com/preview/x" },
      }),
    ).toEqual({ appId: "app1", title: undefined });
  });

  it("opens the app tab when create_app completes", async () => {
    const scheduled = maybeFocusAppFromAcpTool("ws1", {
      status: "completed",
      name: "mcp__mako-workspace__create_app",
      rawOutput: { appId: "app1", title: "Cost Explorer" },
    });
    expect(scheduled).toBe(true);
    await vi.waitFor(() => {
      expect(focusAppTab).toHaveBeenCalledWith("app1", "Cost Explorer");
      expect(bumpPreview).toHaveBeenCalledWith("app1");
    });
  });

  it("opens the app when create_preview_token completes (Desktop instead of URL)", async () => {
    const scheduled = maybeFocusAppFromAcpTool("ws1", {
      status: "completed",
      name: "mcp__mako-workspace__create_preview_token",
      rawInput: { appId: "app1" },
      rawOutput: { url: "https://pr-739.mako.ai/preview/mpt_x" },
    });
    expect(scheduled).toBe(true);
    await vi.waitFor(() => {
      expect(focusAppTab).toHaveBeenCalledWith("app1", "Cost Explorer");
    });
  });

  it("refreshes but does not re-focus an already-open app on file edit", async () => {
    mockOpenApps = { app1: { _id: "app1" } };
    const scheduled = maybeFocusAppFromAcpTool("ws1", {
      status: "completed",
      name: "mcp__mako-workspace__app_write_file",
      rawInput: { appId: "app1", path: "src/App.tsx" },
      rawOutput: { success: true },
    });
    expect(scheduled).toBe(true);
    await vi.waitFor(() => {
      expect(bumpPreview).toHaveBeenCalledWith("app1");
    });
    expect(focusAppTab).not.toHaveBeenCalled();
  });

  it("does not rebuild preview on get_app_state (avoids black flash)", async () => {
    mockOpenApps = { app1: { _id: "app1" } };
    const scheduled = maybeFocusAppFromAcpTool("ws1", {
      status: "completed",
      name: "mcp__mako-workspace__get_app_state",
      rawInput: { appId: "app1" },
      rawOutput: { success: true, appId: "app1" },
    });
    expect(scheduled).toBe(true);
    await vi.waitFor(() => {
      expect(fetchApp).toHaveBeenCalled();
    });
    expect(bumpPreview).not.toHaveBeenCalled();
    expect(focusAppTab).not.toHaveBeenCalled();
  });

  it("ignores unrelated tools", () => {
    expect(
      maybeFocusAppFromAcpTool("ws1", {
        status: "completed",
        name: "mcp__mako-workspace__sql_execute_query",
        rawOutput: { rows: [] },
      }),
    ).toBe(false);
  });
});
