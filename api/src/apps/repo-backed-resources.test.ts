import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The webhook and the git endpoint must react to a push the same way.
 *
 * Commits reach main by two routes: this server's git endpoint (receive-pack
 * → notifyRepoPushed) and a push made directly on GitHub, which arrives as a
 * webhook and never touches receive-pack here. The webhook had grown its own
 * copy of the "reconcile these indexes" list holding consoles and skills only,
 * so a dbt job or a notebook edited on GitHub reached Mongo only when someone
 * later happened to push through Mako.
 *
 * A copied list drifts silently — the failure is invisible until someone
 * notices their config never arrived. These assertions are source-level on
 * purpose: they fail when a future edit re-introduces the fan-out in one route
 * instead of the shared function, which is the mistake being prevented, and
 * they need no database or git fixture to do it.
 */

const SRC = join(__dirname, "..");
const worktree = readFileSync(join(SRC, "apps/worktree.service.ts"), "utf8");
const webhook = readFileSync(join(SRC, "routes/github.routes.ts"), "utf8");

// Every repo-backed resource is reconciled from exactly one place.
const SYNCS = [
  "syncConsolesIndexFromRepo",
  "syncSkillsIndexFromRepo",
  "syncDbtConfigFromRepo",
  "syncNotebooksFromRepo",
];

const shared = worktree.slice(
  worktree.indexOf("export function syncRepoBackedResources"),
);
assert.ok(shared, "syncRepoBackedResources must exist");

for (const sync of SYNCS) {
  assert.ok(
    shared.includes(sync),
    `${sync} must be called from syncRepoBackedResources — it is what both push routes share`,
  );
  assert.ok(
    !webhook.includes(sync),
    `github.routes.ts must NOT call ${sync} directly; call syncRepoBackedResources so the two routes cannot drift`,
  );
}

// Both push routes go through the shared reaction.
assert.ok(
  worktree.includes("syncRepoBackedResources(workspaceId, userId)"),
  "notifyRepoPushed must delegate to syncRepoBackedResources",
);
assert.ok(
  webhook.includes("syncRepoBackedResources(workspaceId)"),
  "the GitHub push handler must delegate to syncRepoBackedResources",
);

// dbt's sync DELETES job rows absent from the tree it reads, so the webhook
// must have fetched the commit before reacting. Assert the ordering rather
// than trusting it: a reversal here silently deletes live jobs and
// deregisters their schedules.
const handler = webhook.slice(
  webhook.indexOf("async function handleAppsPush"),
  webhook.indexOf("githubRoutes.post"),
);
const fetched = handler.indexOf("fetchFromCloud(");
const reacted = handler.indexOf("syncRepoBackedResources(");
assert.ok(fetched !== -1 && reacted !== -1, "both calls must be present");
assert.ok(
  fetched < reacted,
  "fetchFromCloud must run BEFORE syncRepoBackedResources: dbt's sync deletes jobs missing from the tree it reads, so reacting to a tree that predates the push would remove live jobs",
);

// Flows are Mongo → git only until RFC #904 block 3 flips authority. This is a
// deliberate exclusion, and it is recorded here so that adding a flow sync is
// a conscious act rather than an oversight in the other direction.
assert.ok(
  !shared.includes("syncFlows") && !shared.includes("flow-config.service"),
  "flows are deliberately not synced from the repo yet (RFC #904 block 3) — see flow-config.service.ts",
);

console.log("repo-backed resource sync tests passed");
