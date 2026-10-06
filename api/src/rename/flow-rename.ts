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
import { freshenBeforeMainWrite } from "../apps/cloud-repo.service";
import {
  DEFAULT_BRANCH,
  readBlob,
  resolveCommit,
} from "../apps/repository.service";
import { Flow, type IFlow } from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  FLOW_SLUG_RE,
  flowFilePath,
  isValidFlowSlug,
  parseFlowFileResult,
  serializeFlowFile,
} from "../services/flow-config-files";
import { commitFlowConfig } from "../services/flow-config.service";
import {
  derivedFlowId,
  ensureFlowDerivedCache,
  listFlowDefinitionsAtMain,
} from "../services/flow-sync.service";
import { mergedAliases } from "./flow-dbt-job-pairing";
import {
  RenameError,
  type RenameContext,
  type RenameRequest,
  type RenameResult,
  type ResolvedRef,
} from "./types";

const logger = loggers.api("flow-rename");

const FLOW_NAME_MAX_LENGTH = 200;

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
 * What `ref` points at: id, current slug, or an old slug. Flows are
 * workspace-wide (no per-user ACL), so anyone the objects route let in may
 * resolve one. A file at main with no row yet resolves to the id GET/list
 * hands out for it (`derivedFlowId`), by slug or by its own `aliases:`.
 */
export async function resolveFlowRef(
  ctx: RenameContext,
  ref: string,
): Promise<ResolvedRef | null> {
  const found = await findFlowByRef(ctx.workspaceId, ref);
  if (found) {
    return {
      kind: "flow",
      id: String(found.row._id),
      via: found.via,
      current: locationOf(found.row),
    };
  }
  if (!FLOW_SLUG_RE.test(ref)) return null;
  const defs = await listFlowDefinitionsAtMain(ctx.workspaceId);
  const current = defs.find(def => def.slug === ref);
  const byAlias = defs.filter(def => def.parsed?.aliases?.includes(ref));
  const def = current ?? (byAlias.length === 1 ? byAlias[0] : undefined);
  if (!def) return null;
  return {
    kind: "flow",
    id: String(derivedFlowId(ctx.workspaceId, def.slug)),
    via: current ? "current" : "alias",
    current: {
      title: def.parsed?.name ?? def.slug,
      slug: def.slug,
      path: def.path,
      url: flowUrl(String(derivedFlowId(ctx.workspaceId, def.slug))),
    },
  };
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
): Promise<RenameResult> {
  const { workspaceId } = ctx;
  const found = await findFlowByRef(workspaceId, request.ref);
  if (!found) {
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

  // ---- validate the request against the same rules as creation ----------
  const title = request.title?.trim();
  if (title !== undefined) {
    if (!title) throw new RenameError("The name cannot be empty.");
    if (title.length > FLOW_NAME_MAX_LENGTH) {
      throw new RenameError(
        `The name is longer than ${FLOW_NAME_MAX_LENGTH} characters.`,
      );
    }
  }
  const newSlug = request.slug?.trim();
  const slugChanged = newSlug !== undefined && newSlug !== oldSlug;
  if (slugChanged) {
    if (!isValidFlowSlug(newSlug)) {
      throw new RenameError(
        `"${newSlug}" is not a valid file name: lowercase letters, digits and single dashes, up to 64 characters (it becomes flows/${newSlug}.yml).`,
      );
    }
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
  const oldPath = flowFilePath(oldSlug);
  let contents: string;
  try {
    const blob = await readBlob(repoDir, head, oldPath);
    if (blob.isBinary) throw new Error("binary");
    contents = blob.contents;
  } catch {
    throw new RenameError(
      `${oldPath} is not at main (the flow's last push may not have synced, or the file was deleted); nothing was renamed.`,
      409,
    );
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
  const nextContents = serializeFlowFile({
    ...parsed.file,
    name: nextName,
    ...(aliases.length > 0 ? { aliases } : {}),
  });
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
  const commit = await commitFlowConfig(
    workspaceId,
    {
      writes: { [flowFilePath(nextSlug)]: nextContents },
      ...(slugChanged ? { deletes: [oldPath] } : {}),
    },
    message,
    ctx.userId ? await authorForUser(ctx.userId) : undefined,
  );

  // ---- the row, in place: same id, new slug, old slug kept ----------------
  // Targeted update, never `save()` (a legacy row that no longer passes the
  // schema must still be renameable); then the derived-cache resync reads
  // the file back so the row's definition is exactly what was committed.
  await Flow.updateOne(
    { _id: row._id },
    {
      $set: {
        slug: nextSlug,
        name: nextName,
        ...(aliases.length > 0 ? { aliases } : {}),
      },
      ...(aliases.length === 0 ? { $unset: { aliases: 1 } } : {}),
    },
  );
  const warnings: string[] = [];
  const fresh = await Flow.findById(row._id);
  if (fresh) {
    const status = await ensureFlowDerivedCache(fresh);
    if (status === "invalid") {
      warnings.push(
        `The renamed file was committed but the row could not be resynced from it (marked invalid); see ${flowFilePath(nextSlug)}.`,
      );
    }
  }
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
