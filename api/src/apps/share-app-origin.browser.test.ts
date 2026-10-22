/**
 * Share links in headless Chromium: bytes over the wire on a first and a
 * second visit, with per-app origins off (today: the share page navigates
 * to an opaque-origin document) and on (the share page frames the app's own
 * origin).
 *
 * Real code end to end: the share routes, the token route, the host gate,
 * deployment serving and parquet delivery. Faked: the artifact store (in
 * memory, signing like GCS V2 with a fixed Expires), a GCS stand-in that
 * answers like a signed read of a private object (`private, max-age=0` +
 * ETag), a jsDelivr stand-in for the DuckDB WASM, and the share page itself
 * (a few lines doing what PublicSharePage does; its React half is covered
 * by PublicSharePage.test.tsx).
 *
 * Opt-in and headless only:
 *   SHARE_ORIGIN_PLAYWRIGHT=<playwright-core dir> CHROMIUM_PATH=<chrome> \
 *     pnpm --filter api exec vitest run --config vitest.apps.config.ts \
 *     src/apps/share-app-origin.browser.test.ts
 */
import { createRequire } from "node:module";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { describe, expect, it, vi } from "vitest";

const objects = vi.hoisted(() => new Map<string, Buffer>());
const bucket = vi.hoisted(() => ({ origin: "" }));

vi.mock("../services/artifact-store.service", async importOriginal => {
  const real =
    await importOriginal<typeof import("../services/artifact-store.service")>();
  const store = {
    type: "gcs" as const,
    ensureBrowserCors: async () => true,
    exists: async (key: string) => objects.has(key),
    getSize: async (key: string) => objects.get(key)?.length ?? null,
    openReadStream: async (key: string) => {
      const body = objects.get(key);
      return body ? Readable.from([body]) : null;
    },
    openRead: async (key: string) => {
      const body = objects.get(key);
      return body ? { stream: Readable.from([body]), size: body.length } : null;
    },
    // Like a V2 signature: a fixed Expires gives a fixed URL.
    getSignedUrl: async (
      key: string,
      ttl = 600,
      window?: { expiresAt: Date },
    ) => {
      const expires = window
        ? window.expiresAt.getTime()
        : Date.now() + ttl * 1000;
      return `${bucket.origin}/${encodeURIComponent(key)}?Expires=${expires}&Signature=${crypto
        .createHash("sha256")
        .update(`${key}:${expires}`)
        .digest("hex")
        .slice(0, 16)}`;
    },
    put: async () => undefined,
    putBuffer: async () => undefined,
  };
  return {
    ...real,
    getArtifactStore: () => store,
    getArtifactSourceStore: () => null,
  };
});

import { appsHostGate } from "../middleware/apps-host-gate";
import { appsPreviewRoutes } from "../routes/apps-preview";
import { publicShareRoutes } from "../routes/public-share";
import { AppProject } from "../database/workspace-schema";
import { DEPLOYMENT_BINDING_INDEX, deploymentKey } from "./deployment.service";

const playwrightDir = process.env.SHARE_ORIGIN_PLAYWRIGHT;
const chromiumPath = process.env.CHROMIUM_PATH;

const SHA = "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b";
const SHARE = "bench-share";
const WASM = crypto.randomBytes(6 * 1024 * 1024);
const PARQUET = {
  a: crypto.randomBytes(3 * 1024 * 1024),
  b: crypto.randomBytes(3 * 1024 * 1024),
};

// What PublicSharePage does with /content (app/src/pages/PublicSharePage.tsx
// and app/src/lib/app-frame.ts), as plain script.
const SHARE_PAGE = (token: string) => `<!doctype html><title>share</title>
<body style="margin:0"><script>
addEventListener("message", e => {
  if (e.data && e.data.done) document.title = "done:" + e.data.report;
});
fetch("/api/share/${token}/content", { credentials: "include" })
  .then(r => r.json())
  .then(({ data }) => {
    if (!data.appUrl) return location.replace(data.entry);
    const f = document.createElement("iframe");
    const foreign = new URL(data.appUrl, location.href).origin !== location.origin;
    f.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" + (foreign ? " allow-same-origin" : ""));
    f.src = data.appUrl;
    f.style.cssText = "border:0;width:100vw;height:100vh";
    document.body.appendChild(f);
  });
</script>`;

function appJs(cdn: string, mako: string) {
  return `/*${"x".repeat(200 * 1024)}*/
const sizes = [];
const wasm = await fetch("${cdn}/duckdb-eh.wasm");
sizes.push((await wasm.arrayBuffer()).byteLength);
for (const n of ["a", "b"]) {
  const r = await fetch("__data/" + n + ".parquet");
  sizes.push((await r.arrayBuffer()).byteLength);
}
let api = "none";
try {
  const r = await fetch("${mako}/api/me", { credentials: "include" });
  api = await r.text();
} catch (e) { api = "blocked"; }
let cookie;
try { cookie = document.cookie; } catch (e) { cookie = "threw"; }
const report = JSON.stringify({ sizes, api, cookie, origin: self.origin });
if (parent !== window) parent.postMessage({ done: true, report }, "*");
else document.title = "done:" + report;
`;
}

describe.skipIf(!playwrightDir || !chromiumPath)(
  "share links in Chromium (headless)",
  () => {
    it("a second visit re-downloads everything today and nothing on the app's own origin", async () => {
      const mongo = await MongoMemoryServer.create();
      await mongoose.connect(mongo.getUri());
      const stats = {
        bytes: 0,
        requests: 0,
        notModified: 0,
        leaks: [] as string[],
      };
      const app = new Hono();
      let port = 0;
      const host = (name: string) => `${name}:${port}`;

      // Byte counter, outermost.
      app.use("*", async (c, next) => {
        await next();
        stats.requests += 1;
        if (c.res.status === 304) stats.notModified += 1;
        if (c.res.body) {
          const copy = c.res.clone();
          stats.bytes += (await copy.arrayBuffer()).byteLength;
        }
      });
      // Stand-ins on their own hosts.
      app.use("*", async (c, next) => {
        const h = c.req.header("host");
        if (h === host("cdn.jsdelivr.test")) {
          return new Response(new Uint8Array(WASM), {
            headers: {
              "Content-Type": "application/wasm",
              "Cache-Control": "public, max-age=31536000, immutable",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
        if (h === host("bucket.gcs.test")) {
          const name = /\/(a|b)\.parquet/.exec(
            decodeURIComponent(c.req.path),
          )?.[1] as "a" | "b" | undefined;
          if (!name) return c.text("nope", 404);
          const headers = {
            "Cache-Control": "private, max-age=0",
            ETag: `"${name}-v1"`,
            "Access-Control-Allow-Origin": "*",
            Vary: "Origin",
          };
          if (c.req.header("if-none-match") === headers.ETag) {
            return new Response(null, { status: 304, headers });
          }
          return new Response(new Uint8Array(PARQUET[name]), { headers });
        }
        return next();
      });
      app.use("*", appsHostGate);
      app.use("*", secureHeaders({ xFrameOptions: "SAMEORIGIN" }));
      app.get("/api/me", c => {
        const cookie = c.req.header("cookie") ?? "";
        if (cookie.includes("mako_session")) {
          stats.leaks.push(`${c.req.header("origin")} -> /api/me`);
        }
        return c.text(
          cookie.includes("mako_session") ? "SESSION" : "anon",
          200,
          {
            "Access-Control-Allow-Origin": c.req.header("origin") ?? "*",
            "Access-Control-Allow-Credentials": "true",
          },
        );
      });
      app.get("/share/:token", c =>
        c.html(SHARE_PAGE(c.req.param("token")), 200, {
          "Cache-Control": "no-store",
        }),
      );
      app.route("/api/share", publicShareRoutes);
      app.route("/api/apps-preview", appsPreviewRoutes);

      const listener = serve({ fetch: app.fetch, port: 0 });
      await new Promise(r => listener.once("listening", r));
      port = (listener.address() as AddressInfo).port;
      const mako = `http://${host("app.mako.test")}`;
      bucket.origin = `http://${host("bucket.gcs.test")}`;
      vi.stubEnv("SESSION_SECRET", "share-origin-bench-secret");
      vi.stubEnv("CLIENT_URL", mako);

      const project = await AppProject.create({
        workspaceId: new Types.ObjectId(),
        access: "workspace",
        owner_id: "owner",
        createdBy: "owner",
        title: "Bench",
        slug: "bench",
        publishedSha: SHA,
        publicShare: { enabled: true, token: SHARE },
      });
      const id = project._id.toString();
      const html = `<!doctype html><html><head><script type="module" crossorigin src="./assets/app.js"></script></head><body></body></html>`;
      objects.set(deploymentKey(id, SHA, "index.html"), Buffer.from(html));
      objects.set(
        deploymentKey(id, SHA, "assets/app.js"),
        Buffer.from(appJs(`http://${host("cdn.jsdelivr.test")}`, mako)),
      );
      objects.set(
        deploymentKey(id, SHA, DEPLOYMENT_BINDING_INDEX),
        Buffer.from(
          JSON.stringify({ a: "bindings/a.parquet", b: "bindings/b.parquet" }),
        ),
      );
      objects.set("bindings/a.parquet", PARQUET.a);
      objects.set("bindings/b.parquet", PARQUET.b);

      const require = createRequire(import.meta.url);
      const { chromium } = require(playwrightDir as string);
      const browser = await chromium.launch({
        headless: true,
        executablePath: chromiumPath,
        args: ["--host-resolver-rules=MAP *.test 127.0.0.1"],
      });
      const runs: Record<string, Array<Record<string, unknown>>> = {};
      try {
        for (const mode of ["off", "on"] as const) {
          vi.stubEnv(
            "APPS_ORIGIN_BASE",
            mode === "on" ? `http://${host("makoapps.test")}` : "",
          );
          const context = await browser.newContext();
          // A signed-in visitor: Mako's session cookie on Mako's origin.
          await context.addCookies([
            {
              name: "mako_session",
              value: "secret-session",
              url: mako,
              sameSite: "Lax",
            },
          ]);
          const page = await context.newPage();
          runs[mode] = [];
          for (let load = 1; load <= 2; load++) {
            stats.bytes = 0;
            stats.requests = 0;
            stats.notModified = 0;
            stats.leaks = [];
            await page.goto(`${mako}/share/${SHARE}`);
            await page.waitForFunction(
              () => document.title.startsWith("done:"),
              null,
              { timeout: 30_000 },
            );
            const report = JSON.parse((await page.title()).slice(5));
            runs[mode].push({
              load,
              mib: +(stats.bytes / 1048576).toFixed(2),
              requests: stats.requests,
              notModified: stats.notModified,
              leaks: [...stats.leaks],
              url: page.url(),
              ...report,
            });
          }
          await context.close();
        }
      } finally {
        await browser.close();
        listener.close();
        await mongoose.disconnect();
        await mongo.stop();
      }
      console.info(JSON.stringify(runs, null, 2));

      const [off1, off2] = runs.off;
      const [on1, on2] = runs.on;
      // Every load got its data, in both modes.
      for (const run of [off1, off2, on1, on2]) {
        expect(run.sizes).toEqual([
          WASM.length,
          PARQUET.a.length,
          PARQUET.b.length,
        ]);
        expect(run.leaks).toEqual([]);
        expect(run.api).not.toContain("SESSION");
      }
      // Off: the visitor lands on the opaque-origin document.
      expect(off1.origin).toBe("null");
      expect(String(off2.url)).toContain(`/api/share/${SHARE}/app/`);
      // On: the visitor stays on the share URL; the app has its own origin.
      expect(on1.origin).toBe(`http://${id}.${host("makoapps.test")}`);
      expect(String(on2.url)).toBe(`${mako}/share/${SHARE}`);
      expect(on1.cookie).toBe("");
      // The point: the second visit is (almost) free on the app's origin.
      expect(Number(on2.mib)).toBeLessThan(0.05);
      expect(Number(off2.mib)).toBeGreaterThan(Number(on2.mib));
    }, 120_000);
  },
);
