/**
 * A dashboard renamed while it is open — from the tree, another window or
 * the agent (`dashboard.updated`, the rename bumps `version`).
 *
 * The open tab used to ignore it whenever it was being edited or held an
 * unsaved change: it kept the old title (tab label, breadcrumb, JSON) and
 * the old version, so the next Save was refused as "modified by another
 * user", and "Overwrite with my changes" wrote the OLD title back.
 *
 * A rename changes the title and nothing else. When the server copy is the
 * tab's baseline but for its title, the two are folded together: the title
 * and the version from the server, everything else (the user's draft) from
 * the tab. Anything more than a title is a real concurrent change and is
 * left to the save's conflict dialog.
 */
import { computeDashboardStateHash } from "../utils/stateHash";
import type { Dashboard } from "../dashboard-runtime/types";

export interface FoldedRename {
  title: string;
  version: number;
  /** The new saved baseline: the server copy's hash. */
  savedHash: string;
}

/**
 * The fold of `server` into the open `local` copy whose saved baseline
 * hashes to `savedHash`, or null when the server changed more than the
 * title (or the local title was itself edited — both renamed: a conflict).
 */
export function foldRemoteRename(
  local: Dashboard,
  server: Dashboard,
  savedHash: string | undefined,
): FoldedRename | null {
  if (savedHash === undefined) return null;
  if ((server.version ?? 0) <= (local.version ?? 0)) return null;
  // The baseline had the local title (an unedited title): the server copy
  // under that title must BE the baseline.
  const serverUnderLocalTitle = computeDashboardStateHash({
    ...server,
    title: local.title,
  });
  if (serverUnderLocalTitle !== savedHash) return null;
  return {
    title: server.title,
    version: server.version,
    savedHash: computeDashboardStateHash(server),
  };
}
