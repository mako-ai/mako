import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_FRAME_SANDBOX,
  appFrameForMessage,
  appFrameMessageOrigin,
  appFrameSandbox,
  reachableViewUrl,
  resetAppHostProbes,
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

  it("lets the app save files it builds", () => {
    expect(APP_FRAME_SANDBOX.split(" ")).toContain("allow-downloads");
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

describe("appFrameForMessage", () => {
  const src = `https://${appId}.makoapps.dev/api/apps-preview/pub.x.y/`;
  const win = {} as Window;
  const frame = {
    contentWindow: win,
    getAttribute: () => src,
  } as unknown as HTMLIFrameElement;
  const origin = `https://${appId}.makoapps.dev`;

  it("finds the frame that sent the message from its own origin", () => {
    expect(appFrameForMessage({ source: win, origin }, [frame], page)).toBe(
      frame,
    );
  });

  it("refuses a frame that navigated to another origin", () => {
    expect(
      appFrameForMessage(
        { source: win, origin: "https://evil.example" },
        [frame],
        page,
      ),
    ).toBeNull();
  });

  it("refuses a window that is not a frame on this page", () => {
    expect(
      appFrameForMessage({ source: {} as Window, origin }, [frame], page),
    ).toBeNull();
  });
});

describe("reachableViewUrl", () => {
  const foreign = `https://${appId}.makousercontent.com/api/apps-preview/pub.x.y/`;
  const ok = () =>
    vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

  beforeEach(() => resetAppHostProbes());

  it("keeps a same-origin URL without probing", async () => {
    const fetchImpl = ok();
    expect(
      await reachableViewUrl("/api/apps-preview/pub.x.y/", {
        fetchImpl,
        pageHref: page,
      }),
    ).toBe("/api/apps-preview/pub.x.y/");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the app's own origin when its host answers the ping", async () => {
    const fetchImpl = ok();
    expect(await reachableViewUrl(foreign, { fetchImpl, pageHref: page })).toBe(
      foreign,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://${appId}.makousercontent.com/__mako/ping`,
      expect.objectContaining({ mode: "cors", credentials: "omit" }),
    );
  });

  it("falls back to Mako's origin when a proxy blocks the apps domain", async () => {
    // A blocked CORS fetch rejects; a proxy page that passes CORS is not JSON.
    for (const fetchImpl of [
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      vi.fn(async () => new Response("<html>zscaler</html>", { status: 200 })),
      vi.fn(async () => new Response("blocked", { status: 403 })),
    ]) {
      resetAppHostProbes();
      expect(
        await reachableViewUrl(`${foreign}?region=ch`, {
          fetchImpl,
          pageHref: page,
        }),
      ).toBe("/api/apps-preview/pub.x.y/?region=ch");
    }
  });

  it("gives up on a hung probe after the timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    expect(
      await reachableViewUrl(foreign, {
        fetchImpl,
        pageHref: page,
        timeoutMs: 10,
      }),
    ).toBe("/api/apps-preview/pub.x.y/");
  });

  it("remembers a block for every app host, without probing again", async () => {
    const blocked = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await reachableViewUrl(foreign, { fetchImpl: blocked, pageHref: page });
    const other =
      "https://33d9b603172c133a8427e813.makousercontent.com/api/apps-preview/pub.a.b/";
    const fetchImpl = ok();
    expect(await reachableViewUrl(other, { fetchImpl, pageHref: page })).toBe(
      "/api/apps-preview/pub.a.b/",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
