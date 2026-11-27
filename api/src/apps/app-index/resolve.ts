/**
 * Resolving an app ref (id, path, slug) against the index, live or from the
 * persisted rows, now or at an older commit.
 */
import { parseEntityId } from "../../database/pg/id-codec";
import { appsMetadataRepo } from "../../repositories/apps-metadata";
import { freshenForServe } from "../cloud-repo.service";
import { APPS_DIR, isAppId } from "../app-paths";
import { AppIndexRow, AppsIndexSnapshot } from "./rows";
import { readAppsAt } from "./discovery";
import { assignAppIds, treeIncumbentsOf, renamedAppFolders } from "./identity";
import { rowToIndex, loadAppsIndex } from "./sync";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Find an app by whatever a caller has: its id, its repo path (`apps/x/y`,
 * with or without a leading `apps/`), or its slug. A slug that several apps
 * share resolves to the top-level `apps/<slug>` if there is one, otherwise
 * to nothing — an ambiguous name must not silently pick a folder.
 */
export function findAppInSnapshot(
  snapshot: AppsIndexSnapshot,
  ref: string,
): AppIndexRow | null {
  const clean = ref.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return null;
  if (isAppId(clean)) {
    const byId = snapshot.apps.find(a => a.appId === clean.toLowerCase());
    if (byId) return byId;
  }
  if (clean.includes("/")) {
    return (
      snapshot.apps.find(a => a.path === clean) ??
      snapshot.apps.find(a => a.path === `${APPS_DIR}/${clean}`) ??
      null
    );
  }
  const matches = snapshot.apps.filter(a => a.slug === clean);
  if (matches.length === 1) return matches[0];
  return matches.find(a => a.path === `${APPS_DIR}/${clean}`) ?? null;
}

/**
 * Resolve a ref against the index, fetching the mirror once on a miss when
 * asked: the read-after-push contract for every app_* tool — a folder pushed
 * a moment ago to another API instance resolves here on the first call.
 */
export async function resolveAppRef(
  workspaceId: string,
  ref: string,
  options: { fetchOnMiss?: boolean } = {},
): Promise<AppIndexRow | null> {
  let found = findAppInSnapshot(await loadAppsIndex(workspaceId), ref);
  if (!found && options.fetchOnMiss) {
    await freshenForServe(workspaceId, 0);
    found = findAppInSnapshot(
      await loadAppsIndex(workspaceId, { freshen: false }),
      ref,
    );
  }
  return found;
}

/** Every app row as persisted for a workspace (no git). */
export async function loadIndexedApps(
  workspaceId: string,
): Promise<AppIndexRow[]> {
  if (!parseEntityId(workspaceId)) return [];
  const rows = await appsMetadataRepo.listIndexEntriesByWorkspace(workspaceId);
  return rows.map(rowToIndex);
}

/**
 * Resolve a ref against the index rows as persisted — no git at
 * all. For hot public paths (link-preview images, card thumbnails) that must
 * not pay a mirror clone on a fresh instance: the rows are written by
 * whichever instance last synced main, so they are at most one sync behind.
 * Null when the ref is unknown there (callers fall back to resolveAppRef).
 */
export async function resolveIndexedAppRef(
  workspaceId: string,
  ref: string,
): Promise<AppIndexRow | null> {
  if (!parseEntityId(workspaceId)) return null;
  const clean = ref.trim().toLowerCase();
  if (isAppId(clean)) {
    const row = await appsMetadataRepo.findIndexEntryByAppId(
      clean,
      workspaceId,
    );
    if (row) return rowToIndex(row);
  }
  const rows = await appsMetadataRepo.listIndexEntriesByWorkspace(workspaceId);
  return findAppInSnapshot(
    { sha: "", apps: rows.map(rowToIndex), folders: [] },
    ref,
  );
}

/** Resolve historical folders using the same identities as the current index. */
export async function readIndexedAppsAt(
  workspaceId: string,
  repoDir: string,
  sha: string,
): Promise<Array<{ appId: string; path: string; treeOid: string }>> {
  const [read, now, projects] = await Promise.all([
    readAppsAt(repoDir, sha),
    loadAppsIndex(workspaceId),
    appsMetadataRepo.listProjectsByWorkspace(workspaceId),
  ]);
  const incumbents = new Map(now.apps.map(a => [a.appId, a.path]));
  for (const p of projects) {
    incumbents.set(p.id, p.path ?? `apps/${p.slug}`);
  }
  // Copies keep the derived identity assigned by the current index.
  const ids = assignAppIds(
    workspaceId,
    read.apps.map(a => ({
      path: a.path,
      declaredId:
        now.apps.find(
          n =>
            n.path === a.path &&
            n.duplicateOf === read.manifests.get(a.path)?.id,
        )?.appId ?? read.manifests.get(a.path)?.id,
      treeOid: a.treeOid,
    })),
    incumbents,
    new Set(),
    // An unstamped app the current index files elsewhere: at this older
    // commit its folder sat at the old path with the same tree oid.
    treeIncumbentsOf(now.apps, new Set(read.apps.map(a => a.path))),
    // …or under a name git recognises as the old one of a current folder.
    new Map(
      [...(await renamedAppFolders(repoDir, sha, now.sha))].map(
        ([newPath, oldPath]) => [oldPath, newPath],
      ),
    ),
  );
  return read.apps.map(a => {
    const identity = ids.get(a.path);
    if (!identity) {
      throw new Error(`Missing resolved app identity for ${a.path}`);
    }
    return {
      appId: identity.appId,
      path: a.path,
      treeOid: a.treeOid,
    };
  });
}
