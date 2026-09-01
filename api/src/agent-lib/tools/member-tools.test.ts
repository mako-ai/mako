import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { inviteRoleAllowed } from "./member-tools";
import {
  capabilityGrantsFromScopes,
  resolveWorkspaceApiKeyScopes,
  DEFAULT_WORKSPACE_API_KEY_SCOPES,
} from "../../auth/api-key-scopes";
import { CAPABILITY_GRANTS } from "@mako/agent-tools";
import { MCP_BRIDGE_POLICY } from "../../mcp/bridge-policy";

/**
 * Inviting is the one agent action whose blast radius is every other action,
 * permanently: an invited admin can invite more admins and reach every
 * connection in the workspace. These assertions cover the three things that
 * would quietly turn that from gated into open.
 */

// --- escalation: an invitation may never exceed the inviter's own role -----

assert.equal(inviteRoleAllowed("owner", "admin"), true);
assert.equal(inviteRoleAllowed("owner", "viewer"), true);
assert.equal(inviteRoleAllowed("admin", "admin"), true);
assert.equal(inviteRoleAllowed("admin", "member"), true);

// The whole point: a compromised admin key cannot mint someone above itself.
// (Owner is not in the invitable set at all, but the rank check is what
// enforces it rather than the enum alone — so assert the rank check directly.)
assert.equal(
  inviteRoleAllowed("admin", "owner" as never),
  false,
  "an admin must not be able to invite an owner",
);

// A role we do not recognise is not treated as high privilege. An unknown
// string must fail closed, not rank above viewer by accident.
assert.equal(inviteRoleAllowed(undefined, "viewer"), false);
assert.equal(inviteRoleAllowed("", "viewer"), false);
assert.equal(inviteRoleAllowed("superuser", "viewer"), false);
assert.equal(
  inviteRoleAllowed("member", "viewer"),
  false,
  "member is below admin, so it must not confer any invitation at all",
);

// --- the scope is opt-in, and maps to exactly one grant --------------------

assert.ok(
  !DEFAULT_WORKSPACE_API_KEY_SCOPES.includes("members:write" as never),
  "members:write must never be a default scope on a newly created key",
);

assert.deepEqual(
  capabilityGrantsFromScopes(resolveWorkspaceApiKeyScopes(["mcp"])),
  [],
  "an mcp-only key grants nothing",
);
assert.deepEqual(
  capabilityGrantsFromScopes(
    resolveWorkspaceApiKeyScopes(["mcp", "query:read"]),
  ),
  [],
  "the default MCP key must not carry members-write",
);
assert.deepEqual(
  capabilityGrantsFromScopes(
    resolveWorkspaceApiKeyScopes(["mcp", "members:write"]),
  ),
  ["members-write"],
);

// A legacy unscoped key resolves to NO scopes, so it cannot reach this tool
// on the strength of being old and broad.
assert.deepEqual(
  capabilityGrantsFromScopes(resolveWorkspaceApiKeyScopes(undefined)),
  [],
);

assert.ok(
  CAPABILITY_GRANTS.includes("members-write"),
  "members-write must be a registered grant or the MCP filter cannot hide the tool",
);

// --- the blanket desktop grant must not sweep members-write up ------------

// `sessionCapabilityGrants` hands an ACP Desktop session every entry in
// CAPABILITY_GRANTS. Adding members-write to that list therefore widened the
// desktop surface silently — caught only because the app's own allowlist
// stopped type-checking. Pin the exclusion so the next grant added to
// CAPABILITY_GRANTS cannot repeat it.
const mcpServerSource = readFileSync(
  join(__dirname, "../../mcp/mako-mcp-server.ts"),
  "utf8",
);
assert.ok(
  /ACP_DESKTOP_WITHHELD_GRANTS[\s\S]{0,200}?"members-write"/.test(
    mcpServerSource,
  ),
  "members-write must be withheld from the blanket acpDesktop grant set",
);
// The precise property: CAPABILITY_GRANTS is never spread RAW into a grant
// set — every use must run through the withholding filter. Asserting merely
// that the acpDesktop branch mentions ACP_DESKTOP_WITHHELD_GRANTS somewhere
// is not enough; the first version of this check did that and still passed
// with the raw spread restored, because the branch's *second* filter kept the
// name in scope.
assert.ok(
  !/\.\.\.CAPABILITY_GRANTS\s*[,\]]/.test(mcpServerSource),
  "CAPABILITY_GRANTS must never be spread raw into a session's grants — it would confer every future grant, members-write included",
);
assert.ok(
  /\.\.\.CAPABILITY_GRANTS\.filter\(/.test(mcpServerSource),
  "the acpDesktop branch must derive its grants by filtering CAPABILITY_GRANTS",
);

// --- the tools stay classified on the bridge ------------------------------

for (const name of ["invite_workspace_member", "list_workspace_members"]) {
  const entry = MCP_BRIDGE_POLICY[name];
  assert.ok(entry, `${name} must be classified in the MCP bridge policy`);
  assert.equal(
    entry.status,
    "bridge",
    `${name} is expected on the MCP surface — if it is deliberately removed, change this assertion rather than deleting it`,
  );
}

console.log("member-tools tests passed");
