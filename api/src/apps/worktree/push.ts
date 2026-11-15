/**
 * What a push to the workspace repo sets off: window pokes, the derived
 * indexes of every repo-backed resource, and the workflows deploy.
 */
import { loggers } from "../../logging";
import { publishRealtimeEvent } from "../../services/realtime.service";
import { syncConsolesIndexFromRepo } from "../workspace-consoles.service";
import { syncAppsIndexFromRepo } from "../app-index.service";

import { queueMirrorPush } from "../cloud-repo.service";
import { invalidatePullThrottle } from "./box-session";

const logger = loggers.api("apps");

/** Poke open windows to refetch this app's git-backed state. */
export function pokeApp(
  workspaceId: { toString(): string },
  appId: { toString(): string } | null | undefined,
  origin: "commit" | "merge" | "discard" | "checkout" | "lifecycle" | "push",
  updatedBy?: string,
): void {
  publishRealtimeEvent(workspaceId.toString(), {
    type: "app.updated",
    // "" = workspace-wide (a workspace worktree changed; may span apps).
    appId: appId?.toString() ?? "",
    updatedBy,
    origin,
  });
}

/**
 * React to commits reaching this server's bare repo over the git endpoint.
 *
 * Called by routes/apps-git.ts after every completed receive-pack. This is
 * the ONE place push-shaped side effects live, because every path commits take
 * to the server — the commit button, the agent's end-of-turn commit, `git
 * push` typed in a terminal — converges on that endpoint. The commit
 * functions below deliberately do not queue the mirror or poke windows
 * themselves; doing it both here and there meant every button-press push did
 * its bookkeeping twice, and a terminal push did it zero times.
 */
export function notifyRepoPushed(workspaceId: string, userId: string): void {
  queueMirrorPush(workspaceId);
  pokeApp(workspaceId, null, "push", userId);
  // Another box on the same branch is now behind; let it pull on next touch.
  invalidatePullThrottle();
  syncRepoBackedResources(workspaceId, userId);
}

/**
 * Reconcile every Mongo index that a file in the repo is authoritative for.
 *
 * Split out of {@link notifyRepoPushed} because commits reach main by two
 * routes, not one: this server's git endpoint, and a push made directly on
 * GitHub, which arrives as a webhook (routes/github.routes.ts) and never
 * touches receive-pack here. That second route had grown its own copy of this
 * list containing consoles and skills only, so a dbt job or a notebook edited
 * on GitHub reached Mongo only when someone later happened to push through
 * Mako — config-as-code flowing one way, silently. One list, both callers, so
 * adding a repo-backed resource cannot leave one route behind again.
 *
 * Every sync is an idempotent reconcile against the tree at main, so a push
 * touching none of these costs one tree read each and changes nothing. Each
 * is fire-and-forget and independently caught: one resource's bad YAML must
 * not stop the others from syncing.
 *
 * Callers must have the commit locally FIRST — the git endpoint does by
 * construction, the webhook by fetching before it calls. dbt's sync deletes
 * job rows whose slugs are absent from the tree it reads, so running it
 * against a stale tree would not merely miss an update, it would remove live
 * jobs and deregister their schedules.
 *
 * Flows (RFC #904 block 3) are the most dangerous entry in this list, because
 * a flow is a running stream rather than a row: a file missing from the tree
 * means a CDC teardown and checkpoint disposal, which re-backfills rather than
 * resuming. Two guards make that safe, and both live below this call — an
 * empty `flows/` changes nothing, and every destructive branch is behind a
 * fail-closed assertion that the tree really is the mirror's main.
 */
export function syncRepoBackedResources(
  workspaceId: string,
  userId?: string,
): void {
  // Apps: the folder tree at main IS the list; the index is its read model.
  // A `git mv` in a terminal, a folder pushed from a laptop, a manifest id
  // stamped by hand — all land here.
  void syncAppsIndexFromRepo(workspaceId).catch(error => {
    logger.warn("Apps index sync after push failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // Consoles edited in a terminal or a laptop clone reach the index (and the
  // agent's search) by the next turn (apps.md §16.3).
  void syncConsolesIndexFromRepo(workspaceId, userId).catch(error => {
    logger.warn("Console index sync after push failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  // Skills are files only (apps.md §27): nothing to reconcile on push. A
  // file that stopped loading is reported on the commit instead (a failed
  // `mako/skills` status), so a hidden skill is seen where it was pushed.
  void import("../skill-commit-status")
    .then(m => m.reportSkillsCommitStatus(workspaceId))
    .catch(error => {
      logger.warn("Skills commit status after push failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  // dbt orchestration config (jobs/environments YAML — apps.md §23):
  // external edits re-register schedules on the next push.
  void import("../../dbt/dbt-config.service")
    .then(m => m.syncDbtConfigFromRepo(workspaceId, userId))
    .catch(error => {
      logger.warn("dbt config sync after push failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  // Notebook .deepnote checkpoints (apps.md §24): external edits flow into
  // the hot store unless the live document is ahead.
  void import("../../notebooks/notebook-git.service")
    .then(m => m.syncNotebooksFromRepo(workspaceId, userId))
    .catch(error => {
      logger.warn("Notebook sync after push failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  // Workspace connectors (`connectors/<slug>/`): a folder pushed to main is
  // run in the sync box to capture its `spec`, which is what a credential form
  // is built from. A connector whose spec fails is indexed as blocked with the
  // reason, so whoever pushed it can see why it is not in the picker.
  void import("../../connectors/workspace/reconcile.service")
    .then(m => m.syncConnectorsFromRepo(workspaceId, userId))
    .then(result => {
      if (result.blocked > 0 || result.skipped.length > 0) {
        logger.warn("Some workspace connectors were not indexed", {
          workspaceId,
          blocked: result.blocked,
          skipped: result.skipped,
        });
      }
    })
    .catch(error => {
      logger.warn("Connector sync after push failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  // Workflows (`workflows/`, docs/src/content/docs/workflows.md): a change at main
  // rolls the workspace's worker to the new commit. A commit that fails its
  // typecheck never becomes ready, so the previous worker keeps running.
  deployWorkflows(workspaceId, userId);
  // Flow definitions (RFC #904 block 3): `flows/<slug>.yml` is authoritative,
  // so an external edit reconfigures a live CDC stream and a removed file
  // tears one down. Caught like the others — one resource's bad YAML must not
  // stop the rest — and a refused teardown is reported, not silently skipped.
  void import("../../services/flow-sync.service")
    .then(m => m.syncFlowsFromRepo(workspaceId, userId))
    .then(result => {
      if (result.deferred.length > 0) {
        logger.warn("Flow teardown deferred; will retry on the next push", {
          workspaceId,
          slugs: result.deferred,
        });
      }
    })
    .catch(error => {
      logger.warn("Flow sync after push failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * Ask for the workspace's workflows to be deployed from `main`, durably
 * (inngest/functions/workflows-deploy.ts): the request that moved main
 * returns now, and the deploy runs to completion elsewhere. A workspace
 * with no workflows asks for nothing.
 */
export function deployWorkflows(workspaceId: string, userId?: string): void {
  void Promise.all([
    import("../../workflows/on-push"),
    import("../../inngest/functions/workflows-deploy"),
  ])
    .then(async ([onPush, deploy]) => {
      if (await onPush.hasWorkflowsToDeploy(workspaceId)) {
        await deploy.requestWorkflowsDeploy(workspaceId, userId, "push");
      }
    })
    .catch(error => {
      logger.warn("Workflows deploy request failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}
