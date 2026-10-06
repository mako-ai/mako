/**
 * Graceful rename for dbt jobs (see ./types.ts for the contract).
 *
 * A job is `dbt/jobs/<slug>.yml` at main plus a scheduler row (`DbtJob`)
 * whose id is the URL (`/x/<projectId>/job/<jobId>`) and the key for its run
 * history and scheduler claim. Same shape as flows (./flow-rename.ts):
 * `title` rewrites `name:`; `slug` moves the file and appends the old slug
 * to its `aliases:` in ONE commit, then the row is re-keyed in place — same
 * id, so the URL, the runs and the schedule registration all survive, and
 * the old slug keeps resolving.
 *
 * The row is brought level with the committed file through
 * `ensureJobDerivedCache`, the same resync GET/list uses, so what the row
 * says is exactly what the file says. Every rename path calls `renameDbtJob`.
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
  blobOid,
  readBlob,
  resolveCommit,
} from "../apps/repository.service";
import {
  DbtJob,
  DbtProject,
  type IDbtJob,
  type IDbtProject,
} from "../database/workspace-schema";
import {
  JOB_SLUG_RE,
  isValidJobSlug,
  jobFilePath,
  parseJobFile,
} from "../dbt/dbt-config-files";
import {
  commitDbtConfig,
  ensureJobDerivedCache,
  freeDerivedJobId,
  listJobDefinitionsAtMain,
} from "../dbt/dbt-config.service";
import { resolveDbtAccess } from "../dbt/rbac";
import { loggers } from "../logging";
import { publishRealtimeEvent } from "../services/realtime.service";
import { mergedAliases } from "./flow-dbt-job-pairing";
import { editNameAndAliases } from "./yaml-name-aliases";
import {
  RenameError,
  type RenameContext,
  type RenameRequest,
  type RenameResult,
  type ResolvedRef,
} from "./types";

const logger = loggers.api("dbt-job-rename");

/** Same cap `jobApplyFailure` enforces on a file's `name:`. */
const JOB_NAME_MAX_LENGTH = 128;

/** The in-app route for a job — `tab-routing.ts` `dbt-job`. */
export function dbtJobUrl(projectId: string, jobId: string): string {
  return `/x/${projectId}/job/${jobId}`;
}

type JobRefRow = Pick<IDbtJob, "_id" | "slug" | "aliases" | "name">;

/** The lookup rule: id → current slug → an alias exactly one row claims. */
export function pickJobByRef<T extends JobRefRow>(
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

async function projectOf(workspaceId: string): Promise<IDbtProject | null> {
  return DbtProject.findOne({ workspaceId: new Types.ObjectId(workspaceId) });
}

async function findJobByRef(
  project: IDbtProject,
  ref: string,
): Promise<{ row: IDbtJob; via: ResolvedRef["via"] } | null> {
  const or: Record<string, unknown>[] = [{ slug: ref }, { aliases: ref }];
  if (Types.ObjectId.isValid(ref)) or.push({ _id: new Types.ObjectId(ref) });
  const rows = await DbtJob.find({ projectId: project._id, $or: or });
  return pickJobByRef(rows, ref);
}

function locationOf(
  project: IDbtProject,
  row: Pick<IDbtJob, "_id" | "slug" | "name">,
) {
  return {
    title: row.name,
    slug: row.slug,
    path: row.slug ? jobFilePath(row.slug) : undefined,
    url: dbtJobUrl(String(project._id), String(row._id)),
  };
}

/**
 * What `ref` points at, in this order: a row's id or current slug; a file at
 * main whose slug is `ref` (current even before its push is synced; it
 * resolves to the id GET/list hands out for it); then an alias exactly one
 * row or file claims. dbt reads are open to every member (rbac.ts).
 */
export async function resolveDbtJobRef(
  ctx: RenameContext,
  ref: string,
): Promise<ResolvedRef | null> {
  const project = await projectOf(ctx.workspaceId);
  if (!project) return null;
  const found = await findJobByRef(project, ref);
  if (found?.via === "current") {
    return {
      kind: "dbt_job",
      id: String(found.row._id),
      via: "current",
      current: locationOf(project, found.row),
    };
  }
  if (!JOB_SLUG_RE.test(ref)) return null;
  const defs = await listJobDefinitionsAtMain(ctx.workspaceId);
  const gitOnly = async (
    def: (typeof defs)[number],
    via: ResolvedRef["via"],
  ): Promise<ResolvedRef> => {
    const rows = await DbtJob.find({ projectId: project._id })
      .select("_id slug")
      .lean();
    // The file's row when it has one (see flow-rename.ts); the derived id
    // only for a file not yet synced.
    const id = String(
      rows.find(row => row.slug === def.slug)?._id ??
        freeDerivedJobId(ctx.workspaceId, def.slug, rows),
    );
    return {
      kind: "dbt_job",
      id,
      via,
      current: {
        title: def.parsed?.name ?? def.slug,
        slug: def.slug,
        path: def.path,
        url: dbtJobUrl(String(project._id), id),
      },
    };
  };
  const currentFile = defs.find(def => def.slug === ref);
  if (currentFile) return gitOnly(currentFile, "current");
  if (found) {
    return {
      kind: "dbt_job",
      id: String(found.row._id),
      via: "alias",
      current: locationOf(project, found.row),
    };
  }
  const byAlias = defs.filter(def => def.parsed?.aliases?.includes(ref));
  return byAlias.length === 1 ? gitOnly(byAlias[0], "alias") : null;
}

/**
 * Rename a job's display name and/or file slug. Permissions are the job
 * PATCH route's: `resolveDbtAccess` for a PATCH on the job path — admin or
 * owner for a signed-in user; a workspace API key (no user) is a service
 * credential with full access, exactly as `dbt.routes.ts` treats it.
 */
export async function renameDbtJob(
  ctx: RenameContext,
  request: RenameRequest,
): Promise<RenameResult> {
  const { workspaceId } = ctx;
  const project = await projectOf(workspaceId);
  if (!project) {
    throw new RenameError("This workspace has no dbt project.", 404);
  }
  const found = await findJobByRef(project, request.ref);
  if (!found) {
    throw new RenameError(`No dbt job answers to "${request.ref}".`, 404);
  }
  const row = found.row;
  const access = resolveDbtAccess({
    method: "PATCH",
    path: `/api/workspaces/${workspaceId}/dbt/projects/${project._id}/jobs/${row._id}`,
    role: ctx.userId ? ctx.role : "owner",
  });
  if (!access.ok) {
    throw new RenameError(access.error ?? "Not allowed to rename jobs", 403);
  }
  if (!row.slug) {
    throw new RenameError(
      "This job has no file slug yet (it predates jobs-as-files); adopt the dbt config into git first.",
      409,
    );
  }
  const oldSlug = row.slug;
  if (found.via === "alias") {
    const defs = await listJobDefinitionsAtMain(workspaceId);
    if (defs.some(def => def.slug === request.ref)) {
      throw new RenameError(
        `"${request.ref}" is now a job of its own (dbt/jobs/${request.ref}.yml, not synced yet); refer to the renamed job by its id or current slug "${oldSlug}".`,
        409,
      );
    }
  }

  const title = request.title?.trim();
  if (title !== undefined) {
    if (!title) throw new RenameError("The name cannot be empty.");
    if (title.length > JOB_NAME_MAX_LENGTH) {
      throw new RenameError(
        `The name is longer than ${JOB_NAME_MAX_LENGTH} characters.`,
      );
    }
  }
  const newSlug = request.slug?.trim();
  const slugChanged = newSlug !== undefined && newSlug !== oldSlug;
  if (slugChanged) {
    if (!isValidJobSlug(newSlug)) {
      throw new RenameError(
        `"${newSlug}" is not a valid file name: lowercase letters, digits and single dashes, up to 64 characters (it becomes dbt/jobs/${newSlug}.yml).`,
      );
    }
    const holder = await DbtJob.findOne({
      projectId: project._id,
      _id: { $ne: row._id },
      $or: [{ slug: newSlug }, { aliases: newSlug }],
    })
      .select("_id slug name")
      .lean();
    if (holder) {
      throw new RenameError(
        holder.slug === newSlug
          ? `"${newSlug}" is already the file name of job "${holder.name}".`
          : `"${newSlug}" is an old name of job "${holder.name}" and still resolves to it.`,
        409,
      );
    }
  }

  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) throw new RepoRequiredError();
  await freshenBeforeMainWrite(workspaceId);
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) throw new RepoRequiredError();
  if (slugChanged) {
    try {
      await readBlob(repoDir, head, jobFilePath(newSlug));
      throw new RenameError(
        `dbt/jobs/${newSlug}.yml already exists in the workspace repo.`,
        409,
      );
    } catch (error) {
      if (error instanceof RenameError) throw error;
    }
  }
  const oldPath = jobFilePath(oldSlug);
  let contents: string;
  let oldOid: string;
  try {
    const blob = await readBlob(repoDir, head, oldPath);
    if (blob.isBinary) throw new Error("binary");
    contents = blob.contents;
    oldOid = blob.oid; // git's id from the raw bytes, for the CAS below
  } catch {
    throw new RenameError(
      `${oldPath} is not at main (the job's last push may not have synced, or the file was deleted); nothing was renamed.`,
      409,
    );
  }
  // A file that does not parse cannot have an alias added to it without
  // guessing at its contents: refuse rather than overwrite.
  const parsed = parseJobFile(contents);
  if (!parsed) {
    throw new RenameError(
      `${oldPath} cannot be parsed, so an alias cannot be added to it; fix the file first.`,
      409,
    );
  }

  const nextSlug = slugChanged ? newSlug : oldSlug;
  const nextName = title ?? parsed.name;
  const aliases = mergedAliases(
    mergedAliases(parsed.aliases, row.aliases, nextSlug),
    slugChanged ? [oldSlug] : [],
    nextSlug,
  );
  // In place (see flow-rename.ts): comments, unknown keys and commands
  // beyond the tenth survive; refused rather than re-serialised.
  const nextContents = editNameAndAliases(contents, nextName, aliases);
  const reparsed = nextContents === null ? null : parseJobFile(nextContents);
  if (
    nextContents === null ||
    !reparsed ||
    reparsed.name !== nextName ||
    (reparsed.aliases ?? []).join("\0") !== aliases.join("\0")
  ) {
    throw new RenameError(
      `${oldPath} could not be edited in place (its \`name:\` or \`aliases:\` is not a plain one-line value / list); edit the file by hand, then rename.`,
      409,
    );
  }
  const before = locationOf(project, row);
  const titleChanged = nextName !== parsed.name;
  if (!slugChanged && !titleChanged) {
    return {
      kind: "dbt_job",
      id: String(row._id),
      before,
      after: before,
      aliasesAdded: [],
      warnings: ["Nothing changed: the name and file name are already these."],
    };
  }

  const message = slugChanged
    ? `dbt: rename job "${parsed.name}" → "${nextName}" (${oldSlug} → ${nextSlug})`
    : `dbt: rename job "${parsed.name}" → "${nextName}" (${oldSlug})`;
  // Compare-and-swap on the file (see flow-rename.ts): the old file must
  // still be the one read, and the new path still free.
  let commit: { commitOid: string; unchanged: boolean };
  try {
    commit = await commitDbtConfig(
      workspaceId,
      {
        writes: { [jobFilePath(nextSlug)]: nextContents },
        ...(slugChanged ? { deletes: [oldPath] } : {}),
      },
      message,
      ctx.userId ? await authorForUser(ctx.userId) : undefined,
      {
        [oldPath]: oldOid,
        ...(slugChanged ? { [jobFilePath(nextSlug)]: null } : {}),
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

  await DbtJob.updateOne(
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
  const warnings: string[] = [];
  const fresh = await DbtJob.findById(row._id);
  if (fresh) {
    try {
      await ensureJobDerivedCache(
        project,
        {
          path: jobFilePath(nextSlug),
          slug: nextSlug,
          oid: blobOid(nextContents),
          parsed: reparsed,
        },
        fresh,
      );
    } catch (error) {
      warnings.push(
        `The renamed file was committed but the scheduler row could not be resynced from it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  // Other instances learn of the rename from the MIRROR: until the push
  // lands, their first miss on this row fetches nothing and their next
  // read waits out a throttle. Wait for the push (bounded) before telling
  // anyone; a slow or failing push keeps today's behaviour (queued, logged).
  await awaitMirrorPush(workspaceId);
  publishRealtimeEvent(workspaceId, {
    type: "dbt.job.updated",
    projectId: String(project._id),
  });
  logger.info("dbt job renamed", {
    workspaceId,
    jobId: String(row._id),
    from: oldSlug,
    to: nextSlug,
    commit: commit.commitOid,
    actor: ctx.userId,
  });

  return {
    kind: "dbt_job",
    id: String(row._id),
    before,
    after: locationOf(project, {
      _id: row._id,
      slug: nextSlug,
      name: nextName,
    }),
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
