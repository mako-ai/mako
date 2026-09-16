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

console.log("app-authorization: ok");
