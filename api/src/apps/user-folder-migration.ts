/**
 * The one-off move of personal trees from `users/<userId>/` to
 * `users/<handle>/` (user-handles.ts), as a pure plan over a tree listing.
 * The script in scripts/migrate-user-folders-to-handles.ts executes it: one
 * commit on main, then the Mongo rows whose stored paths embed the old
 * prefix. Nothing here touches git or Mongo.
 */
import { USERS_DIR } from "./app-paths";
import { isHandle, type HandleRow } from "./user-handles";

export interface FolderRename {
  userId: string;
  handle: string;
  from: string;
  to: string;
  /** Every committed file under `from`, with where it goes. */
  files: Array<{ from: string; to: string }>;
}

export interface UserFolderPlan {
  renames: FolderRename[];
  /** Folders already named by their owner's handle. */
  alreadyHandles: string[];
  /** `users/<x>/` whose segment is nobody's id and nobody's handle. */
  orphans: string[];
  /** A rename whose target file already exists: left alone, needs a human. */
  conflicts: Array<{ from: string; to: string; files: string[] }>;
}

/** The `users/<segment>` folders present in a list of file paths. */
export function userSegments(filePaths: string[]): string[] {
  const out = new Set<string>();
  for (const p of filePaths) {
    const parts = p.split("/");
    if (parts[0] === USERS_DIR && parts.length >= 3 && parts[1]) {
      out.add(parts[1]);
    }
  }
  return [...out].sort();
}

/**
 * Plan the renames. `handles` is the complete mapping the migration will
 * write (existing rows plus the ones it assigns). A segment that is a
 * handle stays; a segment that is a userId with a handle moves; anything
 * else is reported, never guessed at.
 */
export function planUserFolderRenames(
  filePaths: string[],
  handles: HandleRow[],
): UserFolderPlan {
  const handleOf = new Map(handles.map(h => [h.userId, h.handle]));
  const isAHandle = new Set(handles.map(h => h.handle));
  const present = new Set(filePaths);
  const plan: UserFolderPlan = {
    renames: [],
    alreadyHandles: [],
    orphans: [],
    conflicts: [],
  };
  for (const segment of userSegments(filePaths)) {
    const from = `${USERS_DIR}/${segment}`;
    const handle = handleOf.get(segment);
    if (handle === undefined || handle === segment) {
      if (isAHandle.has(segment)) plan.alreadyHandles.push(from);
      else plan.orphans.push(from);
      continue;
    }
    if (!isHandle(handle)) {
      plan.conflicts.push({ from, to: `${USERS_DIR}/${handle}`, files: [] });
      continue;
    }
    const to = `${USERS_DIR}/${handle}`;
    const files = filePaths
      .filter(p => p.startsWith(`${from}/`))
      .map(p => ({ from: p, to: `${to}${p.slice(from.length)}` }));
    const clashing = files.filter(f => present.has(f.to)).map(f => f.to);
    if (clashing.length > 0) {
      plan.conflicts.push({ from, to, files: clashing });
      continue;
    }
    plan.renames.push({ userId: segment, handle, from, to, files });
  }
  return plan;
}

/**
 * A stored repo path under a renamed folder, rewritten; null when the path
 * is not under any of them.
 */
export function rewriteUserPath(
  path: string | null | undefined,
  renames: Array<Pick<FolderRename, "from" | "to">>,
): string | null {
  if (!path) return null;
  for (const r of renames) {
    if (path === r.from) return r.to;
    if (path.startsWith(`${r.from}/`)) {
      return `${r.to}${path.slice(r.from.length)}`;
    }
  }
  return null;
}
