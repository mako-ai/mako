/**
 * One rule set for filing apps, shared by the routes, the agent tools and
 * the connector — so an actor one door refuses cannot walk through another.
 *
 * Run: npx tsx src/apps/app-authorization.test.ts
 */
import assert from "node:assert/strict";
import {
  appRenameRights,
  authorizeAppMove,
  authorizeFolderTarget,
  canOrganizeWorkspaceTree,
  canTakePrivate,
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

// Filing an app INTO a personal tree makes it that person's private app:
// only its owner or a workspace owner/admin may. An editor it is merely
// shared with must not take it over, nor a member hide a workspace app.
const bobsApp = { owner_id: "u2", access: "workspace" as const };
const move = (userId: string, role: string, app: object) =>
  authorizeAppMove(fromWorkspace, personal(), userId, role, dir, app);
assert.equal(move("u2", "member", bobsApp), null);
assert.equal(move("u1", "admin", bobsApp), null);
assert.match(move("u1", "member", bobsApp) ?? "", /owner or a workspace admin/);
assert.match(
  move("u1", "member", {
    ...bobsApp,
    sharedWith: [{ userId: "u1", role: "editor" }],
  }) ?? "",
  /owner or a workspace admin/,
);
// A folder-only app has no owner: an admin's to take, not a member's.
assert.match(
  canTakePrivate({ access: "workspace" }, "u1", "member") ?? "",
  /owner/,
);
assert.equal(canTakePrivate({ access: "workspace" }, "u1", "owner"), null);
// Out of a personal tree, or with no app given, nothing changes.
assert.equal(
  authorizeAppMove(fromU2, workspace(), "u2", "member", dir, bobsApp),
  null,
);
assert.equal(
  authorizeAppMove(fromWorkspace, personal(), "u1", "member", dir),
  null,
);

// Renaming. The NAME is an edit of the app: whoever may write it. The LINK
// is the folder's name: an editing role in the workspace tree, the owner in
// a personal one.
const rights = (
  app: object,
  source: typeof fromU2 | typeof fromWorkspace,
  user?: string,
  role?: string,
) => appRenameRights(app, source, user, role, dir);
const wsEditable = {
  owner_id: "u2",
  access: "workspace" as const,
  workspaceRole: "editor" as const,
};
assert.deepEqual(rights(wsEditable, fromWorkspace, "u1", "member"), {
  kind: "full",
});
assert.deepEqual(
  rights(wsEditable, fromWorkspace, "u2", "viewer").kind,
  "title",
);
// Read-only: refused, and said so (the app is in their list).
const readOnly = rights(
  { ...wsEditable, workspaceRole: "viewer" },
  fromWorkspace,
  "u1",
  "member",
);
assert.equal(readOnly.kind, "none");
assert.equal(readOnly.kind === "none" && readOnly.hidden, false);
assert.match(readOnly.kind === "none" ? readOnly.reason : "", /read-only/);
// Not visible at all: must read as "not found".
const invisible = rights(
  { owner_id: "u2", access: "private" },
  fromU2,
  "u1",
  "admin",
);
assert.equal(invisible.kind === "none" && invisible.hidden, true);
// A personal app: its owner renames everything; an editor it is shared
// with renames the name only — the folder is the owner's.
const bobsPrivate = {
  owner_id: "u2",
  access: "private" as const,
  sharedWith: [{ userId: "u1", role: "editor" as const }],
};
assert.deepEqual(rights(bobsPrivate, fromU2, "u2", "member"), { kind: "full" });
const shared = rights(bobsPrivate, fromU2, "u1", "owner");
assert.equal(shared.kind, "title");
assert.match(
  shared.kind === "title" ? shared.linkReason : "",
  /owner of this personal folder/,
);
// A credential with no person behind it: no per-user ACL, and no role to
// reorganise the workspace tree with — exactly what app_move_app allows.
assert.deepEqual(rights(wsEditable, fromWorkspace).kind, "title");

console.log("app-authorization: ok");
