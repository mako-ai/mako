// @vitest-environment jsdom
/**
 * Client run_app executor: settle-await on previewStatus, shared RunAppResult
 * envelope, and per-delivery screenshot handling (chat vision attachment vs
 * desktop-bridge inline vs none for older Local Agents).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const captureAppPreview = vi.fn<(appId: string) => Promise<string>>();
const findAppPreviewIframe = vi.fn<(appId: string) => unknown>();
const enqueueScreenshotVisionAttachment = vi.fn<(a: unknown) => boolean>();

vi.mock("./preview-capture", () => ({
  captureAppPreview: (appId: string) => captureAppPreview(appId),
  findAppPreviewIframe: (appId: string) => findAppPreviewIframe(appId),
}));

vi.mock("../agent-runtime/screenshot-agent-tools", () => ({
  enqueueScreenshotVisionAttachment: (a: unknown) =>
    enqueueScreenshotVisionAttachment(a),
}));

vi.mock("./shell", () => ({
  focusAppTab: () => undefined,
  getCurrentWorkspaceId: () => null,
}));

vi.mock("../store/consoleStore", () => ({
  useConsoleStore: { getState: () => ({ tabs: {}, activeTabId: null }) },
}));

import { executeAppAgentTool } from "./agent-tools";
import { useAppStore, type AppEntity } from "../store/appStore";

const APP_ID = "app-under-test";
const PNG_DATA_URL = `data:image/png;base64,${"iVBORw0KGgo="}`;

function openTestApp(): void {
  useAppStore.setState(state => ({
    ...state,
    openApps: {
      [APP_ID]: {
        _id: APP_ID,
        workspaceId: "w1",
        title: "Test App",
        template: "react",
        runtime: "cdn",
        entrypoint: "index.tsx",
        files: [],
        dependencies: {},
        dataBindings: [],
        version: 1,
      } as unknown as AppEntity,
    },
    previewNonce: { [APP_ID]: 0 },
    previewErrors: {},
    previewStatus: {},
  }));
}

/** Simulate the AppRenderer iframe bootstrap reporting after `delayMs`. */
function reportPreview(
  delayMs: number,
  errors: Array<{ message: string; source?: "build" | "runtime"; at: number }>,
): void {
  setTimeout(() => {
    useAppStore.getState().setPreviewErrors(APP_ID, errors);
  }, delayMs);
}

beforeEach(() => {
  vi.restoreAllMocks();
  captureAppPreview.mockResolvedValue(PNG_DATA_URL);
  findAppPreviewIframe.mockReturnValue({});
  enqueueScreenshotVisionAttachment.mockReturnValue(true);
  openTestApp();
});

describe("run_app client executor", () => {
  it("awaits the ready report and queues the screenshot as a vision attachment", async () => {
    reportPreview(200, []);
    const result = await executeAppAgentTool("run_app", { appId: APP_ID });
    expect(result).toMatchObject({
      success: true,
      status: "ready",
      errors: [],
      source: "iframe",
      screenshotPassedToModel: true,
    });
    // Base64 must never enter the JSON tool result on the chat path.
    expect(result.screenshot).toBeUndefined();
    expect(enqueueScreenshotVisionAttachment).toHaveBeenCalledOnce();
    expect(useAppStore.getState().previewNonce[APP_ID]).toBe(1);
  });

  it("reports build errors as a settled error envelope", async () => {
    reportPreview(200, [{ message: "boom", source: "build", at: Date.now() }]);
    const result = await executeAppAgentTool("run_app", {
      appId: APP_ID,
      includeScreenshot: false,
    });
    expect(result).toMatchObject({ success: false, status: "error" });
    expect(result.errors).toEqual([{ message: "boom", source: "build" }]);
    expect(captureAppPreview).not.toHaveBeenCalled();
  });

  it("returns the screenshot inline for the desktop bridge", async () => {
    reportPreview(200, []);
    const result = await executeAppAgentTool(
      "run_app",
      { appId: APP_ID },
      { screenshotDelivery: "inline" },
    );
    expect(result.screenshot).toEqual({
      mimeType: "image/png",
      base64: "iVBORw0KGgo=",
    });
    expect(enqueueScreenshotVisionAttachment).not.toHaveBeenCalled();
  });

  it("skips capture entirely for clients that cannot deliver images", async () => {
    reportPreview(200, []);
    const result = await executeAppAgentTool(
      "run_app",
      { appId: APP_ID },
      { screenshotDelivery: "none" },
    );
    expect(result.screenshot).toBeUndefined();
    expect(captureAppPreview).not.toHaveBeenCalled();
    expect(String(result.screenshotUnavailableReason)).toMatch(/update/i);
  });

  it("rebuild:false reads the settled state without bumping the preview", async () => {
    useAppStore.getState().setPreviewErrors(APP_ID, []);
    const result = await executeAppAgentTool("run_app", {
      appId: APP_ID,
      rebuild: false,
      includeScreenshot: false,
    });
    expect(result).toMatchObject({ success: true, status: "ready" });
    expect(useAppStore.getState().previewNonce[APP_ID]).toBe(0);
  });

  it("degrades to a reason (not a failure) when capture breaks", async () => {
    captureAppPreview.mockRejectedValue(new Error("no iframe"));
    reportPreview(200, []);
    const result = await executeAppAgentTool("run_app", { appId: APP_ID });
    expect(result).toMatchObject({ success: true, status: "ready" });
    expect(result.screenshotUnavailableReason).toBe("no iframe");
  });

  it("bails as timeout when no preview iframe is mounted", async () => {
    findAppPreviewIframe.mockReturnValue(null);
    const result = await executeAppAgentTool("run_app", {
      appId: APP_ID,
      includeScreenshot: false,
    });
    expect(result).toMatchObject({ success: false, status: "timeout" });
    expect(String(result.error)).toMatch(/open_app/);
  }, 10_000);

  it("applies width/height as an ephemeral viewport and restores the user's", async () => {
    useAppStore.getState().setPreviewViewport(APP_ID, {
      width: 768,
      height: 1024,
      preset: "tablet",
    });
    let viewportDuringCapture: unknown;
    captureAppPreview.mockImplementation(async () => {
      viewportDuringCapture = useAppStore.getState().previewViewport[APP_ID];
      return PNG_DATA_URL;
    });
    reportPreview(200, []);
    const result = await executeAppAgentTool("run_app", {
      appId: APP_ID,
      width: 390,
      height: 844,
    });
    expect(result).toMatchObject({
      success: true,
      viewport: { width: 390, height: 844 },
    });
    // Captured at the requested size, then put back to what the user had.
    expect(viewportDuringCapture).toEqual({ width: 390, height: 844 });
    expect(useAppStore.getState().previewViewport[APP_ID]).toEqual({
      width: 768,
      height: 1024,
      preset: "tablet",
    });
  });
});

describe("app_set_preview client executor", () => {
  it("sets a named preset as sticky view state via the merged tool", async () => {
    const result = await executeAppAgentTool("app_set_preview", {
      appId: APP_ID,
      preset: "phone",
    });
    expect(result).toMatchObject({
      success: true,
      viewport: { width: 390, height: 844, preset: "phone" },
    });
    expect(useAppStore.getState().previewViewport[APP_ID]).toEqual({
      width: 390,
      height: 844,
      preset: "phone",
    });
  });

  it("requires at least one of viewport or environment", async () => {
    const result = await executeAppAgentTool("app_set_preview", {
      appId: APP_ID,
    });
    expect(result).toMatchObject({ success: false });
    expect(String(result.error)).toMatch(/at least one/);
  });

  it("reports an applied viewport when the environment leg fails", async () => {
    // getCurrentWorkspaceId is mocked to null, so the environment leg fails
    // after the viewport leg already applied.
    const result = await executeAppAgentTool("app_set_preview", {
      appId: APP_ID,
      preset: "tablet",
      environment: "dev",
    });
    expect(result).toMatchObject({
      success: false,
      viewport: { width: 768, height: 1024, preset: "tablet" },
    });
    expect(String(result.note)).toMatch(/viewport change was applied/);
    expect(useAppStore.getState().previewViewport[APP_ID]).toEqual({
      width: 768,
      height: 1024,
      preset: "tablet",
    });
  });
});

describe("app_set_preview_viewport client executor (deprecated alias)", () => {
  it("sets a named preset as sticky view state", async () => {
    const result = await executeAppAgentTool("app_set_preview_viewport", {
      appId: APP_ID,
      preset: "phone",
    });
    expect(result).toMatchObject({
      success: true,
      viewport: { width: 390, height: 844, preset: "phone" },
    });
    expect(useAppStore.getState().previewViewport[APP_ID]).toEqual({
      width: 390,
      height: 844,
      preset: "phone",
    });
  });

  it("desktop preset clears the override", async () => {
    useAppStore
      .getState()
      .setPreviewViewport(APP_ID, { width: 390, height: 844, preset: "phone" });
    const result = await executeAppAgentTool("app_set_preview_viewport", {
      appId: APP_ID,
      preset: "desktop",
    });
    expect(result).toMatchObject({ success: true, viewport: null });
    expect(useAppStore.getState().previewViewport[APP_ID]).toBeNull();
  });

  it("rejects a custom size missing one dimension", async () => {
    const result = await executeAppAgentTool("app_set_preview_viewport", {
      appId: APP_ID,
      width: 390,
    });
    expect(result).toMatchObject({ success: false });
    expect(String(result.error)).toMatch(/both width and height/);
  });
});
