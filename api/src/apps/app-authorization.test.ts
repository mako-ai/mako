/**
 * One rule set for filing apps, shared by the routes, the agent tools and
 * the connector — so an actor one door refuses cannot walk through another.
 *
 * Run: npx tsx src/apps/app-authorization.test.ts
 */
import assert from "node:assert/strict";
import {
  authorizeAppMove,
  authorizeFolderTarget,
  canOrganizeWorkspaceTree,
  canWriteApp,
} from "./app-authorization";
import type { AppFolderTarget } from "./worktree.service";

const workspace = (): AppFolderTarget => ({
  scope: "workspace",
  folderSegments: ["Sales"],
});
const personal = (ownerId?: string): AppFolderTarget => ({
  scope: "private",
  ownerId,
  folderSegments: [],
});

// Editing members organise the workspace tree; nobody else does — including
// an actor with NO role (an API key whose creator left the workspace), who
// used to slip past a `role === "viewer"` check.
assert.equal(canOrganizeWorkspaceTree("owner"), true);
assert.equal(canOrganizeWorkspaceTree("member"), true);
assert.equal(canOrganizeWorkspaceTree("viewer"), false);
assert.equal(canOrganizeWorkspaceTree(undefined), false);
assert.equal(authorizeFolderTarget(workspace(), "u1", "member"), null);
assert.match(
  authorizeFolderTarget(workspace(), "u1", "viewer") ?? "",
  /editors/,
);
assert.match(
  authorizeFolderTarget(workspace(), undefined, undefined) ?? "",
  /editors/,
);

// A personal target is the caller's own tree, filled in when omitted.
const mine = personal();
assert.equal(authorizeFolderTarget(mine, "u1", "viewer"), null);
assert.equal(mine.ownerId, "u1");
assert.match(
  authorizeFolderTarget(personal("u2"), "u1", "owner") ?? "",
  /own personal/,
);
assert.match(
  authorizeFolderTarget(personal(), undefined, "owner") ?? "",
  /signed-in/,
);

// Moves: leaving the workspace tree needs an editing role; leaving a
// personal tree is the owner's alone, whatever the role.
const fromWorkspace = {
  scope: "workspace" as const,
  folderSegments: [],
  slug: "a",
};
const fromU2 = {
  scope: "private" as const,
  ownerId: "u2",
  folderSegments: [],
  slug: "a",
};
assert.equal(authorizeAppMove(fromWorkspace, personal(), "u1", "member"), null);
assert.match(
  authorizeAppMove(fromWorkspace, personal(), "u1", "viewer") ?? "",
  /editors/,
);
assert.match(
  authorizeAppMove(fromU2, workspace(), "u1", "owner") ?? "",
  /owner can move/,
);
assert.match(
  authorizeAppMove(fromU2, workspace(), undefined, undefined) ?? "",
  /editors|owner/,
);
assert.equal(authorizeAppMove(fromU2, workspace(), "u2", "member"), null);
assert.equal(authorizeAppMove(null, workspace(), "u1", "admin"), null);

// Given the app, filing it into a personal tree (it becomes the mover's
// private app) is its owner's call, or a workspace owner/admin's — never
// an editor's it is merely shared with, nor a member's on a shared app.
const ownedByU2 = {
  access: "private" as const,
  owner_id: "u2",
  sharedWith: [{ userId: "u1", role: "editor" as const }],
};
assert.match(
  authorizeAppMove(fromWorkspace, personal(), "u1", "member", ownedByU2) ?? "",
  /owner or a workspace admin/,
);
assert.equal(
  authorizeAppMove(fromWorkspace, personal(), "u2", "member", ownedByU2),
  null,
);
assert.equal(
  authorizeAppMove(fromWorkspace, personal(), "u3", "admin", {
    access: "workspace",
  }),
  null,
);
assert.match(
  authorizeAppMove(fromWorkspace, personal(), "u1", "member", {
    access: "workspace",
    workspaceRole: "editor",
  }) ?? "",
  /owner or a workspace admin/,
);
// Within the workspace tree, the app's owner does not matter.
assert.equal(
  authorizeAppMove(fromWorkspace, workspace(), "u1", "member", ownedByU2),
  null,
);

// Who may write (and so rename) an app — what GET /apps sends per app as
// `canWrite`. Its OWNER first, whatever the access and the workspace role:
// createProject makes a new app private and owned by its creator, and a
// member who then shares it with the workspace is still its owner.
assert.equal(
  canWriteApp(
    { access: "workspace", owner_id: "u1", workspaceRole: "viewer" },
    "u1",
    "member",
  ),
  true,
);
assert.equal(
  canWriteApp({ access: "private", owner_id: "u1" }, "u1", "viewer"),
  true,
);
// A share as editor, which the list does not carry — only the server knows.
const sharedAsEditor = {
  access: "private" as const,
  owner_id: "u2",
  sharedWith: [{ userId: "u1", role: "editor" as const }],
};
assert.equal(canWriteApp(sharedAsEditor, "u1", "member"), true);
assert.equal(
  canWriteApp(
    {
      ...sharedAsEditor,
      sharedWith: [{ userId: "u1", role: "viewer" as const }],
    },
    "u1",
    "member",
  ),
  false,
);
// Someone else's private app: not even an admin.
assert.equal(
  canWriteApp({ access: "private", owner_id: "u2" }, "u1", "admin"),
  false,
);
// A workspace app: admins always, members by its workspace role (a
// folder-only app has none, and reads as viewer), viewers never.
assert.equal(canWriteApp({ access: "workspace" }, "u1", "admin"), true);
assert.equal(canWriteApp({ access: "workspace" }, "u1", "member"), false);
assert.equal(
  canWriteApp({ access: "workspace", workspaceRole: "editor" }, "u1", "member"),
  true,
);
assert.equal(
  canWriteApp({ access: "workspace", workspaceRole: "editor" }, "u1", "viewer"),
  false,
);
// A workspace API key: no per-user ACL.
assert.equal(
  canWriteApp({ access: "private", owner_id: "u2" }, undefined, undefined),
  true,
);

console.log("app-authorization: ok");
