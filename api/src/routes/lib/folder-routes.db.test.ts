/**
 * createModelFolderBackend against real Mongoose models (in-memory Mongo).
 *
 * The registrar's shell has its own test (folder-routes.test.ts, fake
 * backend); this one proves the model-backed backend's semantics with the
 * real NotebookFolder/NotebookIndex models behind the real routes: the
 * canWriteResource ACL matrix (owner / admin / member, private / workspace
 * — including the "admins cannot touch others' private folders" privacy
 * guarantee), cascade delete with item unlinking, and cycle-safe moves.
 *
 * Run: npx tsx src/routes/lib/folder-routes.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { OpenAPIHono } from "@hono/zod-openapi";

import { NotebookFolder, NotebookIndex } from "../../database/workspace-schema";
import { createRouter } from "../../openapi/core";
import {
  createModelFolderBackend,
  registerFolderRoutes,
} from "./folder-routes";

const WS = new Types.ObjectId();
const base = `/api/workspaces/${WS.toString()}/things`;

function makeApp(user: { id: string }, role: string): OpenAPIHono {
  const router = createRouter();
  router.use("*", async (c, next) => {
    c.set("user", user as never);
    c.set("memberRole", role as never);
    await next();
  });
  registerFolderRoutes(router, {
    tag: "Test",
    schemaPrefix: `Db${schemaCounter++}`,
    backend: createModelFolderBackend({
      folderModel: NotebookFolder,
      itemModel: NotebookIndex,
      moveItem: async () => ({ ok: true }),
    }),
  });
  const app = new OpenAPIHono();
  app.route("/api/workspaces/:workspaceId/things", router);
  return app;
}
let schemaCounter = 0;

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function createVia(
  app: OpenAPIHono,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await app.request(`${base}/folders`, json("POST", body));
  assert.equal(res.status, 200);
  const parsed = (await res.json()) as { data: { id: string } };
  return parsed.data.id;
}

async function main(): Promise<void> {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const owner = makeApp({ id: "owner-1" }, "member");
  const member = makeApp({ id: "member-2" }, "member");
  const admin = makeApp({ id: "admin-3" }, "admin");

  try {
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
      const doc = await NotebookFolder.findById(privateId).lean();
      assert.equal(doc?.ownerId, "owner-1");
      assert.equal(doc?.access, "private");
      const child = await NotebookFolder.findById(childId).lean();
      assert.equal(child?.parentId?.toString(), privateId);
    }

    // ── ACL matrix on rename ──
    const rename = (app: OpenAPIHono, id: string, name: string) =>
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
    assert.equal(
      (await NotebookFolder.findById(workspaceId).lean())?.name,
      "Team",
    );

    // ── move: cycle rejected, reparent + access change applied ──
    const move = (app: OpenAPIHono, id: string, body: unknown) =>
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
      const doc = await NotebookFolder.findById(childId).lean();
      assert.equal(doc?.parentId ?? null, null);
      assert.equal(doc?.access, "workspace");
    }
    // Omitted parentId leaves the parent unchanged.
    assert.equal(
      (await move(owner, childId, { access: "private" })).status,
      200,
    );
    assert.equal(
      (await NotebookFolder.findById(childId).lean())?.parentId ?? null,
      null,
    );
    // Unknown folder id (valid ObjectId) is a 404.
    assert.equal(
      (await move(owner, new Types.ObjectId().toString(), {})).status,
      404,
    );

    // ── delete: cascades descendants, unlinks items, keeps the items ──
    const top = await createVia(owner, { name: "Tree" });
    const mid = await createVia(owner, { name: "Mid", parentId: top });
    const leaf = await createVia(owner, { name: "Leaf", parentId: mid });
    const inLeaf = await NotebookIndex.create({
      workspaceId: WS,
      notebookId: "nb-1",
      name: "Doc in leaf",
      ownerId: "owner-1",
      access: "private",
      folderId: new Types.ObjectId(leaf),
    });
    const elsewhere = await NotebookIndex.create({
      workspaceId: WS,
      notebookId: "nb-2",
      name: "Unrelated",
      ownerId: "owner-1",
      access: "private",
      folderId: new Types.ObjectId(privateId),
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
      await NotebookFolder.countDocuments({ _id: { $in: [top, mid, leaf] } }),
      0,
    );
    const orphan = await NotebookIndex.findById(inLeaf._id).lean();
    assert.ok(orphan, "item under deleted folder must survive");
    assert.equal(orphan.folderId ?? null, null);
    assert.equal(
      (
        await NotebookIndex.findById(elsewhere._id).lean()
      )?.folderId?.toString(),
      privateId,
      "items in other folders keep their folder",
    );

    // ── workspace scoping: another workspace's folder is invisible ──
    const foreign = await NotebookFolder.create({
      workspaceId: new Types.ObjectId(),
      name: "Other tenant",
      ownerId: "owner-1",
      access: "private",
    });
    assert.equal(
      (await rename(owner, foreign._id.toString(), "X")).status,
      404,
    );

    console.log("folder-routes db tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
