import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

import { AGENT_CAPABILITY_BY_NAME, CAPABILITY_GRANTS } from "@mako/agent-tools";

import { configProblem, declaredFields } from "./connection-write-tools";
import {
  KEY_REQUEST_TTL_MS,
  describeKeyStatus,
  fieldsForKeyLink,
  hashKeyToken,
  keyLinkUrl,
  keyRequestStatus,
  newKeyRequest,
} from "../../connectors/connection-key-request.service";
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
  { name: "apiKey", required: true, secret: true },
  { name: "workspaceId", required: false, secret: false },
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

// --- the key link: secrets left out of `config` go to a one-time link ------

// A required secret left out is asked for through the link, not refused.
assert.deepEqual(fieldsForKeyLink({ workspaceId: "ws_1" }, fields!), [
  "apiKey",
]);
assert.equal(
  configProblem({ workspaceId: "ws_1" }, fields, ["apiKey"]),
  null,
  "a field the link asks for is not missing",
);
// A key passed inline means no link.
assert.deepEqual(fieldsForKeyLink({ apiKey: "sway_secret" }, fields!), []);
// An optional secret left out is asked for too: leaving the key out is how
// an agent asks for the link (a Custom API's token is optional).
const optionalSecret = declaredFields({
  fields: [
    { name: "baseUrl", type: "string", required: true },
    { name: "token", type: "string", encrypted: true },
  ],
})!;
assert.deepEqual(fieldsForKeyLink({ baseUrl: "https://x" }, optionalSecret), [
  "token",
]);
// Only the secret fields the form shows for this config are asked for.
const custom = declaredFields({
  fields: [
    { name: "auth_type", type: "select", required: true },
    {
      name: "token",
      type: "password",
      showIf: { field: "auth_type", equals: ["bearer", "api_key_header"] },
    },
    {
      name: "password",
      type: "password",
      showIf: { field: "auth_type", equals: "basic" },
    },
  ],
})!;
assert.deepEqual(fieldsForKeyLink({ auth_type: "bearer" }, custom), ["token"]);
assert.deepEqual(fieldsForKeyLink({ auth_type: "basic" }, custom), [
  "password",
]);
// No credential shown (auth "none"): nothing to ask for.
assert.deepEqual(fieldsForKeyLink({ auth_type: "none" }, custom), []);
// A non-secret required field is still the agent's to pass.
assert.match(
  configProblem({}, optionalSecret, ["token"]) ?? "",
  /Missing required config field\(s\): baseUrl/,
);

// The token is never stored: only its hash, with an expiry and the fields.
{
  const now = new Date("2026-11-10T10:00:00Z");
  const { token, keyRequest } = newKeyRequest({
    fields: ["apiKey"],
    requestedBy: "u1",
    now,
  });
  assert.ok(token.length >= 43, "a 256-bit token");
  assert.equal(keyRequest.tokenHash, hashKeyToken(token));
  assert.ok(!JSON.stringify(keyRequest).includes(token));
  assert.equal(
    keyRequest.expiresAt.getTime() - now.getTime(),
    KEY_REQUEST_TTL_MS,
  );
  assert.equal(keyRequestStatus(undefined), "ready");
  assert.equal(keyRequestStatus(keyRequest, now), "awaiting_key");
  assert.equal(
    keyRequestStatus(keyRequest, new Date(now.getTime() + KEY_REQUEST_TTL_MS)),
    "key_link_expired",
  );
  const described = describeKeyStatus(keyRequest, now);
  assert.equal(described.status, "awaiting_key");
  assert.deepEqual(described.awaitingFields, ["apiKey"]);
  assert.ok(!JSON.stringify(described).includes(keyRequest.tokenHash));
  process.env.CLIENT_URL = "https://mako.example/";
  // The token rides in the fragment: no server, log or analytics page path
  // ever sees it.
  const link = new URL(keyLinkUrl("ws1", token));
  assert.equal(
    link.origin + link.pathname,
    "https://mako.example/connection-key/ws1",
  );
  assert.ok(!link.pathname.includes(token) && !link.search.includes(token));
  assert.equal(decodeURIComponent(link.hash.slice(1)), token);
}

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
