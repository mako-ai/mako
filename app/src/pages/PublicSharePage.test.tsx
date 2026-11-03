// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replaceLocation = vi.hoisted(() => vi.fn());
vi.mock("../lib/replace-location", () => ({ replaceLocation }));

import { resetAppHostProbes } from "../lib/app-frame";
import PublicSharePage from "./PublicSharePage";

const APP_URL =
  "https://23d9b603172c133a8427e812.makousercontent.com/api/apps-preview/pub.abc.sig/";

function respond(content: Record<string, unknown>, { blocked = false } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/__mako/ping")) {
        // A proxy's block page carries no CORS header, so the fetch rejects.
        if (blocked) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const body = url.endsWith("/content")
        ? { success: true, data: content }
        : {
            success: true,
            data: {
              type: "app",
              title: "Pipeline",
              passwordRequired: false,
              unlocked: true,
            },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

function renderShare(path = "/share/tok") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/share/:token" element={<PublicSharePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const base = {
  kind: "app",
  title: "Pipeline",
  published: true,
  entry: "/api/share/tok/app/",
};

describe("PublicSharePage", () => {
  beforeEach(() => {
    replaceLocation.mockReset();
    resetAppHostProbes();
    window.history.replaceState(null, "", "/share/tok");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("navigates to the entry when the server gives no app origin (flag off)", async () => {
    respond(base);
    renderShare();
    await waitFor(() =>
      expect(replaceLocation).toHaveBeenCalledWith("/api/share/tok/app/"),
    );
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("frames the app's own origin, with allow-same-origin, and stays on the share URL", async () => {
    respond({ ...base, appUrl: APP_URL });
    renderShare();
    const frame = (await screen.findByTitle("Pipeline")) as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe(APP_URL);
    expect(frame.getAttribute("sandbox")?.split(" ")).toEqual(
      expect.arrayContaining(["allow-scripts", "allow-same-origin"]),
    );
    expect(replaceLocation).not.toHaveBeenCalled();
    expect(document.title).toBe("Pipeline");
  });

  it("navigates to the entry and frames nothing when a proxy blocks the app's host", async () => {
    respond({ ...base, appUrl: APP_URL }, { blocked: true });
    renderShare();
    await waitFor(() =>
      expect(replaceLocation).toHaveBeenCalledWith("/api/share/tok/app/"),
    );
    expect(replaceLocation).toHaveBeenCalledTimes(1);
    expect(document.querySelector("iframe")).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `${new URL(APP_URL).origin}/__mako/ping`,
      expect.objectContaining({ mode: "cors", credentials: "omit" }),
    );
  });

  it("navigates to the entry and never frames a same-origin app URL", async () => {
    respond({ ...base, appUrl: "/api/apps-preview/pub.abc.sig/" });
    renderShare();
    await waitFor(() =>
      expect(replaceLocation).toHaveBeenCalledWith("/api/share/tok/app/"),
    );
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("seeds the share URL's query into the frame and mirrors the app's navigation back", async () => {
    window.history.replaceState(null, "", "/share/tok?region=ch");
    respond({ ...base, appUrl: APP_URL });
    renderShare("/share/tok?region=ch");
    const frame = (await screen.findByTitle("Pipeline")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(`${APP_URL}?region=ch`);

    const post = (origin: string, source: unknown) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "mako-app:navigate", search: "?region=fr" },
            origin,
            source: source as Window,
          }),
        );
      });
    // From the app's frame and origin: mirrored.
    post(new URL(APP_URL).origin, frame.contentWindow);
    expect(window.location.search).toBe("?region=fr");
    // Another origin, or another window: ignored.
    window.history.replaceState(null, "", "/share/tok?region=ch");
    post("https://evil.example", frame.contentWindow);
    post(new URL(APP_URL).origin, window);
    expect(window.location.search).toBe("?region=ch");
  });
});
