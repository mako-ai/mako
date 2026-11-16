import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WORKSPACE_TEMPLATE_VERSION,
  managedTemplateFiles,
  initialWorkspaceFiles,
  planTemplateRefresh,
  templateFingerprint,
} from "./workspace-template";

// When this fails you changed a managed file: bump WORKSPACE_TEMPLATE_VERSION
// and paste the new fingerprint. The bump is what moves existing repos.
const PINNED = { version: 26, fingerprint: "2ac8e9a8c9f81d65" };
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
// Claude Code silently skips a missing @import, so @PROMPT.md is safe in a
// workspace that has none yet.
assert.equal(files["CLAUDE.md"], "@AGENTS.md\n@PROMPT.md\n");
// Codex and Cursor read only AGENTS.md: it must send them to the workspace's
// own rule files, and stop sending agent rules to README.md.
assert.match(files["AGENTS.md"], /## Workspace rules/);
assert.match(files["AGENTS.md"], /`PROMPT\.md`: rules for every task/);
assert.match(files["AGENTS.md"], /`CONTRIBUTING\.md`: how changes get made/);
assert.doesNotMatch(files["AGENTS.md"], /guidance\s+in README\.md/);
// The template never owns the workspace's rule files.
for (const owned of ["PROMPT.md", "CONTRIBUTING.md"]) {
  assert.equal(files[owned], undefined, `${owned} must not be managed`);
  assert.equal(initialWorkspaceFiles("ws")[owned], undefined);
}
assert.match(files["AGENTS.md"], /managed by Mako/);
assert.match(files["AGENTS.md"], /app_write_file[\s\S]*not on this checkout/);
assert.match(files["AGENTS.md"], /update_self_directive/);
assert.match(files["AGENTS.md"], /mako login/);
// Nothing vendored: the SDK comes from npm, and AGENTS.md says so.
assert.equal(
  Object.keys(files).some(f => f.startsWith("packages/")),
  false,
  "the template must not write packages/ into a workspace repo",
);
assert.match(files["AGENTS.md"], /@makoai\/app-sdk\/ui/);
assert.match(files["AGENTS.md"], /never vendor/);
assert.doesNotMatch(files["AGENTS.md"], /packages\/app-sdk/);
const stamp = JSON.parse(files[".mako/workspace.json"]);
assert.deepEqual(stamp, {
  workspaceId: "6846e6a01b05af0948070582",
  templateVersion: WORKSPACE_TEMPLATE_VERSION,
});

const initial = initialWorkspaceFiles("ws");
assert.ok(
  initial["README.md"] && initial[".gitignore"] && initial["AGENTS.md"],
);
assert.match(initial[".gitignore"], /^\.env$/m);

// The retired vendored copy: deleted when nothing references it, kept while
// an app still depends on it through a file: path.
function repoWith(extra: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-template-"));
  const files: Record<string, string> = {
    ".mako/workspace.json": JSON.stringify({
      workspaceId: "ws",
      templateVersion: 19,
    }),
    "packages/app-sdk/package.json": JSON.stringify({
      name: "@makoai/app-sdk",
    }),
    "packages/app-sdk/index.js": "export {};\n",
    "apps/sales/package.json": JSON.stringify({
      dependencies: { "@makoai/app-sdk": "^2.6.0" },
    }),
    ...extra,
  };
  for (const [rel, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), contents);
  }
  const git = (...args: string[]) =>
    assert.equal(
      spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" }).status,
      0,
      `git ${args.join(" ")}`,
    );
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git(
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "-m",
    "init",
  );
  return dir;
}

void (async () => {
  const unused = await planTemplateRefresh(repoWith({}), "ws");
  assert.deepEqual(unused?.deletePrefixes, ["packages/app-sdk"]);

  const stillUsed = await planTemplateRefresh(
    repoWith({
      "apps/legacy/package.json": JSON.stringify({
        dependencies: { "@makoai/app-sdk": "file:../../packages/app-sdk" },
      }),
    }),
    "ws",
  );
  assert.deepEqual(stillUsed?.deletePrefixes, []);
  assert.ok(
    stillUsed?.writes["AGENTS.md"],
    "the rest of the refresh still applies",
  );

  // A refresh rewrites managed files only: the workspace's README.md,
  // PROMPT.md and CONTRIBUTING.md stay exactly as they are.
  const owned = await planTemplateRefresh(
    repoWith({
      "README.md": "# Ours\n",
      "PROMPT.md": "Our rules.\n",
      "CONTRIBUTING.md": "Our process.\n",
    }),
    "ws",
  );
  assert.ok(owned?.writes["AGENTS.md"] && owned.writes["CLAUDE.md"]);
  for (const rel of ["README.md", "PROMPT.md", "CONTRIBUTING.md"]) {
    assert.equal(
      owned?.writes[rel],
      undefined,
      `refresh must not touch ${rel}`,
    );
  }

  console.log("workspace-template: ok");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
