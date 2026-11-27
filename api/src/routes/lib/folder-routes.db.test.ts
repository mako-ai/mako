/**
 * Notebook folder routes backed by PGlite. Exercise ownership, the
 * owner/admin/member ACL matrix, subtree delete with item unlinking, and
 * cycle-safe moves through the production registrar and notebook backend.
 *
 * Run: npx tsx src/routes/lib/folder-routes.db.test.ts
 */
import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";

import { sessionManager } from "../../auth/session";
import { generateObjectIdHex } from "../../database/pg/id-codec";
import { consolesChartsRepo } from "../../repositories/consoles-charts";
import {
  ensureTestMember,
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
} from "../../test-support/pg-test";
import { notebookRoutes } from "../notebooks";

const WS = generateObjectIdHex();
const base = `/api/workspaces/${WS}/notebooks`;
const app = new OpenAPIHono();
app.route("/api/workspaces/:workspaceId/notebooks", notebookRoutes);

async function asUser(userId: string) {
  const session = await sessionManager.createSession(userId);
  const { name, value } = sessionManager.createSessionCookie(session.id);
  return {
    request: (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", `${name}=${value}`);
      return app.request(path, { ...init, headers });
    },
  };
}

type Actor = Awaited<ReturnType<typeof asUser>>;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function createVia(
  app: Actor,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await app.request(`${base}/folders`, json("POST", body));
  assert.equal(res.status, 200);
  const parsed = (await res.json()) as { data: { id: string } };
  return parsed.data.id;
}

async function main(): Promise<void> {
  const h = await setupPgTestDb();
  try {
    await ensureTestWorkspace(h.db, { id: WS });
    const ownerUser = await ensureTestUser(h.db, { id: "owner-1" });
    const memberUser = await ensureTestUser(h.db, { id: "member-2" });
    const adminUser = await ensureTestUser(h.db, { id: "admin-3" });
    await ensureTestMember(h.db, { workspaceId: WS, userId: ownerUser.id });
    await ensureTestMember(h.db, { workspaceId: WS, userId: memberUser.id });
    await ensureTestMember(h.db, {
      workspaceId: WS,
      userId: adminUser.id,
      role: "admin",
    });
    const owner = await asUser(ownerUser.id);
    const member = await asUser(memberUser.id);
    const admin = await asUser(adminUser.id);
    const findFolder = (id: string) =>
      consolesChartsRepo.findNotebookFolderById(WS, id);

    // ── create persists ownership, access, and parent ──
    const privateId = await createVia(owner, { name: "Private stuff" });
    const workspaceId = await createVia(owner, {
      name: "Shared",
      access: "workspace",
    });
    const childId = await createVia(owner, {
      name: "Child",
      parentId: privateId,
    });
    {
      const doc = await findFolder(privateId);
      assert.equal(doc?.ownerId, ownerUser.id);
      assert.equal(doc?.access, "private");
      const child = await findFolder(childId);
      assert.equal(child?.parentId?.toString(), privateId);
    }

    // ── ACL matrix on rename ──
    const rename = (app: Actor, id: string, name: string) =>
      app.request(`${base}/folders/${id}/rename`, json("PATCH", { name }));

    assert.equal((await rename(owner, privateId, "Mine")).status, 200);
    // Non-owner member: 403 on a private folder.
    assert.equal((await rename(member, privateId, "Nope")).status, 403);
    // Admins do NOT reach others' private folders (privacy guarantee).
    assert.equal((await rename(admin, privateId, "Nope")).status, 403);
    // Workspace folder: plain members resolve to viewer — still 403 …
    assert.equal((await rename(member, workspaceId, "Nope")).status, 403);
    // … while admins are editors on workspace-visible resources.
    assert.equal((await rename(admin, workspaceId, "Team")).status, 200);
    assert.equal((await findFolder(workspaceId))?.name, "Team");

    // ── move: cycle rejected, reparent + access change applied ──
    const move = (app: Actor, id: string, body: unknown) =>
      app.request(`${base}/folders/${id}/move`, json("PATCH", body));

    const cycle = await move(owner, privateId, { parentId: childId });
    assert.equal(cycle.status, 400);
    assert.match(
      ((await cycle.json()) as { error: string }).error,
      /into itself/,
    );
    // Self-parenting is a cycle too.
    assert.equal(
      (await move(owner, privateId, { parentId: privateId })).status,
      400,
    );

    assert.equal(
      (await move(owner, childId, { parentId: null, access: "workspace" }))
        .status,
      200,
    );
    {
      const doc = await findFolder(childId);
      assert.equal(doc?.parentId ?? null, null);
      assert.equal(doc?.access, "workspace");
    }
    // Omitted parentId leaves the parent unchanged.
    assert.equal(
      (await move(owner, childId, { access: "private" })).status,
      200,
    );
    assert.equal((await findFolder(childId))?.parentId ?? null, null);
    // Unknown folder id (valid ObjectId) is a 404.
    assert.equal((await move(owner, generateObjectIdHex(), {})).status, 404);

    // ── delete: cascades descendants, unlinks items, keeps the items ──
    const top = await createVia(owner, { name: "Tree" });
    const mid = await createVia(owner, { name: "Mid", parentId: top });
    const leaf = await createVia(owner, { name: "Leaf", parentId: mid });
    const inLeaf = await consolesChartsRepo.createNotebookIndex({
      workspaceId: WS,
      notebookId: "nb-1",
      name: "Doc in leaf",
      ownerId: ownerUser.id,
      access: "private",
      folderId: leaf,
    });
    const elsewhere = await consolesChartsRepo.createNotebookIndex({
      workspaceId: WS,
      notebookId: "nb-2",
      name: "Unrelated",
      ownerId: ownerUser.id,
      access: "private",
      folderId: privateId,
    });

    assert.equal(
      (await member.request(`${base}/folders/${top}`, { method: "DELETE" }))
        .status,
      403,
    );
    assert.equal(
      (await owner.request(`${base}/folders/${top}`, { method: "DELETE" }))
        .status,
      200,
    );
    assert.equal(
      (await Promise.all([top, mid, leaf].map(findFolder))).filter(Boolean)
        .length,
      0,
    );
    const orphan = await consolesChartsRepo.findNotebookIndex(
      WS,
      inLeaf.notebookId,
    );
    assert.ok(orphan, "item under deleted folder must survive");
    assert.equal(orphan.folderId ?? null, null);
    assert.equal(
      (
        await consolesChartsRepo.findNotebookIndex(WS, elsewhere.notebookId)
      )?.folderId?.toString(),
      privateId,
      "items in other folders keep their folder",
    );

    // ── workspace scoping: another workspace's folder is invisible ──
    const other = await ensureTestWorkspace(h.db);
    const foreign = await consolesChartsRepo.createNotebookFolder({
      workspaceId: other.id,
      name: "Other tenant",
      ownerId: ownerUser.id,
      access: "private",
    });
    assert.equal((await rename(owner, foreign.id, "X")).status, 404);

    console.log("folder-routes db tests passed");
  } finally {
    await h.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
