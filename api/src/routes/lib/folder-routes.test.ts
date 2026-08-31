/**
 * registerFolderRoutes — the shared folder CRUD/move route shell.
 *
 * Exercises the registrar with an in-memory backend: request validation,
 * the success/error envelope, actor policy, per-kind error mapping, the
 * created status override, and the afterChange hook. Backend semantics
 * (ACLs, cascades) live with each kind and are not under test here.
 *
 * Run: npx tsx src/routes/lib/folder-routes.test.ts
 */
import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";

import { createRouter } from "../../openapi/core";
import {
  registerFolderRoutes,
  type FolderBackend,
  type FolderOpResult,
  type FolderRoutesConfig,
} from "./folder-routes";

const WS = "6846e6a01b05af0948070582";
const FOLDER = "68b0c0ffee0000000000abcd";
const OTHER = "68b0c0ffee0000000000dcba";

interface Call {
  op: string;
  ctx: { workspaceId: string; userId: string; role: string | undefined };
  input: Record<string, unknown>;
}

function makeBackend(
  result: FolderOpResult | (() => FolderOpResult) = { ok: true },
): { backend: FolderBackend; calls: Call[] } {
  const calls: Call[] = [];
  const answer = () => (typeof result === "function" ? result() : result);
  const record =
    (op: string) =>
    async (
      ctx: Call["ctx"],
      input: Record<string, unknown>,
    ): Promise<FolderOpResult> => {
      calls.push({ op, ctx, input });
      return answer();
    };
  return {
    backend: {
      createFolder: record("createFolder"),
      renameFolder: record("renameFolder"),
      deleteFolder: record("deleteFolder"),
      moveFolder: record("moveFolder"),
      moveItem: record("moveItem"),
    },
    calls,
  };
}

function makeApp(
  config: Omit<FolderRoutesConfig, "tag" | "schemaPrefix"> & {
    schemaPrefix?: string;
    user?: { id: string } | null;
    role?: string;
  },
): OpenAPIHono {
  const router = createRouter();
  router.use("*", async (c, next) => {
    if (config.user !== null) {
      c.set("user", (config.user ?? { id: "u1" }) as never);
    }
    c.set("memberRole", (config.role ?? "member") as never);
    await next();
  });
  registerFolderRoutes(router, {
    tag: "Test",
    // Schema names are registered globally; default to a unique prefix per
    // app so repeated makeApp() calls don't collide.
    schemaPrefix: config.schemaPrefix ?? `T${schemaCounter++}`,
    ...config,
  });
  const app = new OpenAPIHono();
  app.route("/api/workspaces/:workspaceId/things", router);
  return app;
}
let schemaCounter = 0;

const base = `/api/workspaces/${WS}/things`;

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const patch = (body: unknown): RequestInit => ({
  ...json(body),
  method: "PATCH",
});

async function expectJson(
  res: Response,
  status: number,
  like: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assert.equal(res.status, status);
  const body = (await res.json()) as Record<string, unknown>;
  for (const [k, v] of Object.entries(like)) {
    assert.deepEqual(body[k], v, `${k} in ${JSON.stringify(body)}`);
  }
  return body;
}

async function main(): Promise<void> {
  // ── create: happy path carries ctx + trimmed input to the backend ──
  {
    const { backend, calls } = makeBackend({
      ok: true,
      data: { id: FOLDER, name: "Reports" },
    });
    const app = makeApp({ backend, role: "admin" });
    const res = await app.request(
      `${base}/folders`,
      json({ name: "  Reports  ", parentId: OTHER, access: "workspace" }),
    );
    await expectJson(res, 200, {
      success: true,
      data: { id: FOLDER, name: "Reports" },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      op: "createFolder",
      ctx: { workspaceId: WS, userId: "u1", role: "admin" },
      input: { name: "Reports", parentId: OTHER, access: "workspace" },
    });
  }

  // ── create: missing/blank name is a 400 before the backend runs.
  // ({} and a non-string name are rejected by the schema hook; a blank
  // name passes the schema and is caught by the handler.) ──
  for (const body of [{}, { name: "  " }, { name: 42 }]) {
    const { backend, calls } = makeBackend();
    const app = makeApp({ backend });
    const res = await app.request(`${base}/folders`, json(body));
    await expectJson(res, 400, { success: false });
    assert.equal(calls.length, 0);
  }

  // ── create: malformed parentId is a 400 ──
  {
    const { backend, calls } = makeBackend();
    const app = makeApp({ backend });
    const res = await app.request(
      `${base}/folders`,
      json({ name: "x", parentId: "not-an-oid" }),
    );
    await expectJson(res, 400, { success: false, error: "Invalid parentId" });
    assert.equal(calls.length, 0);
  }

  // ── create: createdStatus override (consoles return 201) ──
  {
    const { backend } = makeBackend({ ok: true, data: { id: FOLDER } });
    const app = makeApp({ backend, createdStatus: 201 });
    const res = await app.request(`${base}/folders`, json({ name: "x" }));
    await expectJson(res, 201, { success: true });
  }

  // ── actor policy: no user is 401 unless allow-system ──
  {
    const { backend, calls } = makeBackend();
    const app = makeApp({ backend, user: null });
    const res = await app.request(`${base}/folders`, json({ name: "x" }));
    await expectJson(res, 401, { success: false, error: "Unauthorized" });
    assert.equal(calls.length, 0);
  }
  {
    const { backend, calls } = makeBackend({ ok: true });
    const app = makeApp({ backend, user: null, actor: "allow-system" });
    const res = await app.request(`${base}/folders`, json({ name: "x" }));
    await expectJson(res, 200, { success: true });
    assert.equal(calls[0]?.ctx.userId, "system");
  }

  // ── rename: bad folder id in the path is 404, blank name 400 ──
  {
    const { backend, calls } = makeBackend();
    const app = makeApp({ backend });
    const bad = await app.request(
      `${base}/folders/nope/rename`,
      patch({ name: "y" }),
    );
    await expectJson(bad, 404, { success: false, error: "Folder not found" });
    const blank = await app.request(
      `${base}/folders/${FOLDER}/rename`,
      patch({ name: "  " }),
    );
    await expectJson(blank, 400, {
      success: false,
      error: "Folder name is required",
    });
    assert.equal(calls.length, 0);
  }

  // ── rename/delete/move: backend outcome maps onto the envelope ──
  {
    const { backend } = makeBackend({
      ok: false,
      status: 403,
      error: "Access denied",
    });
    const app = makeApp({ backend });
    for (const [path, init] of [
      [`${base}/folders/${FOLDER}/rename`, patch({ name: "y" })],
      [`${base}/folders/${FOLDER}`, { method: "DELETE" }],
      [`${base}/folders/${FOLDER}/move`, patch({ parentId: null })],
      [`${base}/${FOLDER}/move`, patch({ folderId: null })],
    ] as const) {
      const res = await app.request(path, init as RequestInit);
      await expectJson(res, 403, { success: false, error: "Access denied" });
    }
  }

  // ── move folder: malformed parentId 400; null/omitted pass through ──
  {
    const { backend, calls } = makeBackend({ ok: true });
    const app = makeApp({ backend });
    const bad = await app.request(
      `${base}/folders/${FOLDER}/move`,
      patch({ parentId: "nope" }),
    );
    await expectJson(bad, 400, { success: false, error: "Invalid parentId" });
    assert.equal(calls.length, 0);

    await app.request(`${base}/folders/${FOLDER}/move`, patch({}));
    assert.deepEqual(calls[0]?.input, {
      folderId: FOLDER,
      parentId: undefined,
      access: undefined,
    });
    await app.request(
      `${base}/folders/${FOLDER}/move`,
      patch({ parentId: null, access: "private" }),
    );
    assert.deepEqual(calls[1]?.input, {
      folderId: FOLDER,
      parentId: null,
      access: "private",
    });
  }

  // ── move item: malformed folderId 400; a missing body is tolerated ──
  {
    const { backend, calls } = makeBackend({ ok: true });
    const app = makeApp({ backend });
    const bad = await app.request(
      `${base}/${FOLDER}/move`,
      patch({ folderId: "nope" }),
    );
    await expectJson(bad, 400, { success: false, error: "Invalid folderId" });
    assert.equal(calls.length, 0);

    const res = await app.request(`${base}/${FOLDER}/move`, {
      method: "PATCH",
    });
    await expectJson(res, 200, { success: true });
    assert.deepEqual(calls[0]?.input, {
      itemId: FOLDER,
      folderId: undefined,
      access: undefined,
    });
  }

  // ── afterChange fires only on success ──
  {
    const seen: string[] = [];
    let fail = false;
    const { backend } = makeBackend(() =>
      fail
        ? { ok: false, status: 404, error: "Folder not found" }
        : { ok: true },
    );
    const app = makeApp({ backend, afterChange: ws => seen.push(ws) });
    await app.request(`${base}/folders`, json({ name: "x" }));
    assert.deepEqual(seen, [WS]);
    fail = true;
    await app.request(`${base}/folders`, json({ name: "x" }));
    assert.deepEqual(seen, [WS]);
  }

  // ── thrown errors: onError can map them; otherwise a 500 envelope ──
  {
    class KindError extends Error {}
    const backend = makeBackend().backend;
    backend.deleteFolder = async () => {
      throw new KindError("repo required");
    };
    const mapped = makeApp({
      backend,
      onError: (c, error) =>
        error instanceof KindError
          ? c.json({ success: false, error: "mapped" }, 409)
          : undefined,
    });
    const res = await mapped.request(`${base}/folders/${FOLDER}`, {
      method: "DELETE",
    });
    await expectJson(res, 409, { success: false, error: "mapped" });

    const unmapped = makeApp({ backend });
    const res2 = await unmapped.request(`${base}/folders/${FOLDER}`, {
      method: "DELETE",
    });
    await expectJson(res2, 500, { success: false, error: "repo required" });
  }

  console.log("folder-routes tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
