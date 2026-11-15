/**
 * An API key acts only in the workspace it was minted for, and console reads
 * respect the console's own access.
 *
 * - favourites, notification-rules and realtime used to check only that the
 *   key's creator was a member of the URL's workspace, so a key minted in
 *   workspace B worked in workspace A whenever its creator belonged to both;
 * - console export and version-comment ran without the per-console read
 *   check that execute applies, so any member could export (or have
 *   summarised) a console that is private to someone else.
 *
 * Run: tsx src/routes/workspace-api-key-scope.db.test.ts
 */
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { OpenAPIHono } from "@hono/zod-openapi";

import { hashApiKey } from "../auth/api-key.middleware";
import { User } from "../database/schema";
import {
  ConsoleFolder,
  SavedConsole,
  Workspace,
  WorkspaceMember,
} from "../database/workspace-schema";
import { loggingMiddleware } from "../logging";
import { consoleRoutes } from "./consoles";
import { favouriteRoutes } from "./favourites";
import { notificationRulesRoutes } from "./notification-rules";
import { realtimeRoutes } from "./realtime";

const app = new OpenAPIHono();
app.use("*", loggingMiddleware({}));
app.route("/api/workspaces/:workspaceId/favourites", favouriteRoutes);
app.route(
  "/api/workspaces/:workspaceId/notification-rules",
  notificationRulesRoutes,
);
app.route("/api/workspaces/:workspaceId/realtime", realtimeRoutes);
app.route("/api/workspaces/:workspaceId/consoles", consoleRoutes);

const KEY_A_OWNER = "revops_scope_a_owner_tests_only";
const KEY_B_OWNER = "revops_scope_b_owner_tests_only";
const KEY_A_VIC = "revops_scope_a_vic_tests_only";

function apiKey(key: string, createdBy: string) {
  return {
    _id: new Types.ObjectId(),
    name: key,
    keyHash: hashApiKey(key),
    prefix: key.slice(0, 14),
    createdAt: new Date(),
    createdBy,
  };
}

async function main() {
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "mako" });
  try {
    const wsA = new Types.ObjectId();
    const wsB = new Types.ObjectId();
    await User.create({ _id: "owner", email: "owner@example.com" });
    await User.create({ _id: "vic", email: "vic@example.com" });
    // "owner" administers both workspaces; "vic" is a member of A only.
    for (const [workspaceId, userId, role] of [
      [wsA, "owner", "owner"],
      [wsB, "owner", "owner"],
      [wsA, "vic", "member"],
    ] as const) {
      await WorkspaceMember.create({
        workspaceId,
        userId,
        role,
        joinedAt: new Date(),
      });
    }
    for (const [ws, keys] of [
      [wsA, [apiKey(KEY_A_OWNER, "owner"), apiKey(KEY_A_VIC, "vic")]],
      [wsB, [apiKey(KEY_B_OWNER, "owner")]],
    ] as const) {
      await Workspace.collection.insertOne({
        _id: ws,
        name: String(ws),
        slug: `s-${ws}`,
        createdBy: "owner",
        settings: {},
        apiKeys: [...keys],
      });
    }

    const get = (key: string, path: string) =>
      app.request(path, { headers: { Authorization: `Bearer ${key}` } });

    // ── A key minted in B does not reach A, whoever created it ────────
    for (const path of [
      `/api/workspaces/${wsA}/favourites`,
      `/api/workspaces/${wsA}/notification-rules?resourceType=flow&resourceId=${new Types.ObjectId()}`,
      `/api/workspaces/${wsA}/realtime`,
    ]) {
      const res = await get(KEY_B_OWNER, path);
      assert.equal(res.status, 403, `B's key must be refused on ${path}`);
    }
    // A's own key still works on the same routes.
    const ownFavourites = await get(
      KEY_A_OWNER,
      `/api/workspaces/${wsA}/favourites`,
    );
    assert.equal(ownFavourites.status, 200);
    const ownRules = await get(
      KEY_A_OWNER,
      `/api/workspaces/${wsA}/notification-rules?resourceType=flow&resourceId=${new Types.ObjectId()}`,
    );
    assert.notEqual(ownRules.status, 403);

    // ── A console private to "owner" is not readable by "vic" ─────────
    // No connection on purpose: before the fix, export got past the
    // missing read check and answered 400 "no database connection".
    const privateConsole = await SavedConsole.create({
      workspaceId: wsA,
      name: "owner-only",
      code: "select 1",
      language: "sql",
      createdBy: "owner",
      access: "private",
    });
    const exportPath = `/api/workspaces/${wsA}/consoles/${privateConsole._id}/export?format=json`;
    const vicExport = await get(KEY_A_VIC, exportPath);
    assert.equal(vicExport.status, 404, "a private console is not exportable");
    const ownerExport = await get(KEY_A_OWNER, exportPath);
    assert.equal(ownerExport.status, 400, "the owner reaches the next check");

    const vicComment = await app.request(
      `/api/workspaces/${wsA}/consoles/${privateConsole._id}/version-comment`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY_A_VIC}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ newContent: "select 2" }),
      },
    );
    assert.equal(
      vicComment.status,
      404,
      "no version comment on a private console",
    );

    // A draft (never saved: no row) still gets a comment request through:
    // the read check applies only to a stored console. Generation itself
    // needs an AI gateway, so only "not refused as not-found" is asserted.
    const draftComment = await app.request(
      `/api/workspaces/${wsA}/consoles/${new Types.ObjectId()}/version-comment`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY_A_VIC}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ newContent: "select 3" }),
      },
    );
    assert.notEqual(draftComment.status, 404, "a draft is not refused");

    // ── Duplicate needs read access, restore needs write access ───────
    const post = (key: string, path: string, method = "POST") =>
      app.request(path, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
    const consolesBefore = await SavedConsole.countDocuments({});
    const vicDuplicate = await post(
      KEY_A_VIC,
      `/api/workspaces/${wsA}/consoles/${privateConsole._id}/duplicate`,
    );
    assert.equal(vicDuplicate.status, 404, "a private console is not copied");
    assert.equal(await SavedConsole.countDocuments({}), consolesBefore);

    await SavedConsole.updateOne(
      { _id: privateConsole._id },
      { $set: { is_deleted: true, deletedAt: new Date() } },
    );
    const restorePath = `/api/workspaces/${wsA}/consoles/${privateConsole._id}/restore`;
    const vicRestore = await post(KEY_A_VIC, restorePath, "PATCH");
    assert.equal(vicRestore.status, 404, "no restore without write access");
    assert.equal(
      (await SavedConsole.findById(privateConsole._id))?.is_deleted,
      true,
      "the console stays deleted",
    );
    const ownerRestore = await post(KEY_A_OWNER, restorePath, "PATCH");
    assert.equal(ownerRestore.status, 200, "the owner restores it");

    // ── Version comment honours folder inheritance, like export ───────
    const sharedFolder = await ConsoleFolder.create({
      workspaceId: wsA,
      name: "shared",
      access: "workspace",
      ownerId: "owner",
    });
    const inheritedConsole = await SavedConsole.create({
      workspaceId: wsA,
      folderId: sharedFolder._id,
      name: "inherits-workspace",
      code: "select 1",
      language: "sql",
      createdBy: "owner",
      access: "private",
    });
    const inheritedComment = await app.request(
      `/api/workspaces/${wsA}/consoles/${inheritedConsole._id}/version-comment`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY_A_VIC}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ newContent: "select 2" }),
      },
    );
    assert.notEqual(
      inheritedComment.status,
      404,
      "a console in a workspace folder is readable",
    );

    console.info("workspace api-key scope tests passed");
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
