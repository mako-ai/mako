import assert from "node:assert/strict";
import {
  WORKSPACE_TEMPLATE_VERSION,
  managedTemplateFiles,
  initialWorkspaceFiles,
  templateFingerprint,
} from "./workspace-template";

// When this fails you changed a managed file: bump WORKSPACE_TEMPLATE_VERSION
// and paste the new fingerprint. The bump is what moves existing repos.
const PINNED = { version: 4, fingerprint: "cc58059df561fb6d" };
assert.equal(WORKSPACE_TEMPLATE_VERSION, PINNED.version);
assert.equal(
  templateFingerprint(),
  PINNED.fingerprint,
  "managed template content changed without a WORKSPACE_TEMPLATE_VERSION bump",
);

const files = managedTemplateFiles("6846e6a01b05af0948070582");
const mcp = JSON.parse(files[".mcp.json"]);
assert.equal(mcp.mcpServers.mako.type, "http");
assert.equal(
  mcp.mcpServers.mako.url,
  "${MAKO_API_URL:-https://app.mako.ai}/api/mcp",
);
assert.equal(
  mcp.mcpServers.mako.headers,
  undefined,
  "OAuth-first: no header, clients sign in",
);
assert.equal(files["CLAUDE.md"].trim(), "@AGENTS.md");
assert.match(files["AGENTS.md"], /managed by Mako/);
assert.match(files["AGENTS.md"], /app_write_file[\s\S]*not on this checkout/);
assert.match(files["AGENTS.md"], /update_self_directive/);
assert.match(files["AGENTS.md"], /mako login/);
assert.ok(files["packages/app-sdk/credentials.js"].includes("getAccessToken"));
const stamp = JSON.parse(files[".mako/workspace.json"]);
assert.deepEqual(stamp, {
  workspaceId: "6846e6a01b05af0948070582",
  templateVersion: WORKSPACE_TEMPLATE_VERSION,
});
assert.ok(
  files["packages/app-sdk/vite.js"].includes("export function makoData"),
);

const initial = initialWorkspaceFiles("ws");
assert.ok(
  initial["README.md"] && initial[".gitignore"] && initial["AGENTS.md"],
);
assert.match(initial[".gitignore"], /^\.env$/m);

console.log("workspace-template: ok");
