/**
 * Console rename handler (see ../types.ts for the contract).
 *
 * A console is addressed by its id (`/c/<id>`) and lives in the workspace
 * repo as `consoles/<folders>/<name>.<ext>`, or under
 * `users/<handle>/consoles/` when private: the FILE NAME IS THE TITLE and
 * the folder chain is the location. So:
 *
 *   title → a new file name in the same folder. Characters a file name
 *           cannot carry get a stand-in ("Q1: revenue" is saved as
 *           "Q1 - revenue") and the result says so;
 *   slug  → where to MOVE it: `Folder/Sub/name`, or a repo path
 *           (`consoles/Team/report.sql`; `users/<owner>/consoles/…` makes
 *           it private). Folders are created on demand.
 *
 * No alias is recorded: links, shares, schedules and favourites carry the
 * id, which never changes. The work is `ConsoleManager.relocateConsole` —
 * the service the explorer and the REST routes use — so the rules are the
 * same on every surface: one compare-and-swap commit of the file as it is
 * on main, 409 when the target is taken, and a change of who can see the
 * console only by its owner or a workspace admin.
 */
import { Types } from "mongoose";
import { cleanedConsoleName } from "@mako/schemas";
import {
  SavedConsole,
  type ConsoleAccessLevel,
  type ISavedConsole,
} from "../../database/workspace-schema";
import {
  ConsoleConflictError,
  ConsoleManager,
  ConsoleNameError,
  ConsoleScopeError,
  type ConsoleChange,
} from "../../utils/console-manager";
import {
  loadLiveConsoleById,
  loadLiveConsoles,
  repoPathForRow,
  syncConsolesIndexFromRepo,
  type LiveConsole,
} from "../../apps/workspace-consoles.service";
import {
  cleanConsoleName,
  consoleExtension,
  parseConsoleRepoPath,
  splitConsoleFileName,
} from "../../apps/console-files";
import { ownerDirectoryFor } from "../../apps/user-handles.service";
import { normalizeDisplayName } from "../title-rules";
import {
  RenameError,
  type RenameContext,
  type RenameHandler,
  type RenameLocation,
  type ResolvedRef,
} from "../types";

const consoleManager = new ConsoleManager();

const isAdmin = (role: string | undefined) =>
  role === "owner" || role === "admin";

// A workspace API key has no person behind it: no per-user ACL.
function canRead(row: ISavedConsole, ctx: RenameContext): boolean {
  return !ctx.userId || ConsoleManager.canRead(row, ctx.userId, ctx.role);
}

function canWrite(row: ISavedConsole, ctx: RenameContext): boolean {
  return (
    !ctx.userId ||
    ConsoleManager.canWrite(row, ctx.userId, isAdmin(ctx.role), ctx.role)
  );
}

/** A pushed file with no row yet is readable as its path says. */
function fileReadable(live: LiveConsole, ctx: RenameContext): boolean {
  if (live.row) return canRead(live.row, ctx);
  return (
    !ctx.userId ||
    live.location.scope === "workspace" ||
    live.location.ownerId === ctx.userId
  );
}

async function locationOf(row: ISavedConsole): Promise<RenameLocation> {
  const path = row.path ?? (await repoPathForRow(row));
  return { title: row.name, slug: path, path, url: `/c/${row._id.toString()}` };
}

/** The live row at `path`, indexing a pushed file first when it has none. */
async function rowAtPath(
  ctx: RenameContext,
  live: LiveConsole,
): Promise<ISavedConsole | null> {
  if (live.row) return live.row;
  // No actor: a lookup must not make the caller the owner of every
  // console the index has not seen.
  await syncConsolesIndexFromRepo(ctx.workspaceId).catch(() => null);
  return SavedConsole.findOne({
    workspaceId: new Types.ObjectId(ctx.workspaceId),
    path: live.path,
    isSaved: true,
    is_deleted: { $ne: true },
  });
}

/**
 * The console `ref` names: an id, a repo path, `Folder/name`, or a bare
 * name exactly ONE readable console has. Null when none or several do.
 */
async function findRow(
  ctx: RenameContext,
  ref: string,
): Promise<ISavedConsole | null> {
  if (Types.ObjectId.isValid(ref)) {
    const hit = await loadLiveConsoleById(ctx.workspaceId, ref);
    if (!hit) return null;
    const row = "draft" in hit ? hit.draft : await rowAtPath(ctx, hit.live);
    return row && !row.is_deleted && canRead(row, ctx) ? row : null;
  }
  const wanted = ref.normalize("NFC").replace(/^\/+|\/+$/g, "");
  const live = (await loadLiveConsoles(ctx.workspaceId)).filter(item =>
    fileReadable(item, ctx),
  );
  const named = (item: LiveConsole) =>
    [...item.location.folderSegments, item.location.name].join("/");
  // A ref that names a folder must match that folder; only a bare name
  // may match by its last segment.
  const exact = live.filter(i => i.path === wanted || named(i) === wanted);
  const loose = wanted.includes("/")
    ? []
    : live.filter(i => i.location.name === wanted);
  const chosen =
    exact.length === 1 ? exact[0] : loose.length === 1 ? loose[0] : null;
  return chosen ? rowAtPath(ctx, chosen) : null;
}

/** What `title` and `slug` ask of the console, as a relocation. */
async function changeFor(
  ctx: RenameContext,
  row: ISavedConsole,
  title: string | undefined,
  slug: string | undefined,
): Promise<ConsoleChange> {
  if (slug === undefined) return { name: title };
  const clean = slug
    .trim()
    .normalize("NFC")
    .replace(/^\/+|\/+$/g, "");
  if (!clean) throw new RenameError("Give a non-empty slug (path).");
  const ownerId = (row.owner_id || row.createdBy)?.toString();
  const extension = consoleExtension(row.language);
  let segments = clean.split("/");
  let access: ConsoleAccessLevel | undefined;

  if (/^(consoles|users)(\/|$)/.test(clean)) {
    const file = segments[segments.length - 1];
    const parsed = parseConsoleRepoPath(
      splitConsoleFileName(file) ? clean : `${clean}${extension}`,
    );
    if (!parsed) {
      throw new RenameError(
        "A full path is `consoles/<folders>/<name>` or `users/<owner>/consoles/<folders>/<name>`.",
      );
    }
    if (parsed.scope === "private") {
      const directory = await ownerDirectoryFor(ctx.workspaceId, ownerId);
      if (directory.handleOf(ownerId) !== parsed.ownerHandle) {
        throw new RenameError(
          "A private console can only live under its owner's folder.",
          403,
        );
      }
    }
    access = parsed.scope;
    segments = [
      ...parsed.folderSegments,
      `${parsed.name}${consoleExtension(parsed.language)}`,
    ];
  }

  const file = segments.pop() ?? "";
  const split = splitConsoleFileName(file);
  if (split && split.language !== row.language) {
    throw new RenameError(
      `A console's language is its file extension: keep ${extension}, or create a new console.`,
    );
  }
  const name = split?.name ?? file;
  if (title !== undefined && cleanedConsoleName(title) !== name) {
    throw new RenameError("`title` and the file name in `slug` disagree.");
  }
  // The name is judged before any folder is created for it.
  if (cleanedConsoleName(name) !== row.name) {
    cleanConsoleName(name, "console", row.language);
  }
  const folderId =
    segments.length === 0
      ? null
      : ((await consoleManager.findOrCreateFolderPath(
          segments,
          ctx.workspaceId,
          ctx.userId ?? ownerId ?? "",
        )) ?? null);
  return { name, folderId, access };
}

/** A refusal of the service, as the rename contract reports it. */
function asRenameError(error: unknown): unknown {
  if (
    error instanceof ConsoleNameError ||
    error instanceof ConsoleScopeError ||
    error instanceof ConsoleConflictError
  ) {
    return new RenameError(error.message, error.status);
  }
  return error;
}

export const consoleRenameHandler: RenameHandler = {
  kind: "console",
  describe:
    "console: `title` = new file name (shown in the tree; characters a file name cannot carry are replaced, and the result says with what); `slug` = where to move it: `Folder/name`, or a repo path (`consoles/Team/report.sql`, `users/<owner>/consoles/…` to make it private). Links use `/c/<id>` and never break.",

  async resolve(ctx, ref): Promise<ResolvedRef | null> {
    const row = await findRow(ctx, ref);
    if (!row) return null;
    return {
      kind: "console",
      id: row._id.toString(),
      via: "current",
      current: await locationOf(row),
    };
  },

  async rename(ctx, request) {
    const row = await findRow(ctx, request.ref);
    if (!row) throw new RenameError("Console not found", 404);
    if (!canWrite(row, ctx)) {
      throw new RenameError("Cannot rename a read-only console", 403);
    }
    const before = await locationOf(row);
    let moved: Awaited<ReturnType<typeof consoleManager.relocateConsole>>;
    try {
      const change = await changeFor(ctx, row, request.title, request.slug);
      moved = await consoleManager.relocateConsole(
        row._id.toString(),
        ctx.workspaceId,
        change,
        {
          userId: ctx.userId,
          isAdmin: isAdmin(ctx.role),
          verb: request.slug === undefined ? "rename" : "move",
        },
      );
    } catch (error) {
      throw asRenameError(error);
    }
    // A delete took it while it was being renamed.
    if (!moved) throw new RenameError("Console not found", 404);

    const after = await locationOf(moved.row);
    const warnings: string[] = [];
    if (after.path === before.path && after.title === before.title) {
      warnings.push("Nothing to change: it already has that name.");
    }
    const asked =
      request.title === undefined
        ? undefined
        : normalizeDisplayName(request.title);
    if (asked !== undefined && after.title !== asked) {
      warnings.push(
        `Saved as “${after.title}”: a file name cannot carry every character of “${asked}”.`,
      );
    }
    if (!moved.row.isSaved) {
      warnings.push(
        "This console is a draft: it was renamed in the index and reaches the repo on its first save.",
      );
    }
    return {
      kind: "console",
      id: row._id.toString(),
      before,
      after,
      aliasesAdded: [],
      commit: moved.commit,
      warnings,
    };
  },
};
