/**
 * Graceful rename for flows (see ./types.ts for the contract).
 *
 * A flow is `flows/<slug>.yml` at main plus a Mongo row that carries its
 * runtime (checkpoints, executions, the inbound webhook URL, the webhook
 * secret). The slug is the file name; `name:` is the display name. Before
 * this, a slug could not change at all, and moving the file by hand tore the
 * flow down. Now:
 *
 *  - `title` rewrites `name:` in the file.
 *  - `slug` moves the file (`git mv`) AND appends the old slug to the file's
 *    `aliases:`, in ONE commit, then re-keys the row in place: same `_id`,
 *    so every id-keyed thing survives and `/f/<id>` keeps working, and the
 *    old slug keeps resolving (`resolveFlowRef`).
 *
 * The file is the store, so the row is updated only after the commit — and
 * updated THROUGH the derived-cache machinery (`ensureFlowDerivedCache`)
 * rather than by hand, so the row's definition is exactly what the file now
 * says. Between the commit and the re-key the row still answers to its old
 * slug and the new file names that slug under `aliases:`, so a push-sync
 * that lands in that window pairs the two and re-keys them itself; there is
 * no moment where the flow looks deleted.
 *
 * Every rename path (UI, REST, agent/MCP) calls `renameFlow`; nothing else
 * may move a flow file.
 */
import { Types } from "mongoose";

import { RepoRequiredError } from "../apps/config";
import { authorForUser } from "../apps/workspace-consoles.service";
import { boundRepoDirIfExists } from "../apps/workspace-repo-required";
import {
  freshenBeforeMainWrite,
  mirrorPushNow,
} from "../apps/cloud-repo.service";
import {
  BlobPreconditionError,
  DEFAULT_BRANCH,
  readBlob,
  resolveCommit,
} from "../apps/repository.service";
import { Flow, type IFlow } from "../database/workspace-schema";
import { loggers } from "../logging";
import { publishRealtimeEvent } from "../services/realtime.service";
import {
  FLOW_SLUG_RE,
  flowFilePath,
  isValidFlowSlug,
  parseFlowFileResult,
} from "../services/flow-config-files";
import { commitFlowConfig } from "../services/flow-config.service";
import {
  ensureFlowDerivedCache,
  freeDerivedFlowId,
  listFlowDefinitionsAtMain,
} from "../services/flow-sync.service";
import { mergedAliases } from "./flow-dbt-job-pairing";
import { editNameAndAliases } from "./yaml-name-aliases";
import { cleanRenameTitle } from "./title-rules";
import { retiredIdHolders } from "./retired-ids";
import { unsafeSlugReason } from "../utils/slugify";
import {
  RenameError,
  type RenameContext,
  type RenameRequest,
  type RenameResult,
  type ResolvedRef,
} from "./types";

const logger = loggers.api("flow-rename");

/** A flow's display name: the same cap on every path that writes one. */
export const FLOW_NAME_MAX_LENGTH = 200;

/** The in-app route for a flow — `tab-routing.ts` `flow-editor`. */
export function flowUrl(flowId: string): string {
  return `/f/${flowId}`;
}

type FlowRefRow = Pick<IFlow, "_id" | "slug" | "aliases" | "name">;

/**
 * The lookup rule, over rows that MIGHT answer to `ref`: id first, then the
 * current slug, then an alias — and an alias claimed by two rows resolves
 * to neither. Pure, so the rule is testable without Mongo; `findFlowByRef`
 * narrows the candidates with one query and hands them here.
 */
export function pickFlowByRef<T extends FlowRefRow>(
  rows: T[],
  ref: string,
): { row: T; via: ResolvedRef["via"] } | null {
  if (Types.ObjectId.isValid(ref)) {
    const byId = rows.find(row => String(row._id) === ref);
    if (byId) return { row: byId, via: "current" };
  }
  const bySlug = rows.find(row => row.slug === ref);
  if (bySlug) return { row: bySlug, via: "current" };
  const byAlias = rows.filter(row => (row.aliases ?? []).includes(ref));
  if (byAlias.length === 1) return { row: byAlias[0], via: "alias" };
  return null;
}

async function findFlowByRef(
  workspaceId: string,
  ref: string,
): Promise<{ row: IFlow; via: ResolvedRef["via"] } | null> {
  const or: Record<string, unknown>[] = [{ slug: ref }, { aliases: ref }];
  if (Types.ObjectId.isValid(ref)) or.push({ _id: new Types.ObjectId(ref) });
  const rows = await Flow.find({
    workspaceId: new Types.ObjectId(workspaceId),
    $or: or,
  });
  return pickFlowByRef(rows, ref);
}

function locationOf(row: Pick<IFlow, "_id" | "slug" | "name">) {
  return {
    title: row.name ?? row.slug,
    slug: row.slug,
    path: row.slug ? flowFilePath(row.slug) : undefined,
    url: flowUrl(String(row._id)),
  };
}

/**
 * What `ref` points at, in this order: a row's id or current slug; a file at
 * main whose slug is `ref` (current, even before its push is synced — it
 * resolves to the id GET/list hands out for it); and only then an alias,
 * on a row or in a file's `aliases:`, when exactly one claims it. A current
 * name is never shadowed by an alias. Flows are workspace-wide (no per-user
 * ACL), so anyone the objects route let in may resolve one.
 */
export async function resolveFlowRef(
  ctx: RenameContext,
  ref: string,
): Promise<ResolvedRef | null> {
  const found = await findFlowByRef(ctx.workspaceId, ref);
  if (found?.via === "current") {
    return {
      kind: "flow",
      id: String(found.row._id),
      via: "current",
      current: locationOf(found.row),
    };
  }
  if (!FLOW_SLUG_RE.test(ref)) return null;
  const defs = await listFlowDefinitionsAtMain(ctx.workspaceId);
  const gitOnly = (def: (typeof defs)[number], via: ResolvedRef["via"]) => {
    return (async (): Promise<ResolvedRef> => {
      const rows = [
        ...(await Flow.find({ workspaceId: ctx.workspaceId })
          .select("_id slug")
          .lean()),
        ...(await retiredIdHolders(ctx.workspaceId, "flow")),
      ];
      // The file's row when it has one (an old name found only in a FILE's
      // `aliases:` — the row lost it to a newcomer since gone — still names
      // that row, not a derived id nothing holds); the derived id only for
      // a file not yet synced.
      const id = String(
        rows.find(row => row.slug === def.slug)?._id ??
          freeDerivedFlowId(ctx.workspaceId, def.slug, rows),
      );
      return {
        kind: "flow",
        id,
        via,
        current: {
          title: def.parsed?.name ?? def.slug,
          slug: def.slug,
          path: def.path,
          url: flowUrl(id),
        },
      };
    })();
  };
  const currentFile = defs.find(def => def.slug === ref);
  if (currentFile) return gitOnly(currentFile, "current");
  if (!found && Types.ObjectId.isValid(ref)) {
    // The id GET/list hands out for a file with no row yet (a tab or a
    // link made before its push was synced).
    const byDerivedId = await gitOnlyFlowByDerivedId(
      ctx.workspaceId,
      defs,
      ref,
    );
    if (byDerivedId) return gitOnly(byDerivedId, "current");
  }
  if (found) {
    return {
      kind: "flow",
      id: String(found.row._id),
      via: "alias",
      current: locationOf(found.row),
    };
  }
  const byAlias = defs.filter(def => def.parsed?.aliases?.includes(ref));
  return byAlias.length === 1 ? gitOnly(byAlias[0], "alias") : null;
}

/** The git-only file (no row yet) whose derived id is `id`, if any. */
async function gitOnlyFlowByDerivedId(
  workspaceId: string,
  defs: Awaited<ReturnType<typeof listFlowDefinitionsAtMain>>,
  id: string,
) {
  const rows = [
    ...(await Flow.find({ workspaceId }).select("_id slug").lean()),
    ...(await retiredIdHolders(workspaceId, "flow")),
  ];
  const rowSlugs = new Set(rows.map(row => row.slug));
  return (
    defs.find(
      def =>
        !rowSlugs.has(def.slug) &&
        String(freeDerivedFlowId(workspaceId, def.slug, rows)) === id,
    ) ?? null
  );
}

/**
 * Rename a flow's display name and/or file slug. Permissions match the
 * flow write routes (`PUT /flows/:id`): workspace access, which the caller
 * (objects route, `rename_object` tool) has already established — those
 * routes gate nothing further, and neither does this.
 */
export async function renameFlow(
  ctx: RenameContext,
  request: RenameRequest,
  /** Internal: the one retry after the row was brought level with main. */
  converged = false,
): Promise<RenameResult> {
  const { workspaceId } = ctx;
  const found = await findFlowByRef(workspaceId, request.ref);
  if (!found) {
    // A file at main with no row yet is a flow the list shows (and resolve
    // finds): say why it cannot be renamed yet rather than "no such flow".
    const defs = FLOW_SLUG_RE.test(request.ref)
      ? await listFlowDefinitionsAtMain(workspaceId)
      : [];
    const gitOnly =
      defs.find(def => def.slug === request.ref) ??
      (Types.ObjectId.isValid(request.ref)
        ? await gitOnlyFlowByDerivedId(workspaceId, defs, request.ref)
        : null);
    if (gitOnly) {
      throw new RenameError(
        `Flow "${gitOnly.slug}" exists only in git so far (${gitOnly.path}, not synced yet); it can be renamed once its push is synced.`,
        409,
      );
    }
    throw new RenameError(`No flow answers to "${request.ref}".`, 404);
  }
  const row = found.row;
  if (!row.slug) {
    throw new RenameError(
      "This flow has no file slug yet (it predates flows-as-files); it cannot be renamed until the backfill has stamped one.",
      409,
    );
  }
  const oldSlug = row.slug;
  if (found.via === "alias") {
    // An old name that a NEW file at main has since taken is that file's,
    // not this row's — even before the push that creates its row is synced.
    const defs = await listFlowDefinitionsAtMain(workspaceId);
    if (defs.some(def => def.slug === request.ref)) {
      throw new RenameError(
        `"${request.ref}" is now a flow of its own (flows/${request.ref}.yml, not synced yet); refer to the renamed flow by its id or current slug "${oldSlug}".`,
        409,
      );
    }
  }

  // ---- validate the request against the same rules as creation ----------
  const title =
    request.title === undefined
      ? undefined
      : cleanRenameTitle(request.title, FLOW_NAME_MAX_LENGTH);
  const newSlug = request.slug?.trim();
  const slugChanged = newSlug !== undefined && newSlug !== oldSlug;
  if (slugChanged) {
    if (!isValidFlowSlug(newSlug)) {
      throw new RenameError(
        `"${newSlug}" is not a valid file name: lowercase letters, digits and single dashes, up to 64 characters (it becomes flows/${newSlug}.yml).`,
      );
    }
    const unsafe = unsafeSlugReason(newSlug);
    if (unsafe) throw new RenameError(unsafe);
    // Taken by another flow's current slug OR by an old name it still
    // answers to — an old link must never start opening a different flow.
    const holder = await Flow.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      _id: { $ne: row._id },
      $or: [{ slug: newSlug }, { aliases: newSlug }],
    })
      .select("_id slug name")
      .lean();
    if (holder) {
      throw new RenameError(
        holder.slug === newSlug
          ? `"${newSlug}" is already the file name of flow "${holder.name ?? holder.slug}".`
          : `"${newSlug}" is an old name of flow "${holder.name ?? holder.slug}" and still resolves to it.`,
        409,
      );
    }
  }

  // ---- the file at main is what gets renamed ------------------------------
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) throw new RepoRequiredError();
  await freshenBeforeMainWrite(workspaceId);
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) throw new RepoRequiredError();
  const oldPath = flowFilePath(oldSlug);
  let contents: string;
  let oldOid: string;
  try {
    const blob = await readBlob(repoDir, head, oldPath);
    if (blob.isBinary) throw new Error("binary");
    contents = blob.contents;
    oldOid = blob.oid; // git's id from the raw bytes, for the CAS below
  } catch {
    // The row may be behind its own file: a rename whose commit landed and
    // whose row update did not (see below) leaves the file under its new
    // name. Bring the row level the way every read does, then judge again —
    // so retrying such a rename is safe, and answers with what is there.
    if (!converged) {
      await ensureFlowDerivedCache(row);
      const moved = await Flow.findById(row._id).select("slug").lean();
      if (moved?.slug && moved.slug !== oldSlug) {
        return renameFlow(ctx, { ...request, ref: String(row._id) }, true);
      }
    }
    throw new RenameError(
      `${oldPath} is not at main (the flow's last push may not have synced, or the file was deleted); nothing was renamed.`,
      409,
    );
  }
  if (slugChanged) {
    // A git-only file under the new slug (not synced yet) is taken too.
    try {
      await readBlob(repoDir, head, flowFilePath(newSlug));
      throw new RenameError(
        `flows/${newSlug}.yml already exists in the workspace repo.`,
        409,
      );
    } catch (error) {
      if (error instanceof RenameError) throw error;
    }
  }
  // Never rewrite a file that cannot be read back: the alias has to be
  // added to what is there, and "what is there" is unknown for a file that
  // does not parse. Fail with the reason rather than overwrite user content.
  const parsed = parseFlowFileResult(contents);
  if (!parsed.ok) {
    throw new RenameError(
      `${oldPath} cannot be parsed (${parsed.reason}), so an alias cannot be added to it; fix the file first.`,
      409,
    );
  }

  const nextSlug = slugChanged ? newSlug : oldSlug;
  const nextName = title ?? parsed.file.name;
  // The file's aliases, the row's (a laptop rename the sync recorded on the
  // row alone), and now the slug being left behind.
  const aliases = mergedAliases(
    mergedAliases(parsed.file.aliases, row.aliases, nextSlug),
    slugChanged ? [oldSlug] : [],
    nextSlug,
  );
  // Edited in place — the two keys a rename owns, on their own lines — so
  // comments, unknown keys and anything else the parser does not model
  // survive. Verified by the real parser before anything is committed; a
  // file this cannot be done to is refused, never re-serialised.
  const nextContents = editNameAndAliases(contents, nextName, aliases);
  const reparsed =
    nextContents === null ? null : parseFlowFileResult(nextContents);
  if (
    nextContents === null ||
    !reparsed?.ok ||
    reparsed.file.name !== nextName ||
    (reparsed.file.aliases ?? []).join("\0") !== aliases.join("\0")
  ) {
    throw new RenameError(
      `${oldPath} could not be edited in place (its \`name:\` or \`aliases:\` is not a plain one-line value / list); edit the file by hand, then rename.`,
      409,
    );
  }
  const before = locationOf(row);
  const titleChanged = nextName !== parsed.file.name;
  if (!slugChanged && !titleChanged) {
    return {
      kind: "flow",
      id: String(row._id),
      before,
      after: before,
      aliasesAdded: [],
      warnings: ["Nothing changed: the name and file name are already these."],
    };
  }

  // ---- one commit: the move and the alias together -----------------------
  const message = slugChanged
    ? `flow: rename "${parsed.file.name}" → "${nextName}" (${oldSlug} → ${nextSlug})`
    : `flow: rename "${parsed.file.name}" → "${nextName}" (${oldSlug})`;
  // Compare-and-swap on the file itself: the commit applies only if the old
  // file is still the one read above and the new path is still free. Two
  // renames racing, or a save that landed in between, otherwise re-apply
  // this move on top of the other's and leave both files behind.
  let commit: { commitOid: string; unchanged: boolean };
  try {
    commit = await commitFlowConfig(
      workspaceId,
      {
        writes: { [flowFilePath(nextSlug)]: nextContents },
        ...(slugChanged ? { deletes: [oldPath] } : {}),
      },
      message,
      ctx.userId ? await authorForUser(ctx.userId) : undefined,
      {
        [oldPath]: oldOid,
        ...(slugChanged ? { [flowFilePath(nextSlug)]: null } : {}),
      },
    );
  } catch (error) {
    if (error instanceof BlobPreconditionError) {
      throw new RenameError(
        `${error.path} changed while renaming (another save or rename landed first); nothing was changed — reload and retry.`,
        409,
      );
    }
    throw error;
  }

  // ---- the row, in place: same id, new slug, old slug kept ----------------
  // Targeted update, never `save()` (a legacy row that no longer passes the
  // schema must still be renameable); then the derived-cache resync reads
  // the file back so the row's definition is exactly what was committed.
  const warnings: string[] = [];
  let rowUpdated = true;
  try {
    await Flow.updateOne(
      { _id: row._id },
      {
        $set: {
          slug: nextSlug,
          name: nextName,
          ...(aliases.length > 0 ? { aliases } : {}),
          ...(slugChanged
            ? {
                lastRenameCommit: commit.commitOid,
                lastRenameAt: new Date(),
                // What the push-sync pairs a laptop move against while the
                // guard holds: the blob this rename started from (it was on
                // the mirror, so every instance has it) — or, when an earlier
                // rename of this row has not settled yet, the one THAT
                // started from.
                renameFromBlobSha:
                  row.lastRenameCommit && row.renameFromBlobSha
                    ? row.renameFromBlobSha
                    : oldOid,
              }
            : {}),
        },
        ...(aliases.length === 0 ? { $unset: { aliases: 1 } } : {}),
      },
    );
  } catch (error) {
    // The commit IS the rename (the file is the store): it happened. The row
    // is brought level by the next read of this flow (the read paths pair a
    // row with its moved file) or the push sync the mirror push triggers —
    // same id, nothing torn down. Say so, rather than report a failure that
    // invites a retry of something already done (a retry is safe anyway).
    rowUpdated = false;
    logger.error("Flow rename committed; its row update failed", {
      workspaceId,
      flowId: String(row._id),
      commit: commit.commitOid,
      error: error instanceof Error ? error.message : String(error),
    });
    warnings.push(
      `The rename is committed (${commit.commitOid.slice(0, 8)}), but the flow's record could not be updated just now; it catches up on the next read or sync, with the same id. Retrying is safe.`,
    );
  }
  const fresh = rowUpdated ? await Flow.findById(row._id) : null;
  if (fresh) {
    const status = await ensureFlowDerivedCache(fresh);
    if (status === "invalid") {
      warnings.push(
        `The renamed file was committed but the row could not be resynced from it (marked invalid); see ${flowFilePath(nextSlug)}.`,
      );
    }
  }
  // Other instances learn of the rename from the MIRROR: until the push
  // lands, their first miss on this row fetches nothing and their next
  // read waits out a throttle. Wait for the push (bounded) before telling
  // anyone; a slow or failing push keeps today's behaviour (queued, logged).
  await awaitMirrorPush(workspaceId);
  // Open stores refetch: a form that still holds the old name would
  // otherwise write it back on its next save (see flowNameForSave).
  publishRealtimeEvent(workspaceId, {
    type: "flow.updated",
    flowId: String(row._id),
  });
  logger.info("Flow renamed", {
    workspaceId,
    flowId: String(row._id),
    from: oldSlug,
    to: nextSlug,
    commit: commit.commitOid,
    actor: ctx.userId,
  });

  return {
    kind: "flow",
    id: String(row._id),
    before,
    after: locationOf({ _id: row._id, slug: nextSlug, name: nextName }),
    aliasesAdded: slugChanged ? [oldSlug] : [],
    commit: commit.commitOid,
    warnings,
  };
}

const MIRROR_PUSH_WAIT_MS = 15 * 1000;
async function awaitMirrorPush(workspaceId: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      mirrorPushNow(workspaceId),
      new Promise<void>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `mirror push not confirmed within ${MIRROR_PUSH_WAIT_MS} ms`,
              ),
            ),
          MIRROR_PUSH_WAIT_MS,
        );
      }),
    ]);
  } catch (error) {
    logger.warn("Rename committed; its mirror push is still pending", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
