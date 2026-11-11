/**
 * Flow rename handler (see ../types.ts for the contract, and
 * ../slug-file-rename.ts for the service flows share with dbt jobs).
 *
 * A flow is `flows/<slug>.yml` at main plus a row that carries its runtime:
 * CDC checkpoints, executions, webhook events, the inbound webhook URL, its
 * secret and provider subscription, the schedules and their claims. `title`
 * rewrites `name:`; `slug` moves the file and re-keys that row in place, so
 * `/f/<id>` and everything else keyed by the id stay as they are.
 *
 * Who may rename is what `PUT /flows/:id` takes (it already renames the
 * display name): access to the workspace, which every caller of the
 * registry has established. The agent tool adds the flow write tools' own
 * gate on top (rename-capabilities.ts).
 */
import { Types } from "mongoose";
import { Flow } from "../../database/workspace-schema";
import { flowFilePath } from "../../services/flow-config-files";
import {
  ensureFlowDerivedCache,
  loadLiveFlows,
} from "../../services/flow-sync.service";
import {
  renameSlugFile,
  resolveSlugRef,
  type SlugRenameDeps,
} from "../slug-file-rename";
import { FLOW_FILES } from "../slug-files";
import type { RenameContext, RenameHandler } from "../types";

function flowDeps(ctx: RenameContext): SlugRenameDeps {
  const { workspaceId } = ctx;
  return {
    scope: { workspaceId: new Types.ObjectId(workspaceId) },
    locate: row => ({
      title: row.name ?? row.slug,
      slug: row.slug,
      path: row.slug ? flowFilePath(row.slug) : undefined,
      url: `/f/${String(row._id)}`,
    }),
    async gitOnly(ref) {
      const live = (await loadLiveFlows(workspaceId)).find(
        item => !item.row && (item.def.slug === ref || String(item.id) === ref),
      );
      if (!live) return null;
      const id = String(live.id);
      return {
        id,
        current: {
          title: live.def.parsed?.name ?? live.def.slug,
          slug: live.def.slug,
          path: live.def.path,
          url: `/f/${id}`,
        },
      };
    },
    async resync(id) {
      const row = await Flow.findById(id);
      if (!row) return true;
      const status = await ensureFlowDerivedCache(row);
      return status === "ok" || status === "resynced";
    },
  };
}

export const flowRenameHandler: RenameHandler = {
  kind: "flow",
  describe:
    "`title` = display name (`name:` in flows/<slug>.yml); `slug` = file name: the file is moved and the old slug kept in its `aliases:`, so the old name still resolves. The id, /f/<id>, CDC checkpoints, run history and the webhook URL, secret and subscription do not change, and nothing is backfilled again. `ref` = flow id, slug, or an old slug. Owner or admin.",
  resolve: (ctx, ref) => resolveSlugRef(FLOW_FILES, flowDeps(ctx), ref),
  rename: (ctx, request) =>
    renameSlugFile(FLOW_FILES, flowDeps(ctx), ctx, request),
};
