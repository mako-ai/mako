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
    "`ref` is the workspace connector's slug (or `ws:<slug>`, or an old slug); `slug` = the new folder slug. Moves connectors/<old>/ to connectors/<new>/ and records the old slug in connector.yaml `aliases` (one commit on main), re-keys the index row in place (same id) and moves the connections bound to it from ws:<old> to ws:<new>; connections are bound to the connector by id, so they keep working. `ref` may also be the connector's id. `title` is read-only (the display name is `defineConnector({ name })` in the connector's code).",
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
    // Its own slug in another spelling (`ws:acme`) is the registry's no-op
    // answer, the same for every kind — not a 400.
    const current = await resolveConnector(ctx, request.ref);
    if (
      current &&
      connectorSlugFromRef(request.slug) === current.current.slug
    ) {
      return {
        kind: "connector",
        id: current.id,
        before: current.current,
        after: current.current,
        aliasesAdded: [],
        warnings: ["Nothing to change: it already has that name."],
      };
    }
    return renameWorkspaceConnector(ctx, {
      from: connectorSlugFromRef(request.ref),
      to: request.slug,
    });
  },
};
