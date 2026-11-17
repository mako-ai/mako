/**
 * The one rule every door onto main asks: a change under `workflows/` or
 * `connectors/` lands on main only through an owner or admin. Code there runs
 * on the workspace's schedule (workflows) or with its connections' keys
 * (connectors). The git endpoint asks it in its pre-receive hook
 * (routes/apps-git.ts); every API path that moves main without a hook asks
 * here: a branch merge, an app publish.
 */
import { CONNECTOR_FOLDERS_DIR, WORKFLOWS_DIR } from "../app-paths";
import { runGit } from "../git";
import { workspaceService } from "../../services/workspace.service";
import {
  CONNECTORS_ADMIN_ONLY,
  WORKFLOWS_ADMIN_ONLY,
  mayChangeConnectors,
  mayChangeWorkflows,
} from "../../workflows/policy";
import { WorktreeConflictError } from "./repo";

/** Whether `range` changes anything under `dir/`. */
async function changes(repoDir: string, range: string, dir: string) {
  const { stdout } = await runGit([
    ...["-C", repoDir, "diff", "--name-only", range],
    ...["--", `${dir}/`],
  ]);
  return Boolean(stdout.trim());
}

/**
 * Refuse unless the actor may land what `range` changes. `range` is a git
 * diff range: `main...branch` for a merge (what the branch changed since it
 * left main), `main..candidate` for a promoted commit. With no actor, a
 * change to a guarded folder is refused: an anonymous caller is no admin.
 */
export async function assertMayLandOnMain(input: {
  repoDir: string;
  range: string;
  workspaceId: string;
  actorUserId: string | undefined;
}): Promise<void> {
  const workflows = await changes(input.repoDir, input.range, WORKFLOWS_DIR);
  const connectors = await changes(
    input.repoDir,
    input.range,
    CONNECTOR_FOLDERS_DIR,
  );
  if (!workflows && !connectors) return;
  const role = input.actorUserId
    ? (await workspaceService.getMember(input.workspaceId, input.actorUserId))
        ?.role
    : undefined;
  if (workflows && !mayChangeWorkflows(role)) {
    throw new WorktreeConflictError(WORKFLOWS_ADMIN_ONLY);
  }
  if (connectors && !mayChangeConnectors(role)) {
    throw new WorktreeConflictError(CONNECTORS_ADMIN_ONLY);
  }
}
