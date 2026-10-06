import { renameFlow, resolveFlowRef } from "../flow-rename";
import type { RenameHandler } from "../types";

/**
 * Flows: `title` is the display name (`name:` in `flows/<slug>.yml`), `slug`
 * is the file name. The service (../flow-rename.ts) is the one rename path.
 */
export const flowRenameHandler: RenameHandler = {
  kind: "flow",
  describe:
    "flow: `title` = display name (`name:` in flows/<slug>.yml); `slug` = file name — flows/<slug>.yml is moved and the old slug kept in its `aliases:`; the id, /f/<id> URL, inbound webhook URL, checkpoints and run history never change. `ref` = flow id, slug, or an old slug.",
  resolve: resolveFlowRef,
  rename: renameFlow,
};
