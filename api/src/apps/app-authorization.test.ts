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
import { OwnerDirectory } from "./user-handles";

// u1 is "joan", u2 is "bob". "u3" is a real user too — and "x9" is a member
// without a handle row yet.
const dir = new OwnerDirectory([
  { userId: "u1", handle: "joan" },
  { userId: "u2", handle: "bob" },
  { userId: "u3", handle: "u1" }, // a handle spelled like u1's id
]);

const workspace = (): AppFolderTarget => ({
  scope: "workspace",
  folderSegments: ["Sales"],
});
const personal = (ownerId?: string): AppFolderTarget => ({
  scope: "private",
  ownerId,
  folderSegments: [],
});
const underHandle = (ownerHandle: string): AppFolderTarget => ({
  scope: "private",
  ownerHandle,
  folderSegments: [],
});

// Editing members organise the workspace tree; nobody else does — including
// an actor with NO role (an API key whose creator left the workspace), who
// used to slip past a `role === "viewer"` check.
assert.equal(canOrganizeWorkspaceTree("owner"), true);
assert.equal(canOrganizeWorkspaceTree("member"), true);
assert.equal(canOrganizeWorkspaceTree("viewer"), false);
assert.equal(canOrganizeWorkspaceTree(undefined), false);
assert.equal(authorizeFolderTarget(workspace(), "u1", "member", dir), null);
assert.match(
  authorizeFolderTarget(workspace(), "u1", "viewer", dir) ?? "",
  /editors/,
);
assert.match(
  authorizeFolderTarget(workspace(), undefined, undefined, dir) ?? "",
  /editors/,
);

// A personal target is the caller's own tree, filled in when omitted.
const mine = personal();
assert.equal(authorizeFolderTarget(mine, "u1", "viewer", dir), null);
assert.equal(mine.ownerId, "u1");
assert.match(
  authorizeFolderTarget(personal("u2"), "u1", "owner", dir) ?? "",
  /own personal/,
);
assert.match(
  authorizeFolderTarget(personal(), undefined, "owner", dir) ?? "",
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
  ownerHandle: "bob",
  folderSegments: [],
  slug: "a",
};
assert.equal(
  authorizeAppMove(fromWorkspace, personal(), "u1", "member", dir),
  null,
);
assert.match(
  authorizeAppMove(fromWorkspace, personal(), "u1", "viewer", dir) ?? "",
  /editors/,
);
assert.match(
  authorizeAppMove(fromU2, workspace(), "u1", "owner", dir) ?? "",
  /owner can move/,
);
assert.match(
  authorizeAppMove(fromU2, workspace(), undefined, undefined, dir) ?? "",
  /editors|owner/,
);
assert.equal(authorizeAppMove(fromU2, workspace(), "u2", "member", dir), null);
assert.equal(authorizeAppMove(null, workspace(), "u1", "admin", dir), null);

// The handle is filled in from the mapping alongside the owner.
const filled = personal();
assert.equal(authorizeFolderTarget(filled, "u1", "member", dir), null);
assert.equal(filled.ownerHandle, "joan");

// Spoofing: a folder NAME grants nothing. ---------------------------------
// Naming someone else's handle is someone else's tree.
assert.match(
  authorizeFolderTarget(underHandle("bob"), "u1", "owner", dir) ?? "",
  /own personal/,
);
assert.equal(
  authorizeFolderTarget(underHandle("joan"), "u1", "viewer", dir),
  null,
);
// A folder spelled like YOUR OWN userId is not your tree: only the handle is.
assert.match(
  authorizeFolderTarget(underHandle("u2"), "u2", "owner", dir) ?? "",
  /own personal/,
);
// A handle that equals another user's id belongs to the handle's owner (u3),
// never to the user with that id (u1).
assert.match(
  authorizeFolderTarget(underHandle("u1"), "u1", "owner", dir) ?? "",
  /own personal/,
);
assert.equal(
  authorizeFolderTarget(underHandle("u1"), "u3", "member", dir),
  null,
);
// A handle nobody holds is nobody's tree: nobody may write it.
for (const who of ["u1", "u2", "u3", "x9"]) {
  assert.match(
    authorizeFolderTarget(underHandle("ghost"), who, "owner", dir) ?? "",
    /own personal/,
  );
}
// A member without a handle has no personal tree to file into.
assert.match(
  authorizeFolderTarget(personal(), "x9", "owner", dir) ?? "",
  /no personal folder/,
);
// A caller-supplied ownerId cannot override the mapping either.
const forged: AppFolderTarget = {
  scope: "private",
  ownerId: "u1",
  ownerHandle: "bob",
  folderSegments: [],
};
assert.match(
  authorizeFolderTarget(forged, "u1", "owner", dir) ?? "",
  /own personal/,
);
// Moving OUT of a tree goes by the mapping too: an app under a ghost handle
// or under someone's raw id is nobody's to move out.
const fromGhost = { ...fromU2, ownerHandle: "ghost" };
assert.match(
  authorizeAppMove(fromGhost, workspace(), "u1", "owner", dir) ?? "",
  /owner can move/,
);
const fromRawId = { ...fromU2, ownerHandle: "u2" };
assert.match(
  authorizeAppMove(fromRawId, workspace(), "u2", "owner", dir) ?? "",
  /owner can move/,
);

console.log("app-authorization: ok");
