import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Creating an app without a connected GitHub repo used to succeed by
 * initializing a local-only bare repo. That skip was Mako Cloud Storage
 * (issue #956): consoles, dbt, and prompt writes then passed
 * requireWorkspaceRepo even though the workspace never linked GitHub.
 *
 * The HTTP create route and the status probe must both key off the binding
 * list, not APPS_REQUIRE_CONNECTED_REPO.
 */

const apps = readFileSync(join(__dirname, "apps.ts"), "utf8");

assert.equal(
  apps.includes("appsRequireConnectedRepo"),
  false,
  "apps routes must not bypass the GitHub-binding gate via appsRequireConnectedRepo",
);

assert.ok(
  /canCreate:\s*repos\.length\s*>\s*0/.test(apps),
  "status-probe canCreate must be repos.length > 0 — a workspace with no binding must not report that apps can be created",
);

assert.ok(
  /const repos = await listWorkspaceRepos\(workspaceId\);[\s\S]*?if \(repos\.length === 0\)/.test(
    apps,
  ),
  "POST /apps must 412 when listWorkspaceRepos is empty",
);

assert.ok(
  apps.includes("RepoRequiredError") && apps.includes("error.status as 412"),
  "apps handleError must map RepoRequiredError to 412",
);

assert.ok(
  apps.includes("List Apps projects") &&
    apps.includes("{ success: true as const, apps: [] }"),
  "GET /apps must return 200 { apps: [] } when no GitHub repo is bound, not 412",
);

const gate = readFileSync(
  join(__dirname, "../apps/workspace-repo-required.ts"),
  "utf8",
);
assert.ok(
  /if\s*\(!\(await getWorkspaceRepo\(workspaceId\)\)\)/.test(gate),
  "requireWorkspaceRepo must refuse when no GitHub binding exists — leftover local git is not a skip",
);
const requireWorkspaceRepoBody =
  /export async function requireWorkspaceRepo[\s\S]*?\n}/.exec(gate)?.[0] ?? "";
assert.equal(
  requireWorkspaceRepoBody.includes("ensureLocalRepo"),
  false,
  "requireWorkspaceRepo must not fall through to a local-only repo",
);
assert.ok(
  /export async function boundRepoDirIfExists[\s\S]*?getWorkspaceRepo[\s\S]*?ensureLocalRepo/.test(
    gate,
  ),
  "bound read helpers must restore a cold serverless repo cache",
);

console.log("apps github-required tests passed");
