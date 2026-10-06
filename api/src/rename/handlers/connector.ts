/**
 * `connector` — a workspace connector folder (`connectors/<slug>/`),
 * referenced by every connection typed `ws:<slug>`. The work is in
 * ../connector.ts. No URL: connectors have no page of their own.
 */
import { RenameError, type RenameHandler } from "../types";
import {
  connectorSlugFromRef,
  renameWorkspaceConnector,
  resolveConnector,
} from "../connector";

export const connectorRenameHandler: RenameHandler = {
  kind: "connector",
  describe:
    "`ref` is the workspace connector's slug (or `ws:<slug>`, or an old slug); `slug` = the new folder slug. Moves connectors/<old>/ to connectors/<new>/ and records the old slug in connector.yaml `aliases` (one commit on main), re-keys the index row in place and moves every connection typed ws:<old> to ws:<new> — old-typed connections keep working through the alias. `title` is read-only (the display name is `defineConnector({ name })` in the connector's code).",
  resolve: resolveConnector,
  async rename(ctx, request) {
    if (!request.slug) {
      throw new RenameError(
        request.title
          ? "A connector's display name is declared in its code (defineConnector({ name })); give `slug` to rename the folder."
          : "Give the new connector slug as slug.",
        400,
      );
    }
    return renameWorkspaceConnector(ctx, {
      from: connectorSlugFromRef(request.ref),
      to: request.slug,
    });
  },
};
