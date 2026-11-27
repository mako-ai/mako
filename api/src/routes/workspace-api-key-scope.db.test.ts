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
 * Runs on PGlite (users, workspaces, API keys, consoles all live in Postgres).
 *
 * Run: tsx src/routes/workspace-api-key-scope.db.test.ts
 */
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { OpenAPIHono } from "@hono/zod-openapi";

import { hashApiKey } from "../auth/api-key.middleware";
import { loggingMiddleware } from "../logging";
import { consolesChartsRepo } from "../repositories/consoles-charts";
import { workspaceRepo } from "../repositories/workspaces";
import {
  ensureTestMember,
  ensureTestUser,
  ensureTestWorkspace,
  setupPgTestDb,
} from "../test-support/pg-test";
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

function apiKey(workspaceId: string, key: string, createdBy: string) {
  return workspaceRepo.createApiKey({
    workspaceId,
    name: key,
    keyHash: hashApiKey(key),
    prefix: key.slice(0, 14),
    createdAt: new Date(),
    createdBy,
  });
}

async function main() {
  process.env.ENCRYPTION_KEY ??= "0".repeat(64);
  const pgh = await setupPgTestDb();
  try {
    const wsA = (await ensureTestWorkspace(pgh.db)).id;
    const wsB = (await ensureTestWorkspace(pgh.db)).id;
    await ensureTestUser(pgh.db, { id: "owner", email: "owner@example.com" });
    await ensureTestUser(pgh.db, { id: "vic", email: "vic@example.com" });
    // "owner" administers both workspaces; "vic" is a member of A only.
    for (const [workspaceId, userId, role] of [
      [wsA, "owner", "owner"],
      [wsB, "owner", "owner"],
      [wsA, "vic", "member"],
    ] as const) {
      await ensureTestMember(pgh.db, { workspaceId, userId, role });
    }
    await apiKey(wsA, KEY_A_OWNER, "owner");
    await apiKey(wsA, KEY_A_VIC, "vic");
    await apiKey(wsB, KEY_B_OWNER, "owner");

    const get = (key: string, path: string) =>
      app.request(path, { headers: { Authorization: `Bearer ${key}` } });

    // ── A key minted in B does not reach A, whoever created it ────────
    // A missing scheduled query exercises the resource check behind the
    // notification route's workspace gate using the same PGlite database.
    const rulesPath = `/api/workspaces/${wsA}/notification-rules?resourceType=scheduled_query&resourceId=${new Types.ObjectId()}`;
    for (const path of [
      `/api/workspaces/${wsA}/favourites`,
      rulesPath,
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
    const ownRules = await get(KEY_A_OWNER, rulesPath);
    assert.equal(ownRules.status, 404);
    assert.deepEqual(await ownRules.json(), {
      success: false,
      error: "Resource not found",
    });

    // ── A console private to "owner" is not readable by "vic" ─────────
    // No connection on purpose: before the fix, export got past the
    // missing read check and answered 400 "no database connection".
    const privateConsole = await consolesChartsRepo.createConsole({
      workspaceId: wsA,
      name: "owner-only",
      code: "select 1",
      language: "sql",
      createdBy: "owner",
      access: "private",
    });
    const exportPath = `/api/workspaces/${wsA}/consoles/${privateConsole.id}/export?format=json`;
    const vicExport = await get(KEY_A_VIC, exportPath);
    assert.equal(vicExport.status, 404, "a private console is not exportable");
    const ownerExport = await get(KEY_A_OWNER, exportPath);
    assert.equal(ownerExport.status, 400, "the owner reaches the next check");

    const vicComment = await app.request(
      `/api/workspaces/${wsA}/consoles/${privateConsole.id}/version-comment`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY_A_VIC}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ newContent: "" }),
      },
    );
    assert.equal(
      vicComment.status,
      404,
      "no version comment on a private console",
    );

    // An empty diff lets an authorized request finish without an AI call.
    const draftComment = await app.request(
      `/api/workspaces/${wsA}/consoles/${new Types.ObjectId()}/version-comment`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY_A_VIC}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ newContent: "" }),
      },
    );
    assert.equal(draftComment.status, 200, "a draft is readable");

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
    const countConsoles = async () =>
      (await consolesChartsRepo.listConsolesByWorkspace(wsA)).length;
    const consolesBefore = await countConsoles();
    const vicDuplicate = await post(
      KEY_A_VIC,
      `/api/workspaces/${wsA}/consoles/${privateConsole.id}/duplicate`,
    );
    assert.equal(vicDuplicate.status, 404, "a private console is not copied");
    assert.equal(await countConsoles(), consolesBefore);

    await consolesChartsRepo.updateConsole(wsA, privateConsole.id, {
      is_deleted: true,
      deletedAt: new Date(),
    });
    const restorePath = `/api/workspaces/${wsA}/consoles/${privateConsole.id}/restore`;
    const vicRestore = await post(KEY_A_VIC, restorePath, "PATCH");
    assert.equal(vicRestore.status, 404, "no restore without write access");
    assert.equal(
      (await consolesChartsRepo.findConsoleById(wsA, privateConsole.id))
        ?.is_deleted,
      true,
      "the console stays deleted",
    );
    const ownerRestore = await post(KEY_A_OWNER, restorePath, "PATCH");
    assert.equal(ownerRestore.status, 200, "the owner restores it");

    // ── Version comment honours folder inheritance, like export ───────
    const sharedFolder = await consolesChartsRepo.createConsoleFolder({
      workspaceId: wsA,
      name: "shared",
      access: "workspace",
      ownerId: "owner",
    });
    const inheritedConsole = await consolesChartsRepo.createConsole({
      workspaceId: wsA,
      folderId: sharedFolder.id,
      name: "inherits-workspace",
      code: "select 1",
      language: "sql",
      createdBy: "owner",
      access: "private",
    });
    const inheritedComment = await app.request(
      `/api/workspaces/${wsA}/consoles/${inheritedConsole.id}/version-comment`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY_A_VIC}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ newContent: "" }),
      },
    );
    assert.equal(
      inheritedComment.status,
      200,
      "a console in a workspace folder is readable",
    );

    console.info("workspace api-key scope tests passed");
  } finally {
    await pgh.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
