/**
 * Shared apps run sandboxed: a share opens app code as a TOP-LEVEL page on
 * Mako's origin, so without a CSP sandbox that code would run as
 * app.mako.ai with a signed-in visitor's session in reach.
 *
 * Pinned here, against the real share routes and real Mongo:
 * - every document the share serves carries the sandbox, never
 *   allow-same-origin; scripts and data carry the wildcard ACAO an
 *   opaque-origin page needs;
 * - an open share, a password share and an anonymous visitor all still load;
 * - a password share's subresources work WITHOUT the cookie (the opaque
 *   page cannot send it) through a grant the document's <base> carries, and
 *   the grant is scoped to its share, signed, and expiring.
 *
 * The browser half (SHARE_SANDBOX_PLAYWRIGHT=<playwright-core dir> plus
 * CHROMIUM_PATH, headless) drives Chromium against these routes and checks
 * what app code on a share page can actually reach. It self-skips otherwise.
 */
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import bcrypt from "bcrypt";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The deployment store is the one thing faked: a tiny built app whose
// script reports what it can reach.
const APP_HTML = `<!doctype html><html><head><title>app</title>
<script type="module" crossorigin src="./assets/app.js"></script></head>
<body></body></html>`;
const APP_JS = `
const report = {};
try { report.cookie = document.cookie; } catch (e) { report.cookie = "threw:" + e.name; }
try { localStorage.setItem("k", "v"); report.storage = "ok"; } catch (e) { report.storage = "threw:" + e.name; }
try { report.origin = self.origin; } catch (e) { report.origin = "threw"; }
try {
  const r = await fetch("/api/me", { credentials: "include" });
  report.api = r.status + ":" + (await r.text());
} catch (e) { report.api = "blocked:" + e.name; }
try {
  const r = await fetch("__data/rows.parquet");
  report.data = r.status + ":" + (await r.text());
} catch (e) { report.data = "blocked:" + e.name; }
document.title = "report:" + JSON.stringify(report);
`;

vi.mock("../apps/deployment.service", () => ({
  serveDeploymentFile: async ({ assetPath }: { assetPath: string }) => {
    const file = (body: string, type: string) =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": type, "Cache-Control": "private, no-cache" },
      });
    if (assetPath === "" || assetPath === "index.html") {
      return file(APP_HTML, "text/html; charset=utf-8");
    }
    if (assetPath === "assets/app.js") return file(APP_JS, "text/javascript");
    if (assetPath === "logo.svg") {
      return file(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
        "image/svg+xml",
      );
    }
    if (assetPath === "__data/rows.parquet") {
      return file("PAR1", "application/vnd.apache.parquet");
    }
    return null;
  },
}));

import { cors } from "hono/cors";
import { publicShareRoutes, SHARE_APP_SANDBOX } from "./public-share";
import { AppProject } from "../database/workspace-schema";

const OPEN = "open-share-token";
const LOCKED = "locked-share-token";
const OTHER = "other-locked-token";

function server() {
  const app = new Hono();
  // As in index.ts: credentialed CORS for the SPA only.
  app.use("*", cors({ origin: "http://localhost:5173", credentials: true }));
  // Stand-in for any session-authorized API: echoes the cookie it got.
  app.get("/api/me", c =>
    c.text(
      c.req.header("cookie")?.includes("mako_session") ? "SESSION" : "anon",
      200,
      {
        "Access-Control-Allow-Origin": "*",
      },
    ),
  );
  app.route("/api/share", publicShareRoutes);
  return app;
}

let mongo: MongoMemoryServer;

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "share-sandbox-test-secret");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const passwordHash = await bcrypt.hash("pw", 4);
  const base = {
    workspaceId: new Types.ObjectId(),
    access: "workspace",
    owner_id: "owner",
    createdBy: "owner",
    publishedSha: "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b",
  };
  await AppProject.create([
    {
      ...base,
      title: "Open",
      slug: "open",
      publicShare: { enabled: true, token: OPEN },
    },
    {
      ...base,
      title: "Locked",
      slug: "locked",
      publicShare: { enabled: true, token: LOCKED, passwordHash },
    },
    {
      ...base,
      title: "Other",
      slug: "other",
      publicShare: { enabled: true, token: OTHER, passwordHash },
    },
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  vi.unstubAllEnvs();
});

async function unlock(token: string): Promise<string> {
  const res = await server().request(`/api/share/${token}/unlock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "pw" }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function baseHref(html: string): string | null {
  return /<base href="([^"]+)">/.exec(html)?.[1] ?? null;
}

describe("shared app documents are sandboxed", () => {
  it("serves an open share's HTML and SVG with the CSP sandbox, never allow-same-origin", async () => {
    for (const path of ["", "logo.svg"]) {
      const res = await server().request(`/api/share/${OPEN}/app/${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Security-Policy")).toBe(
        SHARE_APP_SANDBOX,
      );
    }
    expect(SHARE_APP_SANDBOX).toMatch(/^sandbox /);
    expect(SHARE_APP_SANDBOX).not.toContain("allow-same-origin");
    expect(SHARE_APP_SANDBOX).not.toContain("allow-top-navigation");
  });

  it("serves scripts and data to the opaque-origin page (wildcard ACAO, no sandbox on non-documents)", async () => {
    for (const path of ["assets/app.js", "__data/rows.parquet"]) {
      const res = await server().request(`/api/share/${OPEN}/app/${path}`, {
        headers: { Origin: "null" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
    }
  });

  it("an anonymous visitor of an open share loads with no cookie at all", async () => {
    const res = await server().request(`/api/share/${OPEN}/app/`);
    expect(res.status).toBe(200);
    // No password: no grant to inject, the document is served as built.
    expect(baseHref(await res.text())).toBeNull();
  });
});

describe("password shares without the cookie", () => {
  it("still refuses the document without an unlock", async () => {
    const res = await server().request(`/api/share/${LOCKED}/app/`);
    expect(res.status).toBe(401);
  });

  it("gives the unlocked document a <base> grant, and the subresources work on the grant alone", async () => {
    const cookie = await unlock(LOCKED);
    const doc = await server().request(`/api/share/${LOCKED}/app/`, {
      headers: { Cookie: cookie },
    });
    expect(doc.status).toBe(200);
    expect(doc.headers.get("Content-Security-Policy")).toBe(SHARE_APP_SANDBOX);
    expect(doc.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await doc.text();
    const href = baseHref(html);
    expect(href).toMatch(
      new RegExp(`^/api/share/${LOCKED}/u/\\d+\\.[\\w-]+/$`),
    );
    // First thing in <head>, so it wins over anything the app declares.
    expect(html).toContain(`<head><base href="${href}">`);

    // What the opaque page sends: no cookie, Origin: null.
    for (const path of ["assets/app.js", "__data/rows.parquet"]) {
      const res = await server().request(`${href}${path}`, {
        headers: { Origin: "null" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
    // The old path without the cookie is what the page would hit without
    // the grant, and it is refused.
    const bare = await server().request(
      `/api/share/${LOCKED}/app/__data/rows.parquet`,
    );
    expect(bare.status).toBe(401);
  });

  it("scopes a grant to its own share and refuses forged or expired ones", async () => {
    const cookie = await unlock(LOCKED);
    const html = await (
      await server().request(`/api/share/${LOCKED}/app/`, {
        headers: { Cookie: cookie },
      })
    ).text();
    const grant = baseHref(html)?.split("/u/")[1]?.replace(/\/$/, "") ?? "";
    const [exp, sig] = grant.split(".");

    const on = (token: string, g: string) =>
      server().request(`/api/share/${token}/u/${g}/assets/app.js`);
    expect((await on(LOCKED, grant)).status).toBe(200);
    expect((await on(OTHER, grant)).status).toBe(401);
    expect((await on(LOCKED, `${Number(exp) + 1}.${sig}`)).status).toBe(401);
    expect((await on(LOCKED, `${exp}.${sig.slice(1)}`)).status).toBe(401);
    expect((await on(LOCKED, "garbage")).status).toBe(401);
    // The cookie value itself is not a grant (different signing purpose).
    const cookieValue = decodeURIComponent(cookie.split("=")[1] ?? "");
    expect((await on(LOCKED, cookieValue)).status).toBe(401);

    vi.useFakeTimers();
    vi.setSystemTime(Number(exp) + 1000);
    try {
      expect((await on(LOCKED, grant)).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refresh on the grant path follows the owner's live-query switch, without a cookie", async () => {
    const cookie = await unlock(LOCKED);
    const href = baseHref(
      await (
        await server().request(`/api/share/${LOCKED}/app/`, {
          headers: { Cookie: cookie },
        })
      ).text(),
    );
    const res = await server().request(`${href}__data/rows/refresh`, {
      method: "POST",
      headers: { Origin: "null" },
    });
    // Live queries are off on this share: authorized, then refused by the
    // switch. Readable by the opaque page either way.
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const forged = await server().request(
      `/api/share/${LOCKED}/u/1.x/__data/rows/refresh`,
      { method: "POST" },
    );
    expect(forged.status).toBe(401);
  });
});

// ── In a real browser (opt-in, headless) ─────────────────────────────────

const playwrightDir = process.env.SHARE_SANDBOX_PLAYWRIGHT;
const chromiumPath = process.env.CHROMIUM_PATH;

describe.skipIf(!playwrightDir || !chromiumPath)(
  "app code on a share page, in Chromium",
  () => {
    it("cannot read Mako's cookies or storage, nor call /api with the session", async () => {
      const require = createRequire(import.meta.url);
      const { chromium } = require(playwrightDir as string);
      const app = server();
      const listener = serve({ fetch: app.fetch, port: 0 });
      await new Promise(r => listener.once("listening", r));
      const port = (listener.address() as AddressInfo).port;
      const origin = `http://localhost:${port}`;
      const browser = await chromium.launch({
        headless: true,
        executablePath: chromiumPath,
      });
      try {
        const context = await browser.newContext();
        // A signed-in visitor: Mako's session cookie on Mako's origin.
        await context.addCookies([
          {
            name: "mako_session",
            value: "secret-session",
            url: origin,
            httpOnly: false,
            sameSite: "Lax",
          },
        ]);
        const page = await context.newPage();
        const reportOf = async (url: string) => {
          await page.goto(url);
          await page.waitForFunction(
            () => document.title.startsWith("report:"),
            null,
            { timeout: 15_000 },
          );
          return JSON.parse((await page.title()).slice("report:".length));
        };

        const open = await reportOf(`${origin}/api/share/${OPEN}/app/`);
        expect(open.origin).toBe("null");
        expect(open.cookie).toMatch(/^threw:/);
        expect(open.storage).toMatch(/^threw:/);
        // Either the cookie is withheld or the read is blocked: never SESSION.
        expect(open.api).not.toContain("SESSION");
        expect(open.data).toBe("200:PAR1");

        // Password share: unlock as the share page does, then load it.
        const unlocked = await page.request.post(
          `${origin}/api/share/${LOCKED}/unlock`,
          { data: { password: "pw" } },
        );
        expect(unlocked.status()).toBe(200);
        const locked = await reportOf(`${origin}/api/share/${LOCKED}/app/`);
        expect(locked.origin).toBe("null");
        expect(locked.cookie).toMatch(/^threw:/);
        expect(locked.api).not.toContain("SESSION");
        // Data through the grant, though the page sends no cookie.
        expect(locked.data).toBe("200:PAR1");
      } finally {
        await browser.close();
        listener.close();
      }
    }, 60_000);
  },
);

beforeEach(() => {
  vi.useRealTimers();
});
