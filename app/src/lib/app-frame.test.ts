import { describe, expect, it } from "vitest";
import {
  APP_FRAME_SANDBOX,
  appFrameMessageOrigin,
  appFrameSandbox,
} from "./app-frame";

const page = "https://app.mako.ai/workspaces/w/apps/a";
const appId = "23d9b603172c133a8427e812";

describe("app iframe sandbox", () => {
  it("never grants allow-same-origin to a frame on Mako's own origin", () => {
    for (const src of [
      "/api/apps-preview/pub.x.y/",
      "https://app.mako.ai/api/apps-preview/pub.x.y/",
      "//app.mako.ai/api/apps-preview/pub.x.y/",
    ]) {
      expect(appFrameSandbox(src, APP_FRAME_SANDBOX, page)).toBe(
        APP_FRAME_SANDBOX,
      );
      expect(appFrameMessageOrigin(src, page)).toBe("null");
    }
  });

  it("grants it to a frame on the app's own foreign origin", () => {
    const src = `https://${appId}.makoapps.dev/api/apps-preview/pub.x.y/`;
    expect(appFrameSandbox(src, APP_FRAME_SANDBOX, page)).toBe(
      `${APP_FRAME_SANDBOX} allow-same-origin`,
    );
    expect(appFrameMessageOrigin(src, page)).toBe(
      `https://${appId}.makoapps.dev`,
    );
  });

  it("keeps the caller's base flags", () => {
    const src = `https://${appId}.makoapps.dev/x/`;
    expect(appFrameSandbox(src, "allow-scripts allow-forms", page)).toBe(
      "allow-scripts allow-forms allow-same-origin",
    );
  });

  it("treats non-http URLs as same-origin (no flag)", () => {
    for (const src of [
      "javascript:alert(1)",
      "data:text/html,x",
      "about:blank",
    ]) {
      expect(appFrameSandbox(src, APP_FRAME_SANDBOX, page)).toBe(
        APP_FRAME_SANDBOX,
      );
    }
  });
});
