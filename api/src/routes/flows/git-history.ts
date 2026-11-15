import {
  registerGitHistoryRoutes,
  type GitHistoryEntity,
} from "../lib/git-history-routes";
import { fail } from "../lib/respond";
import {
  flowGitScope,
  restoreFlowTo,
} from "../../services/repo-entity-restore.service";
import { loadLiveFlowById } from "../../services/flow-sync.service";
import { assertFlowRepo, type FlowRouter } from "./shared";

/**
 * Git history of the definition file `flows/<slug>.yml` — the same History
 * surface consoles and apps have. Under `/git/` because `/{flowId}/history`
 * is the run history. Saving a flow needs no role beyond membership (PUT),
 * so neither does restoring one.
 */
export function registerFlowGitHistoryRoutes(flowRoutes: FlowRouter): void {
  registerGitHistoryRoutes<GitHistoryEntity & { slug: string }>(flowRoutes, {
    tag: "Flows",
    noun: "flow",
    idParam: "flowId",
    base: "/{flowId}/git",
    load: async c => {
      const workspaceId = c.req.param("workspaceId") as string;
      // The same resolution as GET /{flowId}: ids in the list may be derived
      // from a file that has no row yet.
      const live = await loadLiveFlowById(
        workspaceId,
        c.req.param("flowId") ?? "",
      );
      if (!live) {
        return fail(c, 404, "Flow not found");
      }
      return {
        scope: flowGitScope(workspaceId, live.def.slug),
        userId: c.get("user")?.id,
        workspaceId,
        slug: live.def.slug,
      };
    },
    restore: async (flow, sha) => {
      await assertFlowRepo(flow.workspaceId);
      return {
        ...(await restoreFlowTo({ ...flow, sha, actorUserId: flow.userId })),
      };
    },
  });
}
