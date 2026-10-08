import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

import { AGENT_CAPABILITY_BY_NAME, CAPABILITY_GRANTS } from "@mako/agent-tools";

import { configProblem, declaredFields } from "./connection-write-tools";
import {
  capabilityGrantsFromScopes,
  resolveWorkspaceApiKeyScopes,
} from "../../auth/api-key-scopes";
import { MCP_BRIDGE_POLICY } from "../../mcp/bridge-policy";

/**
 * create_connection stores a credential. These assertions cover what would
 * let a viewer reach it, or store a secret in plaintext.
 */

// --- config validation: fail closed, and never mention a value -------------

const fields = declaredFields({
  fields: [
    { name: "apiKey", type: "password", required: true },
    { name: "workspaceId", type: "string" },
  ],
});
assert.deepEqual(fields, [
  { name: "apiKey", required: true },
  { name: "workspaceId", required: false },
]);

assert.equal(configProblem({ apiKey: "sway_secret" }, fields), null);
assert.equal(
  configProblem({ apiKey: "sway_secret", workspaceId: "ws_1" }, fields),
  null,
);

// No schema = no way to tell which value is the secret. Refuse, rather than
// store it unencrypted (a null schema makes applySchemaEncryption a no-op).
for (const schema of [null, undefined, {}, { fields: [] }]) {
  const problem = configProblem(
    { apiKey: "sway_secret" },
    declaredFields(schema),
  );
  assert.ok(problem, "a connector without a config schema must be refused");
  assert.match(problem, /no config schema/);
  assert.ok(!problem.includes("sway_secret"));
}

// A typo'd key would be stored next to the real one, unencrypted.
const unknown = configProblem({ apikey: "sway_secret" }, fields);
assert.ok(unknown);
assert.match(unknown, /Unknown config field\(s\): apikey/);
assert.match(unknown, /accepts: apiKey, workspaceId/);
assert.ok(!unknown.includes("sway_secret"), "errors name fields, never values");

const missing = configProblem({ workspaceId: "ws_1" }, fields);
assert.ok(missing);
assert.match(missing, /Missing required config field\(s\): apiKey/);
assert.ok(configProblem({ apiKey: "" }, fields), "an empty secret is missing");

// --- no opt-in: every MCP session holds the grant; the role gates it ------

const serverSource = readFileSync(
  join(__dirname, "../../mcp/mako-mcp-server.ts"),
  "utf8",
);
assert.ok(
  /EXTERNAL_MCP_IMPLICIT_GRANTS[\s\S]{0,200}?"connections-write"/.test(
    serverSource,
  ),
  "connections-write must be an implicit grant of every MCP/CLI credential",
);
// Stored keys and tokens that carry the old scope keep parsing.
assert.deepEqual(
  capabilityGrantsFromScopes(
    resolveWorkspaceApiKeyScopes(["mcp", "query:read", "connections:write"]),
  ),
  ["connections-write"],
);
assert.ok(CAPABILITY_GRANTS.includes("connections-write"));

// --- the capability is gated, external-MCP only, and bridged ---------------

const capability = AGENT_CAPABILITY_BY_NAME.get("create_connection");
assert.ok(capability, "create_connection must be in the capability registry");
assert.equal(capability.requiredGrant, "connections-write");
assert.equal(capability.minimumWorkspaceRole, "member");
assert.equal(capability.risk, "write");
assert.deepEqual(
  [...capability.surfaces],
  ["external-mcp"],
  "a prompt-injected in-product chat must not be able to plant a credential",
);

const entry = MCP_BRIDGE_POLICY.create_connection;
assert.ok(entry);
assert.equal(entry.status, "bridge");

console.log("connection-write-tools tests passed");
