/**
 * Renaming a flow or a dbt job — one service for both (see ./types.ts for
 * the contract and ./slug-files.ts for what the two kinds share).
 *
 *  - `title` rewrites `name:` in the file.
 *  - `slug` moves the file AND lists the slug it left under `aliases:`, in
 *    ONE commit, then re-keys the row in place: same `_id`, so everything
 *    keyed by it (checkpoints, run history, the webhook URL, secret and
 *    provider subscription, the schedule and its claim) is untouched.
 *
 * The commit is a compare-and-swap on the file itself: it applies only if
 * the file is still the one read and the new path is still free, so a save,
 * a delete or another rename that lands first refuses this one instead of
 * leaving two files behind. Saves and deletes hold the same line from their
 * side (`currentFileOf`).
 *
 * The file is the store, so the commit IS the rename. The mirror push is
 * queued like every other write to main, never awaited. Until it lands,
 * other instances read a tree without the commit: the row's rename guard
 * (`lastRenameCommit`) keeps them from tearing the row down or creating a
 * second one from the old file. If the row update itself fails, the next
 * read or sync pairs the row with the moved file (its `aliases:` names the
 * row's slug) and re-keys it then.
 */
import { Types } from "mongoose";

import { RepoRequiredError } from "../apps/config";
import {
  freshenBeforeMainWrite,
  queueMirrorPush,
} from "../apps/cloud-repo.service";
import {
  BlobPreconditionError,
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  listTree,
  readBlobsBatch,
  resolveCommit,
} from "../apps/repository.service";
import { authorForUser } from "../apps/workspace-consoles.service";
import { requireWorkspaceRepo } from "../apps/workspace-repo-required";
import { loggers } from "../logging";
import {
  RENAME_GUARD_MS,
  findByRef,
  mergedAliases,
  rekeyRow,
  settleRenames,
  type SlugFileAtHead,
  type SlugKind,
  type SlugRow,
} from "./slug-files";
import { cleanRenameSlug, cleanRenameTitle } from "./title-rules";
import { editNameAndAliases } from "./yaml-name-aliases";
import {
  RenameError,
  type RenameContext,
  type RenameLocation,
  type RenameRequest,
  type RenameResult,
  type ResolvedRef,
} from "./types";

const logger = loggers.api("rename-slug-file");
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

/** What a kind's own service supplies. */
export interface SlugRenameDeps {
  /** The rows' owner: `{ workspaceId }` for flows, `{ projectId }` for jobs. */
  scope: Record<string, unknown>;
  locate(row: Pick<SlugRow, "_id" | "slug" | "name">): RenameLocation;
  /**
   * A file at main that has no row yet (its push is not synced), by slug
   * or by the id the list hands out for it.
   */
  gitOnly(ref: string): Promise<{ id: string; current: RenameLocation } | null>;
  /** Bring the row level with its file at main; false when the file does not apply. */
  resync(id: Types.ObjectId): Promise<boolean>;
  /** Tell open windows the object changed. */
  announce?(): void;
}

/** A save or a delete that a rename (or another edit) got ahead of: 409. */
export class SlugFileConflictError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "SlugFileConflictError";
  }
}

/** Every file of `kind` at `head`, read for pairing. */
export async function slugFilesAt(
  kind: SlugKind,
  repoDir: string,
  head: string,
): Promise<SlugFileAtHead[]> {
  const paths = (await listTree(repoDir, head))
    .map(entry => entry.path)
    .filter(p => kind.slugOf(p) !== null);
  const files: SlugFileAtHead[] = [];
  for (const [p, buf] of await readBlobsBatch(repoDir, head, paths)) {
    const contents = buf.toString("utf8");
    const read = kind.read(contents);
    files.push({
      slug: kind.slugOf(p) as string,
      oid: blobOid(buf),
      contents,
      aliases: read.ok ? read.aliases : [],
      target: read.ok ? read.target : null,
    });
  }
  return files;
}

/**
 * The file a save or a delete of this row is about to replace, for the
 * commit's compare-and-swap: the row's slug as it is NOW, the path, and the
 * blob there (`null` when there is none).
 *
 * The row in a request's hand may predate a rename. Writing
 * `<old slug>.yml` then re-creates the file the rename moved (two files,
 * and the next sync starts a second stream from one of them); deleting it
 * is a no-op that leaves the moved file to come back as a new object. So
 * the slug is read again, and a file that is not there is looked for under
 * the name a rename gave it. `SlugFileConflictError` when that rename has
 * not reached this instance's clone yet.
 */
export async function currentFileOf(
  kind: SlugKind,
  args: {
    workspaceId: string;
    scope: Record<string, unknown>;
    repoDir: string;
    id: Types.ObjectId;
    slug: string;
  },
): Promise<{ slug: string; path: string; oid: string | null }> {
  const { workspaceId, scope, repoDir, id } = args;
  const slugNow = async () =>
    ((await kind.model.findById(id).select("slug").lean()) as SlugRow | null)
      ?.slug ?? args.slug;
  const head = await resolveCommit(repoDir, MAIN);
  for (let attempt = 0; head && attempt < 2; attempt++) {
    const slug = await slugNow();
    const filePath = kind.filePath(slug);
    const blob = (await readBlobsBatch(repoDir, head, [filePath])).get(
      filePath,
    );
    if (blob) return { slug, path: filePath, oid: blobOid(blob) };
    const { ahead } = await settleRenames(kind, {
      workspaceId,
      repoDir,
      head,
      files: await slugFilesAt(kind, repoDir, head),
      rows: (await kind.model.find(scope).lean()) as SlugRow[],
      mode: "read",
    });
    if ([...ahead.values()].some(row => String(row._id) === String(id))) {
      // Renamed on another instance, and this clone does not have the
      // commit yet. Writing here would put a second file on main; deleting
      // would leave the moved one to come back as a new object.
      throw new SlugFileConflictError(
        `This ${kind.noun} was renamed a moment ago and this server has not received the change yet. Nothing was changed: retry in a few seconds.`,
      );
    }
    if ((await slugNow()) === slug) break;
  }
  const slug = await slugNow();
  return { slug, path: kind.filePath(slug), oid: null };
}

/**
 * Remove a deleted object's file: the one its row has now, under a
 * compare-and-swap. Throws `SlugFileConflictError` when a rename or an edit
 * lands in between; nothing is deleted then.
 */
export async function deleteSlugFile(
  kind: SlugKind,
  args: {
    workspaceId: string;
    scope: Record<string, unknown>;
    id: Types.ObjectId;
    slug: string;
    message: (slug: string) => string;
    actorUserId?: string;
  },
): Promise<void> {
  const { workspaceId } = args;
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  const at = await currentFileOf(kind, { ...args, repoDir });
  if (at.oid === null) return; // A row whose file is already gone.
  try {
    const result = await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { deletes: [at.path] },
      {
        message: args.message(at.slug),
        author: args.actorUserId
          ? await authorForUser(args.actorUserId)
          : undefined,
        expectBlobs: { [at.path]: at.oid },
      },
    );
    if (!result.unchanged) queueMirrorPush(workspaceId);
  } catch (error) {
    if (!(error instanceof BlobPreconditionError)) throw error;
    throw new SlugFileConflictError(
      `${error.path} changed while the ${kind.noun} was being deleted (a rename or another edit landed first); nothing was deleted. Reload and retry.`,
    );
  }
}

function resolved(
  kind: SlugKind,
  deps: SlugRenameDeps,
  found: { row: SlugRow; via: "current" | "alias" },
): ResolvedRef {
  return {
    kind: kind.kind,
    id: String(found.row._id),
    via: found.via,
    current: deps.locate(found.row),
  };
}

/**
 * What `ref` points at: a row's id or current slug; then a file at main
 * under that name whose push is not synced yet (current too — a new object
 * that takes an old name has it while it exists); then an alias.
 */
export async function resolveSlugRef(
  kind: SlugKind,
  deps: SlugRenameDeps,
  ref: string,
): Promise<ResolvedRef | null> {
  const found = await findByRef(kind, deps.scope, ref);
  if (found?.via === "current") return resolved(kind, deps, found);
  const gitOnly = await deps.gitOnly(ref);
  if (gitOnly) return { kind: kind.kind, via: "current", ...gitOnly };
  return found ? resolved(kind, deps, found) : null;
}

export async function renameSlugFile(
  kind: SlugKind,
  deps: SlugRenameDeps,
  ctx: RenameContext,
  request: RenameRequest,
  /** Internal: the one retry after the row was brought level with main. */
  converged = false,
): Promise<RenameResult> {
  const { workspaceId } = ctx;
  const found = await findByRef(kind, deps.scope, request.ref);
  if (found?.via !== "current") {
    const gitOnly = await deps.gitOnly(request.ref);
    if (gitOnly) {
      throw new RenameError(
        `"${gitOnly.current.slug}" exists only in git so far (${gitOnly.current.path}); it can be renamed once its push is synced.`,
        409,
      );
    }
  }
  if (!found) {
    throw new RenameError(`No ${kind.noun} answers to "${request.ref}".`, 404);
  }
  const row = found.row;
  if (!row.slug) {
    throw new RenameError(
      `This ${kind.noun} has no file yet, so it cannot be renamed.`,
      409,
    );
  }
  const oldSlug = row.slug;
  const title =
    request.title === undefined
      ? undefined
      : cleanRenameTitle(request.title, kind.nameMaxLength);
  const slugChanged =
    request.slug !== undefined && request.slug.trim() !== oldSlug;
  const nextSlug = slugChanged
    ? cleanRenameSlug(kind.kind, request.slug as string)
    : oldSlug;
  if (slugChanged) {
    // Another object's current name, or an old name it still answers to:
    // an old link must never start opening a different object.
    const holder = (await kind.model
      .findOne({
        ...deps.scope,
        _id: { $ne: row._id },
        $or: [{ slug: nextSlug }, { aliases: nextSlug }],
      })
      .select("slug name")
      .lean()) as SlugRow | null;
    if (holder) {
      throw new RenameError(
        holder.slug === nextSlug
          ? `"${nextSlug}" is already the file name of ${kind.noun} "${holder.name ?? holder.slug}".`
          : `"${nextSlug}" is an old name of ${kind.noun} "${holder.name ?? holder.slug}" and still resolves to it.`,
        409,
      );
    }
  }

  // ---- the file at main is what gets renamed ------------------------------
  let repoDir: string;
  try {
    repoDir = await requireWorkspaceRepo(workspaceId);
  } catch (error) {
    if (error instanceof RepoRequiredError) {
      throw new RenameError(error.message, 412);
    }
    throw error;
  }
  await freshenBeforeMainWrite(workspaceId);
  const head = await resolveCommit(repoDir, MAIN);
  const oldPath = kind.filePath(oldSlug);
  const newPath = kind.filePath(nextSlug);
  const blobs = head
    ? await readBlobsBatch(repoDir, head, [...new Set([oldPath, newPath])])
    : new Map<string, Buffer>();
  const blob = blobs.get(oldPath);
  if (!head || !blob) {
    // The row may be behind its own file: a rename that committed and whose
    // row update did not happen. Bring it level the way a read does, then
    // judge again — so retrying such a rename answers with what is there.
    if (head && !converged) {
      await settleRenames(kind, {
        workspaceId,
        repoDir,
        head,
        files: await slugFilesAt(kind, repoDir, head),
        rows: (await kind.model.find(deps.scope).lean()) as SlugRow[],
        mode: "read",
      });
      const moved = (await kind.model
        .findById(row._id)
        .select("slug")
        .lean()) as SlugRow | null;
      if (moved?.slug && moved.slug !== oldSlug) {
        await deps.resync(row._id);
        const again = { ...request, ref: String(row._id) };
        return renameSlugFile(kind, deps, ctx, again, true);
      }
    }
    throw new RenameError(
      `${oldPath} is not on main (its last push may not have synced, or the file was deleted); nothing was renamed.`,
      409,
    );
  }
  if (slugChanged && blobs.has(newPath)) {
    throw new RenameError(
      `${newPath} already exists in the workspace repo.`,
      409,
    );
  }
  const contents = blob.toString("utf8");
  const oldOid = blobOid(blob);
  // Never rewrite a file that cannot be read back: the alias is added to
  // what is there, and that is unknown for a file that does not parse.
  const read = kind.read(contents);
  if (!read.ok) {
    throw new RenameError(
      `${oldPath} cannot be read (${read.reason}); fix the file first.`,
      409,
    );
  }
  const nextName = title ?? read.name;
  const before = deps.locate({ _id: row._id, slug: oldSlug, name: read.name });
  if (!slugChanged && nextName === read.name) {
    return {
      kind: kind.kind,
      id: String(row._id),
      before,
      after: before,
      aliasesAdded: [],
      warnings: ["Nothing to change: it already has that name."],
    };
  }
  // The file's old names, the row's (a pushed `git mv` is recorded on the
  // row alone), and now the slug being left.
  const aliases = mergedAliases(
    mergedAliases(read.aliases, row.aliases, nextSlug),
    slugChanged ? [oldSlug] : [],
    nextSlug,
  );
  // Edited in place, on the two lines a rename owns: comments, unknown keys
  // and everything the parser does not model stay. Checked with the kind's
  // own parser before it is committed; a file this cannot be done to is
  // refused, never re-serialised.
  const next = editNameAndAliases(contents, nextName, aliases);
  const reread = next === null ? null : kind.read(next);
  if (
    next === null ||
    !reread?.ok ||
    reread.name !== nextName ||
    reread.aliases.join("\0") !== aliases.join("\0")
  ) {
    throw new RenameError(
      `${oldPath} could not be edited in place (its \`name:\` or \`aliases:\` is not a plain one-line value or list); edit the file by hand, then rename.`,
      409,
    );
  }

  // ---- one commit: the move and the alias together -----------------------
  let commitOid: string;
  try {
    const commit = await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      {
        writes: { [newPath]: next },
        ...(slugChanged ? { deletes: [oldPath] } : {}),
      },
      {
        message: slugChanged
          ? `${kind.noun}: rename "${read.name}" to "${nextName}" (${oldSlug} to ${nextSlug})`
          : `${kind.noun}: rename "${read.name}" to "${nextName}" (${oldSlug})`,
        author: ctx.userId ? await authorForUser(ctx.userId) : undefined,
        expectBlobs: {
          [oldPath]: oldOid,
          ...(slugChanged ? { [newPath]: null } : {}),
        },
      },
    );
    commitOid = commit.commitOid;
  } catch (error) {
    if (!(error instanceof BlobPreconditionError)) throw error;
    throw new RenameError(
      `${error.path} changed while renaming (a save, a delete or another rename landed first); nothing was changed. Reload and retry.`,
      409,
    );
  }
  queueMirrorPush(workspaceId);

  // ---- the row, in place: same id ----------------------------------------
  const warnings: string[] = [];
  try {
    if (slugChanged) {
      // While an earlier rename of this row is still on its way to the
      // mirror, the blob every instance has is the one THAT started from.
      const unsettled =
        row.renameFromBlobSha &&
        row.lastRenameAt &&
        Date.now() - new Date(row.lastRenameAt).getTime() < RENAME_GUARD_MS;
      const moved = await rekeyRow(
        kind,
        row._id,
        oldSlug,
        nextSlug,
        {
          commit: commitOid,
          fromBlob: unsettled ? row.renameFromBlobSha : oldOid,
        },
        { name: nextName },
      );
      if (!moved && !(await kind.model.exists({ _id: row._id }))) {
        // A delete took the row (and, following the move, the file).
        throw new RenameError(
          `The ${kind.noun} was deleted while it was being renamed.`,
          409,
        );
      }
    }
    if (!(await deps.resync(row._id))) {
      warnings.push(
        `The rename is committed, but ${newPath} does not apply as a definition (the ${kind.noun} is marked invalid); fix the file.`,
      );
    }
  } catch (error) {
    if (error instanceof RenameError) throw error;
    logger.error(`${kind.noun} rename committed; its row update failed`, {
      workspaceId,
      id: String(row._id),
      commit: commitOid,
      error: error instanceof Error ? error.message : String(error),
    });
    warnings.push(
      `The rename is committed (${commitOid.slice(0, 8)}), but the ${kind.noun}'s record could not be updated just now; it catches up on the next read or sync, with the same id. Retrying is safe.`,
    );
  }
  deps.announce?.();
  logger.info(`${kind.noun} renamed`, {
    workspaceId,
    id: String(row._id),
    from: oldSlug,
    to: nextSlug,
    commit: commitOid,
    actor: ctx.userId,
  });
  return {
    kind: kind.kind,
    id: String(row._id),
    before,
    after: deps.locate({ _id: row._id, slug: nextSlug, name: nextName }),
    aliasesAdded: slugChanged ? [oldSlug] : [],
    commit: commitOid,
    warnings,
  };
}
