/**
 * Console access without a database: the legacy `isPrivate` fallback and
 * the role-based write rule the routes share (canWriteConsole) — plus the
 * ConsoleManager facade's historical isAdmin argument.
 *
 * Run with: pnpm --filter api exec tsx src/services/consoles/access.test.ts
 */
import assert from "node:assert/strict";
import type { ISavedConsole } from "../../database/workspace-schema";
import { canReadConsole, canWriteConsole, legacyAccess } from "./access";
import { ConsoleManager } from "./manager";

// Rows that predate `access` derive it from `isPrivate`.
assert.equal(
  legacyAccess({ access: "workspace", isPrivate: true }),
  "workspace",
);
assert.equal(legacyAccess({ isPrivate: true }), "private");
assert.equal(legacyAccess({ isPrivate: false }), "workspace");
assert.equal(legacyAccess({}), "workspace");

const row = (fields: Partial<ISavedConsole>) =>
  ({ owner_id: "owner", ...fields }) as unknown as ISavedConsole;

const shared = row({ access: "workspace" });
const legacyPrivate = row({ isPrivate: true });

// Owner writes anything of theirs.
assert.ok(canWriteConsole(legacyPrivate, "owner", "member"));
// A private console is invisible to others, admins included.
assert.ok(!canReadConsole(legacyPrivate, "someone", "admin"));
assert.ok(!canWriteConsole(legacyPrivate, "someone", "admin"));
// Workspace consoles: admins edit, viewers only read, members by workspaceRole.
assert.ok(canWriteConsole(shared, "someone", "admin"));
assert.ok(canReadConsole(shared, "someone", "viewer"));
assert.ok(!canWriteConsole(shared, "someone", "viewer"));
assert.ok(!canWriteConsole(shared, "someone", "member"));
assert.ok(
  canWriteConsole(row({ access: "workspace", workspaceRole: "editor" }), "x"),
);

// Facade: the role wins; isAdmin only stands in when no role is given.
assert.ok(ConsoleManager.canWrite(shared, "someone", true));
assert.ok(!ConsoleManager.canWrite(shared, "someone", true, "viewer"));
assert.ok(!ConsoleManager.canWrite(shared, "someone", false));

console.log("console access tests passed");
