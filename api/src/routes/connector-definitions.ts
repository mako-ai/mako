/**
 * A workspace's own connector definitions (`connectors/<slug>/` in the
 * workspace repo), as opposed to the public built-in catalog on
 * `/api/connectors`. Authenticated and workspace-scoped: a definition's files
 * are one tenant's code.
 *
 * Today this is only the git History surface — the whole folder's commits,
 * diffs, and restore-as-new-commit — the same one consoles, notebooks and
 * flows have. Definitions are otherwise authored by pushes and agents.
 */
import { Types } from "mongoose";

import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import {
  requireWorkspace,
  type AuthenticatedContext,
} from "../middleware/workspace.middleware";
import { createRouter } from "../openapi/core";
import { boundRepoDirIfExists } from "../apps/workspace-repo-required";
import { DEFAULT_BRANCH, readBlob } from "../apps/repository.service";
import { CONNECTORS_DIR } from "../connectors/workspace/resolver";
import {
  CONNECTORS_ADMIN_ONLY,
  mayChangeConnectors,
} from "../workflows/policy";
import {
  connectorGitScope,
  restoreConnectorTo,
} from "../services/repo-entity-restore.service";
import { isValidSlug } from "../connectors/workspace/connector-file";
import {
  registerGitHistoryRoutes,
  type GitHistoryEntity,
} from "./lib/git-history-routes";
import { fail } from "./lib/respond";

export const connectorDefinitionRoutes = createRouter();

/** Whether `connectors/<slug>/connector.yaml` exists on main. */
async function connectorFolderAtMain(
  workspaceId: string,
  slug: string,
): Promise<boolean> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return false;
  return readBlob(
    repoDir,
    `refs/heads/${DEFAULT_BRANCH}`,
    `${CONNECTORS_DIR}/${slug}/connector.yaml`,
  ).then(
    () => true,
    () => false,
  );
}

connectorDefinitionRoutes.use("*", unifiedAuthMiddleware);
connectorDefinitionRoutes.use("*", requireWorkspace);

registerGitHistoryRoutes<GitHistoryEntity & { slug: string }>(
  connectorDefinitionRoutes,
  {
    tag: "Connectors",
    noun: "connector",
    idParam: "slug",
    base: "/{slug}/git",
    load: async (c: AuthenticatedContext, { write }) => {
      const workspaceId = c.req.param("workspaceId") as string;
      const slug = c.req.param("slug") ?? "";
      if (!Types.ObjectId.isValid(workspaceId) || !isValidSlug(slug)) {
        return fail(c, 404, "Connector not found");
      }
      // The folder at main is the connector — its index row can lag a push
      // (or be missing entirely), and history is about the files anyway.
      if (!(await connectorFolderAtMain(workspaceId, slug))) {
        return fail(c, 404, "Connector not found");
      }
      // Restoring commits code onto main that runs with its connections'
      // keys: an owner or admin, as for every other way connector code
      // reaches main (workflows/policy.ts).
      if (write && !mayChangeConnectors(c.get("memberRole"))) {
        return fail(c, 403, CONNECTORS_ADMIN_ONLY);
      }
      return {
        scope: connectorGitScope(workspaceId, slug),
        userId: c.get("user")?.id,
        workspaceId,
        slug,
      };
    },
    restore: async (connector, sha) => ({
      ...(await restoreConnectorTo({
        workspaceId: connector.workspaceId,
        slug: connector.slug,
        sha,
        actorUserId: connector.userId,
      })),
    }),
  },
);
