/**
 * Identity resolution: which id each discovered folder gets, the incumbent
 * of a contested id, and folders renamed between two commits.
 */
import { runGit } from "../git";
import {
  APPS_DIR,
  APP_MANIFEST,
  USERS_DIR,
  appKeyOf,
  derivedAppId,
  parseAppRepoPath,
} from "../app-paths";
import { AppIndexRow } from "./rows";

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

/**
 * Assign each discovered app its id. Pure; `incumbents` says which path a
 * contested id was last filed under (the previous index or a project row),
 * so a copy never steals the original's identity.
 */
export function assignAppIds(
  workspaceId: string,
  apps: Array<{ path: string; declaredId?: string; treeOid?: string }>,
  incumbents: Map<string, string>,
  unavailableIds: ReadonlySet<string> = new Set(),
  /**
   * Tree oid → id of an UNSTAMPED app whose folder is no longer where the
   * index last saw it. A laptop `git mv` of a legacy app (no `id` in its
   * manifest) keeps the folder's tree oid, and that is the only trace of its
   * identity left in git — without this tier the move reads as a delete plus
   * a brand-new app, and its deployment, share link and env vars are lost.
   * Each entry is consumed once, so a copy never inherits it too.
   */
  treeIncumbents: Map<string, string> = new Map(),
  /**
   * New path → old path for app folders git recognises as renamed between
   * the previously indexed commit and this one (`git diff -M` on the
   * manifests). Catches a legacy app moved AND edited in one push, which
   * neither the path nor the tree oid can match.
   */
  renames: Map<string, string> = new Map(),
): Map<
  string,
  { appId: string; hasManifestId: boolean; duplicateOf?: string }
> {
  const idByPath = new Map([...incumbents].map(([id, path]) => [path, id]));
  for (const [to, from] of renames) {
    const id = idByPath.get(from);
    if (id && !idByPath.has(to)) idByPath.set(to, id);
  }
  const byTree = new Map(treeIncumbents);
  const claims = new Map<string, string[]>();
  const wanted = new Map<string, { id: string; declared: boolean }>();
  for (const app of apps) {
    const derived = derivedAppId(workspaceId, appKeyOf(app.path)).toHexString();
    let id = app.declaredId ?? idByPath.get(app.path);
    if (!id && app.treeOid && byTree.has(app.treeOid)) {
      id = byTree.get(app.treeOid);
      byTree.delete(app.treeOid);
    }
    id ??= derived;
    wanted.set(app.path, { id, declared: !!app.declaredId });
    const list = claims.get(id) ?? [];
    list.push(app.path);
    claims.set(id, list);
  }
  const out = new Map<
    string,
    { appId: string; hasManifestId: boolean; duplicateOf?: string }
  >();
  const taken = new Set<string>([...claims.keys(), ...unavailableIds]);
  for (const [id, paths] of claims) {
    let winner: string | undefined;
    if (unavailableIds.has(id)) {
      winner = undefined;
    } else if (paths.length === 1) {
      winner = paths[0];
    } else {
      // The incumbent path keeps the id; failing that, a path that DECLARES
      // it beats one that merely derives to it; failing that, the first.
      const incumbent = incumbents.get(id);
      winner =
        (incumbent && paths.includes(incumbent) ? incumbent : undefined) ??
        paths.find(p => wanted.get(p)?.declared) ??
        [...paths].sort()[0];
    }
    if (winner) {
      out.set(winner, {
        appId: id,
        hasManifestId: !!wanted.get(winner)?.declared,
      });
    }
    for (const loser of paths) {
      if (loser === winner) continue;
      // File the copy under an id of its own, derived from where it sits, so
      // it keeps working — just not as the original.
      let fallback = derivedAppId(workspaceId, appKeyOf(loser)).toHexString();
      let n = 2;
      while (taken.has(fallback)) {
        fallback = derivedAppId(
          workspaceId,
          `${appKeyOf(loser)}#${n++}`,
        ).toHexString();
      }
      taken.add(fallback);
      out.set(loser, {
        appId: fallback,
        hasManifestId: false,
        duplicateOf: id,
      });
    }
  }
  return out;
}

/**
 * Tree oid → id for the unstamped apps among `rows` whose path is not in
 * `presentPaths`: the identities a laptop `git mv` can only be matched to by
 * content. Ambiguous oids (two vanished folders with identical trees) are
 * left out rather than guessed.
 */
export function treeIncumbentsOf(
  rows: Array<
    Pick<AppIndexRow, "appId" | "path" | "treeOid" | "hasManifestId">
  >,
  presentPaths: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (row.hasManifestId || presentPaths.has(row.path)) continue;
    if (out.has(row.treeOid)) ambiguous.add(row.treeOid);
    out.set(row.treeOid, row.appId);
  }
  for (const oid of ambiguous) out.delete(oid);
  return out;
}

/**
 * App folders git sees as RENAMED between two commits, by their manifests:
 * new app path → old app path. `-M` matches on content similarity, so a
 * manifest that moved untouched (or nearly) is found even when the rest of
 * the app changed in the same commit. Empty when either commit is unknown.
 */
export async function renamedAppFolders(
  repoDir: string,
  from: string,
  to: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!from || !to || from === to) return out;
  let stdout: string;
  try {
    ({ stdout } = await runGit(
      [
        "-C",
        repoDir,
        "diff",
        "--name-status",
        "-M",
        "-z",
        "--diff-filter=R",
        from,
        to,
        "--",
        APPS_DIR,
        USERS_DIR,
      ],
      { timeoutMs: 60_000 },
    ));
  } catch {
    return out;
  }
  const fields = stdout.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [status, oldPath, newPath] = [
      fields[i],
      fields[i + 1],
      fields[i + 2],
    ];
    if (!status.startsWith("R")) continue;
    const suffix = `/${APP_MANIFEST}`;
    if (!oldPath.endsWith(suffix) || !newPath.endsWith(suffix)) continue;
    const oldDir = oldPath.slice(0, -suffix.length);
    const newDir = newPath.slice(0, -suffix.length);
    if (parseAppRepoPath(oldDir) && parseAppRepoPath(newDir)) {
      out.set(newDir, oldDir);
    }
  }
  return out;
}

/** Is the commit in this repo's object store? */
export async function commitExists(
  repoDir: string,
  sha: string,
): Promise<boolean> {
  return runGit(["-C", repoDir, "cat-file", "-e", `${sha}^{commit}`])
    .then(() => true)
    .catch(() => false);
}

/** Is `ancestor` reachable from `descendant`? False when either is unknown here. */
export async function isAncestor(
  repoDir: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  if (ancestor === descendant) return true;
  return runGit([
    "-C",
    repoDir,
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ])
    .then(() => true)
    .catch(() => false);
}
