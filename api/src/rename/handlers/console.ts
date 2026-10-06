/**
 * Console rename handler (see ../types.ts for the contract).
 *
 * A console is addressed by its Mongo id (`/c/<id>`) and lives in the
 * workspace repo as `consoles/<folders>/<name>.<ext>` (or under
 * `users/<owner>/consoles/` when private) — the FILE NAME IS THE TITLE, the
 * folder chain is the location. So:
 *
 *   title → the new file name, same folder (rename in place);
 *   slug  → the full repo path, or `<folders>/<name>`, to MOVE it — folders
 *           are created on demand; a `users/<me>/consoles/…` path flips it
 *           private, `consoles/…` makes it workspace-visible (owner only).
 *
 * No alias is recorded: every link, share, schedule and favourite carries
 * the id, which `relocateConsole` never changes. One commit per rename
 * (the old file is removed in the same commit).
 */
import { Types } from "mongoose";
import {
  SavedConsole,
  type ConsoleAccessLevel,
  type ISavedConsole,
} from "../../database/workspace-schema";
import {
  ConsoleManager,
  ConsoleConflictError,
  ConsoleScopeError,
} from "../../utils/console-manager";
import {
  ensureFolderChain,
  folderSegmentsFor,
  listConsoleDefinitionsAtMain,
  loadLiveConsoles,
  repoPathForRow,
  rowScope,
  syncConsolesIndexFromRepo,
  type LiveConsole,
} from "../../apps/workspace-consoles.service";
import {
  consoleRepoPath,
  parseConsoleRepoPath,
  splitConsoleFileName,
  type ConsoleLanguage,
} from "../../apps/console-files";
import {
  RenameError,
  type RenameContext,
  type RenameHandler,
  type RenameLocation,
  type ResolvedRef,
} from "../types";

const consoleManager = new ConsoleManager();

function isAdmin(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

function canRead(row: ISavedConsole, ctx: RenameContext): boolean {
  // A workspace API key has no per-user ACL (server-console-tools parity).
  if (!ctx.userId) return true;
  return ConsoleManager.canRead(row, ctx.userId, ctx.role);
}

function canWrite(row: ISavedConsole, ctx: RenameContext): boolean {
  if (!ctx.userId) return true;
  return ConsoleManager.canWrite(row, ctx.userId, isAdmin(ctx.role), ctx.role);
}

/** A file-only console (no row yet) is readable like its path says. */
function fileReadable(live: LiveConsole, ctx: RenameContext): boolean {
  if (live.row) return canRead(live.row, ctx);
  if (!ctx.userId) return true;
  return (
    live.location.scope === "workspace" || live.location.ownerId === ctx.userId
  );
}

function urlFor(id: string): string {
  return `/c/${id}`;
}

async function locationOfRow(row: ISavedConsole): Promise<RenameLocation> {
  const path = row.path ?? (await repoPathForRow(row));
  return { title: row.name, slug: path, path, url: urlFor(row._id.toString()) };
}

/**
 * The row for `ref`: an id, a repo path, or a name (`Team/report`,
 * `report`) that exactly ONE readable console answers to. A file that has
 * no index row yet (pushed, not synced) is synced on demand so a rename can
 * proceed on a real row.
 */
async function findRow(
  ctx: RenameContext,
  ref: string,
): Promise<ISavedConsole | null> {
  const ws = new Types.ObjectId(ctx.workspaceId);
  if (Types.ObjectId.isValid(ref)) {
    const row = await SavedConsole.findOne({
      _id: new Types.ObjectId(ref),
      workspaceId: ws,
      is_deleted: { $ne: true },
    });
    return row && canRead(row, ctx) ? row : null;
  }

  const live = (await loadLiveConsoles(ctx.workspaceId)).filter(item =>
    fileReadable(item, ctx),
  );
  const clean = ref.replace(/^\/+|\/+$/g, "");
  // A ref that names a folder must match that folder: "Archive/report"
  // is not an alias for the only "Live/report". Only a bare name may fall
  // back to a leaf match.
  const bare = !clean.includes("/");
  const matches = live.filter(item => {
    if (item.path === clean) return true;
    const folders = item.location.folderSegments.join("/");
    const named = folders
      ? `${folders}/${item.location.name}`
      : item.location.name;
    return named === clean || (bare && item.location.name === clean);
  });
  // Prefer the exact path / folder-qualified matches over bare-name ones;
  // a bare name that several consoles share resolves to nothing.
  const exact = matches.filter(
    item =>
      item.path === clean ||
      [...item.location.folderSegments, item.location.name].join("/") === clean,
  );
  const chosen =
    exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
  if (!chosen) return null;
  if (chosen.row) return chosen.row;
  // Pushed but not yet indexed: let the sync mint the row, then take the
  // row AT THAT PATH — never "the row with the derived id", which a
  // renamed git-born console may still hold at another path. The sync
  // runs WITHOUT an actor (owner "git", as the push hook does for files
  // with no known pusher): a lookup must not make the reader the owner of
  // every unindexed console in the workspace. Whether the caller may then
  // rename a git-born console is the row's ordinary write rule.
  await syncConsolesIndexFromRepo(ctx.workspaceId).catch(() => null);
  return SavedConsole.findOne({
    workspaceId: ws,
    path: chosen.path,
    isSaved: true,
    is_deleted: { $ne: true },
  });
}

interface Target {
  name: string;
  folderSegments: string[];
  scope: "workspace" | "private";
  ownerId?: string;
  language: ConsoleLanguage;
}

/** Where `title`/`slug` say the console should live, validated. */
function targetFor(
  row: ISavedConsole,
  currentSegments: string[],
  title: string | undefined,
  slug: string | undefined,
): Target {
  const current = rowScope(row);
  const language: ConsoleLanguage =
    row.language === "javascript" || row.language === "mongodb"
      ? row.language
      : "sql";
  const target: Target = {
    name: row.name,
    folderSegments: currentSegments,
    scope: current.scope,
    ownerId: current.ownerId,
    language,
  };

  if (slug !== undefined) {
    const clean = slug.trim().replace(/^\/+|\/+$/g, "");
    if (!clean) throw new RenameError("Give a non-empty slug (path).");
    const parsed = parseConsoleRepoPath(clean);
    if (parsed) {
      target.scope = parsed.scope;
      target.ownerId = parsed.ownerId;
      target.folderSegments = parsed.folderSegments;
      target.name = parsed.name;
      target.language = parsed.language;
    } else {
      const segments = clean.split("/");
      const file = segments.pop() ?? "";
      const split = splitConsoleFileName(file);
      target.folderSegments = segments;
      target.name = split?.name ?? file;
      target.language = split?.language ?? language;
    }
    if (target.language !== language) {
      throw new RenameError(
        `A console's language is its file extension; keep .${language === "sql" ? "sql" : language === "javascript" ? "js" : "mongodb.js"} or create a new console.`,
      );
    }
  }
  if (title !== undefined) {
    const clean = title.trim();
    if (!clean) throw new RenameError("Give a non-empty title.");
    if (clean.includes("/")) {
      throw new RenameError(
        "A title is the file name; use `slug` (a path) to move a console into a folder.",
      );
    }
    if (slug !== undefined && target.name !== clean) {
      throw new RenameError("`title` and the file name in `slug` disagree.");
    }
    target.name = clean;
  }
  if (target.folderSegments.some(s => !s.trim() || s === "." || s === "..")) {
    throw new RenameError("Invalid folder path.");
  }
  return target;
}

export const consoleRenameHandler: RenameHandler = {
  kind: "console",
  describe:
    "console: `title` = new file name (shown in the tree; no `/`); `slug` = repo path to move it (`consoles/Team/report.sql`, `Team/report`, or `users/<you>/consoles/…` to make it private). Links use `/c/<id>` and never break.",

  async resolve(ctx, ref): Promise<ResolvedRef | null> {
    const row = await findRow(ctx, ref);
    if (!row) return null;
    return {
      kind: "console",
      id: row._id.toString(),
      via: "current",
      current: await locationOfRow(row),
    };
  },

  async rename(ctx, request) {
    const row = await findRow(ctx, request.ref);
    if (!row) throw new RenameError("Console not found", 404);
    if (!canWrite(row, ctx)) {
      throw new RenameError("Cannot rename a read-only console", 403);
    }
    const before = await locationOfRow(row);
    const currentSegments = await folderSegmentsFor(
      row.folderId,
      ctx.workspaceId,
    );
    const target = targetFor(row, currentSegments, request.title, request.slug);
    const current = rowScope(row);

    // Re-scoping (private ↔ workspace) is the owner's call, as in
    // updateConsoleAccess; a private path must be the caller's own.
    let access: ConsoleAccessLevel | undefined;
    if (target.scope !== current.scope || target.ownerId !== current.ownerId) {
      const ownerId = (row.owner_id || row.createdBy)?.toString();
      if (ctx.userId && ownerId !== ctx.userId) {
        throw new RenameError(
          "Only the owner can move a console between private and workspace.",
          403,
        );
      }
      if (target.scope === "private" && target.ownerId !== ownerId) {
        throw new RenameError(
          "A private console can only live under its owner's folder.",
          403,
        );
      }
      access = target.scope;
    }

    const wantedPath = consoleRepoPath({
      scope: target.scope,
      ownerId: target.ownerId,
      folderSegments: target.folderSegments,
      name: target.name,
      language: target.language,
    });
    if (wantedPath === before.path) {
      // The documented short form (`Team/report`) of the console's current
      // place: the same "nothing to do" the registry answers for the full
      // path and for an unchanged title — never a refusal.
      return {
        kind: "console",
        id: row._id.toString(),
        before,
        after: before,
        aliasesAdded: [],
        warnings: ["Nothing to change: it already has that name."],
      };
    }
    const [defs, taken] = await Promise.all([
      listConsoleDefinitionsAtMain(ctx.workspaceId),
      SavedConsole.findOne({
        workspaceId: new Types.ObjectId(ctx.workspaceId),
        path: wantedPath,
        _id: { $ne: row._id },
        is_deleted: { $ne: true },
      }).select("_id"),
    ]);
    if (taken || defs.some(d => d.path === wantedPath)) {
      throw new RenameError(`${wantedPath} already exists`, 409);
    }

    const folderChanged =
      target.folderSegments.join("/") !== currentSegments.join("/") ||
      access !== undefined;
    const folderId = folderChanged
      ? ((
          await ensureFolderChain(target.folderSegments, ctx.workspaceId, {
            access: target.scope === "private" ? "private" : "workspace",
            ownerId: target.ownerId ?? (row.owner_id || row.createdBy),
          })
        )?.toString() ?? null)
      : undefined;

    let moved: Awaited<ReturnType<typeof consoleManager.relocateConsole>>;
    try {
      moved = await consoleManager.relocateConsole(
        row._id.toString(),
        ctx.workspaceId,
        {
          name: target.name !== row.name ? target.name : undefined,
          folderId,
          access,
        },
        { userId: ctx.userId, verb: folderChanged ? "move" : "rename" },
      );
    } catch (error) {
      // The guarantee is the commit itself: relocateConsole's write is a
      // compare-and-swap on the source and target blobs, so a rename that
      // lost a race (or a laptop push that landed the target) is refused
      // there. The pre-check above only gives a clearer message earlier.
      if (error instanceof ConsoleConflictError) {
        throw new RenameError(error.message, 409);
      }
      if (error instanceof ConsoleScopeError) {
        throw new RenameError(error.message, 403);
      }
      throw error;
    }
    if (!moved) throw new RenameError("Console not found", 404);

    const warnings: string[] = [];
    if (!moved.row.isSaved) {
      warnings.push(
        "This console is a draft: it was renamed in the index and reaches the repo on its first save.",
      );
    }
    return {
      kind: "console",
      id: row._id.toString(),
      before,
      after: await locationOfRow(moved.row),
      aliasesAdded: [],
      commit: moved.commit,
      warnings,
    };
  },
};
