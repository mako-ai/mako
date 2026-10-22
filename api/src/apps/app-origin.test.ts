/**
 * Per-app origins (app-origin.ts): the security properties that make
 * `allow-same-origin` safe on an app's own host, and the stable URLs that
 * make the browser cache work there.
 */
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const served = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("./deployment.service", () => ({
  contentTypeFor: () => "text/html; charset=utf-8",
  serveDeploymentFile: async (input: Record<string, unknown>) => {
    served.calls.push(input);
    return new Response("<!doctype html><script src=x.js></script>", {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-cache",
        // A stray cookie must never leave an app host.
        "Set-Cookie": "leak=1; Path=/",
      },
    });
  },
}));

import {
  appFrameAncestors,
  appIdFromHost,
  appOriginConfig,
  appOriginFor,
  stableWindow,
} from "./app-origin";
import { mintPublishedGrant } from "./preview.service";
import { appsHostGate } from "../middleware/apps-host-gate";
import { appsPreviewRoutes } from "../routes/apps-preview";
import { APP_DOCUMENT_SANDBOX } from "./app-document-sandbox";

const ws = "6846e6a01b05af0948070582";
const appA = "23d9b603172c133a8427e812";
const appB = "33d9b603172c133a8427e813";
const sha = "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b";
const HOUR = 60 * 60 * 1000;

function server() {
  const app = new Hono();
  // Same order as index.ts: the gate outermost, secureHeaders inside it,
  // so the X-Frame-Options it adds is provably removed on app hosts.
  app.use("*", appsHostGate);
  app.use("*", secureHeaders({ xFrameOptions: "SAMEORIGIN" }));
  // Stand-ins for everything else Mako serves: none may answer on an app host.
  app.get("/api/auth/me", c =>
    c.json({ user: c.req.header("cookie") ?? null }),
  );
  app.get("/", c => c.html("<p>Mako SPA</p>"));
  app.route("/api/apps-preview", appsPreviewRoutes);
  return app;
}

function tokenFor(projectId: string, stable = true) {
  return mintPublishedGrant({
    workspaceId: ws,
    projectId,
    sha,
    viewer: { id: "u1", email: "sam@acme.com" },
    ...(stable ? { stableWindowMs: HOUR } : {}),
  }).token;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-secret-0123456789abcdef";
  process.env.CLIENT_URL = "https://app.mako.ai";
  process.env.APPS_ORIGIN_BASE = "https://makoapps.dev";
  served.calls.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.SESSION_SECRET;
  delete process.env.CLIENT_URL;
  delete process.env.APPS_ORIGIN_BASE;
  delete process.env.APPS_ORIGIN_FRAME_ANCESTORS;
});

describe("configuration", () => {
  it("is off unless APPS_ORIGIN_BASE is set", () => {
    delete process.env.APPS_ORIGIN_BASE;
    expect(appOriginConfig()).toBeNull();
    expect(appOriginFor(appA)).toBeNull();
    expect(appIdFromHost(`${appA}.makoapps.dev`)).toBeNull();
  });

  it("refuses an apps domain on Mako's own site (SameSite cookies would flow)", () => {
    process.env.APPS_ORIGIN_BASE = "https://apps.mako.ai";
    expect(appOriginConfig()).toBeNull();
    expect(appOriginFor(appA)).toBeNull();
  });

  it("names one origin per app, and only for a real app id", () => {
    expect(appOriginFor(appA)).toBe(`https://${appA}.makoapps.dev`);
    expect(appOriginFor("not-an-id")).toBeNull();
    expect(appOriginFor("../evil")).toBeNull();
  });

  it("recognises app hosts and nothing else", () => {
    expect(appIdFromHost(`${appA}.makoapps.dev`)).toBe(appA);
    expect(appIdFromHost(`${appA.toUpperCase()}.MAKOAPPS.DEV`)).toBe(appA);
    expect(appIdFromHost("makoapps.dev")).toBeNull();
    expect(appIdFromHost("app.mako.ai")).toBeNull();
    expect(appIdFromHost(`x.${appA}.makoapps.dev`)).toBeNull();
    expect(appIdFromHost(`${appA}.makoapps.dev.evil.com`)).toBeNull();
    // The port is part of the origin.
    process.env.APPS_ORIGIN_BASE = "http://makoapps.test:8080";
    expect(appIdFromHost(`${appA}.makoapps.test:8080`)).toBe(appA);
    expect(appIdFromHost(`${appA}.makoapps.test`)).toBeNull();
  });

  it("lets only Mako frame an app host", () => {
    expect(appFrameAncestors()).toBe("https://app.mako.ai");
    process.env.APPS_ORIGIN_FRAME_ANCESTORS = "https://app-canary.mako.ai";
    expect(appFrameAncestors()).toBe(
      "https://app.mako.ai https://app-canary.mako.ai",
    );
    delete process.env.CLIENT_URL;
    delete process.env.APPS_ORIGIN_FRAME_ANCESTORS;
    expect(appFrameAncestors()).toBe("'none'");
  });
});

describe("stable view tokens", () => {
  it("are one string per viewer, app and commit for a whole window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T10:00:01Z"));
    const first = tokenFor(appA);
    vi.setSystemTime(new Date("2026-10-22T10:59:59Z"));
    expect(tokenFor(appA)).toBe(first);
    vi.setSystemTime(new Date("2026-10-22T11:00:01Z"));
    expect(tokenFor(appA)).not.toBe(first);
  });

  it("never carry less than the usual 30 minutes, nor more than window + 30", () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-22T10:59:59Z");
    vi.setSystemTime(now);
    const late = mintPublishedGrant({
      workspaceId: ws,
      projectId: appA,
      sha,
      stableWindowMs: HOUR,
    });
    expect(late.expiresAt - now).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(late.expiresAt).toBe(stableWindow(now, HOUR).end + 30 * 60 * 1000);
  });

  it("stay per-request when not asked to be stable (feature off)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T10:00:01Z"));
    const first = tokenFor(appA, false);
    vi.setSystemTime(new Date("2026-10-22T10:00:02Z"));
    expect(tokenFor(appA, false)).not.toBe(first);
  });
});

describe("the app host gate", () => {
  const onHost = (host: string, path: string, headers = {}) =>
    server().request(path, { headers: { host, ...headers } });

  it("serves the app's own files on its own host, cacheable", async () => {
    const token = tokenFor(appA);
    const res = await onHost(
      `${appA}.makoapps.dev`,
      `/api/apps-preview/${token}/`,
    );
    expect(res.status).toBe(200);
    expect(served.calls[0]?.projectId).toBe(appA);
    expect(served.calls[0]?.immutableUntil).toBeGreaterThan(Date.now());
    expect(served.calls[0]?.stableData).toBeTruthy();
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors https://app.mako.ai",
    );
    expect(res.headers.get("X-Frame-Options")).toBeNull();
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("trusts X-Forwarded-Host from the edge Worker", async () => {
    const token = tokenFor(appA);
    const res = await onHost(
      "mako-abc-ew.a.run.app",
      `/api/apps-preview/${token}/`,
      { "x-forwarded-host": `${appA}.makoapps.dev` },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors",
    );
  });

  it("refuses another app's token: token scope is one app", async () => {
    const tokenB = tokenFor(appB);
    const res = await onHost(
      `${appA}.makoapps.dev`,
      `/api/apps-preview/${tokenB}/`,
    );
    expect(res.status).toBe(404);
    expect(served.calls).toHaveLength(0);
  });

  it("refuses forged, static-preview and missing tokens", async () => {
    const host = `${appA}.makoapps.dev`;
    const [prefix, body] = tokenFor(appA).split(".");
    for (const path of [
      `/api/apps-preview/${prefix}.${body}.forged/`,
      "/api/apps-preview/static-preview-token/",
      "/api/apps-preview/",
      "/api/apps-preview/%E0%A4%A/",
    ]) {
      expect((await onHost(host, path)).status).toBe(404);
    }
    expect(served.calls).toHaveLength(0);
  });

  it("answers nothing else: no session, no API, no SPA on an app host", async () => {
    const host = `${appA}.makoapps.dev`;
    const me = await onHost(host, "/api/auth/me", {
      cookie: "mako_session=valid-session-id",
    });
    expect(me.status).toBe(404);
    expect(await me.text()).not.toContain("valid-session-id");
    expect((await onHost(host, "/")).status).toBe(404);
    expect((await onHost(host, "/api/workspaces")).status).toBe(404);
  });

  it("leaves Mako's own host alone", async () => {
    const me = await onHost("app.mako.ai", "/api/auth/me", {
      cookie: "mako_session=s",
    });
    expect(me.status).toBe(200);
    expect(me.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  });
});

describe("token URLs on Mako's own origin", () => {
  it("sandbox the document, so a top-level open cannot run as app.mako.ai", async () => {
    const token = tokenFor(appA, false);
    const res = await server().request(`/api/apps-preview/${token}/`, {
      headers: { host: "app.mako.ai" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(
      APP_DOCUMENT_SANDBOX,
    );
    expect(APP_DOCUMENT_SANDBOX).not.toContain("allow-same-origin");
    // And stay uncacheable: an opaque-origin frame caches nothing anyway.
    expect(served.calls[0]?.immutableUntil).toBeUndefined();
  });
});
