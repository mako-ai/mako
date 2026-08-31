/**
 * registerVersionRoutes — the shared version-history route shell.
 *
 * Fake-backend coverage of the registrar: the three routes with a
 * configurable ref-param name (the path contract each kind already ships),
 * payload passthrough into the envelope, list-query parsing, restore body
 * passthrough, actor policy, and backend-outcome mapping. Kind semantics
 * (ACLs, snapshots) live with each backend and are covered by their suites.
 *
 * Run: npx tsx src/routes/lib/version-routes.test.ts
 */
import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";

import { createRouter } from "../../openapi/core";
import {
  registerVersionRoutes,
  type VersionBackend,
  type VersionRoutesConfig,
} from "./version-routes";
import type { ResourceOpResult } from "./resource-op";

const WS = "6846e6a01b05af0948070582";

interface Call {
  op: string;
  ctx: { workspaceId: string; userId: string; role: string | undefined };
  input: Record<string, unknown>;
}

function makeBackend(result: ResourceOpResult = { ok: true }): {
  backend: VersionBackend;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record =
    (op: string) =>
    async (
      ctx: Call["ctx"],
      input: Record<string, unknown>,
    ): Promise<ResourceOpResult> => {
      calls.push({ op, ctx, input });
      return result;
    };
  return {
    backend: {
      list: record("list"),
      get: record("get"),
      restore: record("restore"),
    },
    calls,
  };
}

let schemaCounter = 0;
function makeApp(
  config: Partial<VersionRoutesConfig> & { backend: VersionBackend },
): OpenAPIHono {
  const router = createRouter();
  router.use("*", async (c, next) => {
    c.set("user", { id: "u1" } as never);
    c.set("memberRole", "member" as never);
    await next();
  });
  registerVersionRoutes(router, {
    tag: "Test",
    schemaPrefix: `V${schemaCounter++}`,
    refParam: "version",
    ...config,
  });
  const app = new OpenAPIHono();
  app.route("/api/workspaces/:workspaceId/things", router);
  return app;
}

const base = `/api/workspaces/${WS}/things`;

async function main(): Promise<void> {
  // ── list: query parsing + payload spread into the envelope ──
  {
    const { backend, calls } = makeBackend({
      ok: true,
      payload: { versions: [{ version: 3 }], total: 1 },
    });
    const app = makeApp({ backend, listQuery: true });
    const res = await app.request(`${base}/abc/versions?limit=10&offset=20`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body, {
      success: true,
      versions: [{ version: 3 }],
      total: 1,
    });
    assert.deepEqual(calls[0], {
      op: "list",
      ctx: { workspaceId: WS, userId: "u1", role: "member" },
      input: { id: "abc", limit: 10, offset: 20 },
    });
    // Unparseable numbers arrive as undefined, not NaN.
    await app.request(`${base}/abc/versions?limit=nope`);
    assert.deepEqual(calls[1]?.input, {
      id: "abc",
      limit: undefined,
      offset: undefined,
    });
  }

  // ── refParam names the path segment (contract stability per kind) ──
  {
    const { backend, calls } = makeBackend({ ok: true, payload: { data: 1 } });
    const app = makeApp({ backend, refParam: "versionId" });
    const res = await app.request(`${base}/nb1/versions/gen-42`);
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0]?.input, { id: "nb1", ref: "gen-42" });
  }

  // ── restore: body passthrough; missing body tolerated ──
  {
    const { backend, calls } = makeBackend({ ok: true });
    const app = makeApp({ backend });
    const res = await app.request(`${base}/abc/versions/7/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comment: "back to 7" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls[0]?.input, {
      id: "abc",
      ref: "7",
      body: { comment: "back to 7" },
    });
    const bare = await app.request(`${base}/abc/versions/7/restore`, {
      method: "POST",
    });
    assert.equal(bare.status, 200);
    assert.deepEqual(calls[1]?.input, { id: "abc", ref: "7", body: {} });
  }

  // ── backend outcome maps onto the envelope ──
  {
    const { backend } = makeBackend({
      ok: false,
      status: 403,
      error: "You do not have write access",
    });
    const app = makeApp({ backend });
    const res = await app.request(`${base}/abc/versions/7/restore`, {
      method: "POST",
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      success: false,
      error: "You do not have write access",
    });
  }

  // ── actor policy: default requires a session user ──
  {
    const { backend, calls } = makeBackend();
    const router = createRouter();
    router.use("*", async (c, next) => {
      c.set("memberRole", "member" as never);
      await next();
    });
    registerVersionRoutes(router, {
      tag: "Test",
      schemaPrefix: `V${schemaCounter++}`,
      refParam: "version",
      backend,
    });
    const app = new OpenAPIHono();
    app.route("/api/workspaces/:workspaceId/things", router);
    const res = await app.request(`${base}/abc/versions`);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
  }

  console.log("version-routes tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
