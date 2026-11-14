/**
 * Rename or move a file in the dbt project (kind `dbt_file`).
 *
 * A dbt file is addressed by its PATH (`/x/<projectId>/file/<path>`) and has
 * no id of its own. For a model the file name is also the model's name and,
 * after the next run, the warehouse relation. So a rename has three jobs,
 * all in ONE commit:
 *
 *   1. move the file: its blob and mode are kept as they are, so an
 *      executable stays executable, a symlink stays a symlink and a binary
 *      or oddly encoded file keeps its bytes;
 *   2. when the file is a model or a seed and `updateRefs` is on (the
 *      default), rewrite what names it across the project
 *      (dbt/dbt-ref-rewrite.ts) so the project still parses;
 *   3. say what it could NOT fix, as `warnings`: the old relation in the
 *      warehouse, `selectors.yml`, consoles and app bindings whose SQL names
 *      it, and folder-level `dbt_project.yml` config that stops applying.
 *
 * WHERE IT COMMITS. Where every dbt write commits
 * (dbt-working-tree.service.ts): the caller's session branch, freshened from
 * the mirror first; on the default branch the push is awaited. WHO MAY: who
 * may change a dbt file (dbt/rbac.ts) — owners and admins.
 *
 * NOTHING HALF-DONE. Everything is read at one commit, and the commit is
 * refused (409) unless the whole `dbt/` folder is still what was read: a
 * save landing in between cannot be overwritten, leave a `ref('old')`
 * behind, or put a second file where the rename is heading.
 *
 * OLD LINKS. A path keeps no alias; an old `/x/…/file/<old>` link is
 * answered from git's own rename history (git-renames.ts), so a bare
 * `git mv` from a laptop redirects exactly like a rename made here.
 */
import { Types } from "mongoose";
import {
  dbtNewPathProblem,
  dbtPathClash,
  resolveDbtProjectPath,
} from "@mako/schemas";
import { RepoRequiredError } from "../apps/config";
import { CONSOLES_DIR } from "../apps/console-files";
import { runGit } from "../apps/git";
import {
  BlobPreconditionError,
  DEFAULT_BRANCH,
  PathConflictError,
  blobOidAt,
  grepTree,
  listTree,
  readBlobsBatch,
  repoDirFor,
  type IndexEntry,
  type IndexMode,
} from "../apps/repository.service";
import { isUtf8Text } from "../apps/text-bytes";
import { DbtProject, type IDbtProject } from "../database/workspace-schema";
import { DBT_JOBS_DIR } from "../dbt/dbt-config-files";
import {
  mentionsName,
  projectConfigsLostByMove,
  refNameForDbtPath,
  renamedScalarsAreStrings,
  rewriteJobCommands,
  rewriteNodeProperties,
  rewriteProjectModelConfig,
  rewriteRefs,
  selectorsStillNaming,
} from "../dbt/dbt-ref-rewrite";
import {
  DBT_ROOT,
  commitDbtChanges,
  resolveDbtWriteBase,
  resolveWorkingTreeCommit,
} from "../dbt/dbt-working-tree.service";
import { resolveDbtAccess } from "../dbt/rbac";
import { loggers } from "../logging";
import { publishRealtimeEvent } from "../services/realtime.service";
import { loadYaml } from "../utils/yaml";
import { findRenamedPath } from "./git-renames";
import {
  RenameError,
  type RenameContext,
  type RenameLocation,
  type RenameResult,
  type ResolvedRef,
} from "./types";

const logger = loggers.api("rename-dbt-file");

/** How many files a warning names before it says "and N more". */
const WARN_LIST_MAX = 10;
/** Files the rewrite reads: what dbt parses, plus docs. Seed CSVs are data. */
const REWRITABLE = /\.(sql|yml|yaml|md|markdown|py)$/i;

const repoPath = (path: string) => `${DBT_ROOT}/${path}`;

export function dbtFileUrl(projectId: string, path: string): string {
  return `/x/${projectId}/file/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Every way a dbt file is named: the in-app URL
 * (`/x/<projectId>/file/<path>`), `<projectId>/<path>`, the repo path
 * (`dbt/<path>`) or the project path. The path is returned as written.
 */
export function parseDbtFileRef(
  ref: string,
): { projectId?: string; path: string } | null {
  const clean = ref.trim();
  if (!clean) return null;
  const url = /^\/x\/([a-zA-Z0-9-]+)\/file\/(.+)$/.exec(clean);
  if (url) {
    try {
      return { projectId: url[1], path: decodeURIComponent(url[2]) };
    } catch {
      return null;
    }
  }
  const withProject = /^([0-9a-f]{24})\/(.+)$/.exec(clean);
  if (withProject) return { projectId: withProject[1], path: withProject[2] };
  return { path: clean };
}

/** The workspace's dbt project, optionally by id (never another workspace's). */
async function findDbtProject(
  workspaceId: string,
  projectId?: string,
): Promise<IDbtProject | null> {
  if (!Types.ObjectId.isValid(workspaceId)) return null;
  const query: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(workspaceId),
  };
  if (projectId) {
    if (!Types.ObjectId.isValid(projectId)) return null;
    query._id = new Types.ObjectId(projectId);
  }
  return DbtProject.findOne(query);
}

/** The actor dbt writes act as (dbt-tools.ts): the user, else "agent". */
const actorOf = (ctx: RenameContext) => ctx.userId ?? "agent";

/**
 * The rule every dbt file write has (dbt/rbac.ts): owner or admin. A caller
 * whose role is not known is refused, like a role-floored tool is.
 */
function assertMayWriteDbt(ctx: RenameContext): void {
  const decision = resolveDbtAccess({
    method: "POST",
    path: "/dbt/projects/_/files/rename",
    role: ctx.role,
  });
  if (!decision.ok) {
    throw new RenameError(decision.error ?? "Access denied", 403);
  }
}

function locationOf(projectId: string, path: string): RenameLocation {
  return {
    title: path.slice(path.lastIndexOf("/") + 1),
    slug: path,
    path: repoPath(path),
    url: dbtFileUrl(projectId, path),
  };
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

/**
 * The file a ref names on the caller's branch: where it is (`current`), or
 * where git says it moved to (`alias`). Null when it names nothing, a
 * folder, or a file that moved and was then deleted.
 */
export async function resolveDbtFile(
  ctx: RenameContext,
  ref: string,
): Promise<ResolvedRef | null> {
  const parsed = parseDbtFileRef(ref);
  const at = parsed ? resolveDbtProjectPath(parsed.path) : null;
  if (!parsed || !at?.ok) return null;
  const project = await findDbtProject(ctx.workspaceId, parsed.projectId);
  if (!project) return null;
  const projectId = project._id.toString();
  const head = await resolveWorkingTreeCommit(project, {
    userId: actorOf(ctx),
  });
  if (!head) return null;
  const repoDir = repoDirFor(ctx.workspaceId);
  const located = (path: string, via: "current" | "alias"): ResolvedRef => ({
    kind: "dbt_file",
    id: `${projectId}/${path}`,
    via,
    current: locationOf(projectId, path),
  });
  const isFile = await runGit([
    "-C",
    repoDir,
    "cat-file",
    "-t",
    `${head}:${repoPath(at.path)}`,
  ]).then(
    out => out.stdout.trim() === "blob",
    () => false,
  );
  if (isFile) return located(at.path, "current");
  const moved = await findRenamedPath(
    repoDir,
    head,
    repoPath(at.path),
    DBT_ROOT,
  );
  return moved?.startsWith(`${DBT_ROOT}/`)
    ? located(moved.slice(DBT_ROOT.length + 1), "alias")
    : null;
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export interface RenameDbtFileInput {
  projectId?: string;
  /** The file's path, and where it goes: project paths, as typed. */
  from: string;
  to: string;
  /** Rewrite what names the model when the file is one. Default true. */
  updateRefs?: boolean;
  /** The window that asked: it does not react to its own pokes. */
  clientId?: string;
}

function pathOr400(typed: string): string {
  const at = resolveDbtProjectPath(typed);
  if (!at.ok) throw new RenameError(at.error, 400);
  return at.path;
}

/** The dbt project's `name` (dbt_project.yml), for the two-argument ref. */
function projectPackageName(content: string | null): string | undefined {
  if (!content) return undefined;
  try {
    const doc = loadYaml(content) as { name?: unknown } | null;
    return typeof doc?.name === "string" ? doc.name : undefined;
  } catch {
    return undefined;
  }
}

export async function renameDbtFile(
  ctx: RenameContext,
  input: RenameDbtFileInput,
): Promise<RenameResult> {
  assertMayWriteDbt(ctx);
  const from = pathOr400(input.from);
  const to = pathOr400(input.to);
  if (to !== from) {
    const unportable = dbtNewPathProblem(to);
    if (unportable) throw new RenameError(unportable, 400);
  }
  const project = await findDbtProject(ctx.workspaceId, input.projectId);
  if (!project) throw new RenameError("dbt project not found", 404);
  const projectId = project._id.toString();
  const actor = actorOf(ctx);

  // The commit the rename lands on, freshened as the write will be. All
  // that follows is read at this ONE commit, and the commit below pins the
  // whole dbt/ folder to it.
  const base = await resolveDbtWriteBase(project, actor).catch(asRenameError);
  if (!base) throw new RenameError(`File not found: ${from}`, 404);
  const { repoDir, head, branch } = base;
  // Keyed by project path. Only `dbt/` entries: another top-level folder
  // must never lend a file its mode or its blob.
  const tree = new Map(
    (await listTree(repoDir, head))
      .filter(entry => entry.path.startsWith(`${DBT_ROOT}/`))
      .map(entry => [entry.path.slice(DBT_ROOT.length + 1), entry]),
  );
  const source = tree.get(from);
  if (!source) throw new RenameError(`File not found: ${from}`, 404);
  const before = locationOf(projectId, from);
  if (from === to) {
    return {
      kind: "dbt_file",
      id: `${projectId}/${from}`,
      before,
      after: before,
      aliasesAdded: [],
      warnings: ["Nothing to change: it already has that name."],
    };
  }
  const clash = dbtPathClash(to, from, tree.keys());
  if (clash) throw new RenameError(clash, 409);

  const oldModel = refNameForDbtPath(from);
  const newModel = refNameForDbtPath(to);
  /** The dbt node this move renames, when it renames one. */
  const node =
    oldModel && newModel && oldModel !== newModel
      ? { was: oldModel, is: newModel }
      : null;
  /** The same, when what names it is to be rewritten. */
  const rewrite = input.updateRefs === false ? null : node;
  const others = rewrite
    ? [...tree.keys()].filter(path => path !== from && REWRITABLE.test(path))
    : [];
  const snapshots = [...tree.keys()].filter(
    path => path.startsWith("snapshots/") && /\.sql$/i.test(path),
  );
  const blobs = await readBlobsBatch(
    repoDir,
    head,
    [...new Set([from, "dbt_project.yml", ...others, ...snapshots])]
      .filter(path => tree.has(path))
      .map(repoPath),
  );
  const bytesOf = (path: string) => blobs.get(repoPath(path));
  const textOf = (path: string): string | null => {
    const bytes = bytesOf(path);
    return bytes && !bytes.includes(0) ? bytes.toString("utf8") : null;
  };

  // A node name is unique in a dbt project: renaming onto a name a model,
  // a seed or a snapshot already has would merge their refs.
  if (newModel && newModel !== oldModel) {
    const holder =
      [...tree.keys()].find(
        path => path !== from && refNameForDbtPath(path) === newModel,
      ) ??
      snapshots.find(path =>
        new RegExp(`\\{%-?\\s*snapshot\\s+${escapeRegExp(newModel)}\\s`).test(
          textOf(path) ?? "",
        ),
      );
    if (holder) {
      throw new RenameError(
        `A model, seed or snapshot named '${newModel}' already exists (${holder}). dbt names must be unique in a project.`,
        409,
      );
    }
  }

  const writes: Record<string, string> = {};
  const modes: Record<string, IndexMode> = {};
  const warnings: string[] = [];
  const rewritten: string[] = [];
  // Files that still name the old model as a whole word after the rewrite
  // (plain SQL, a dotted selector): Mako does not know what they mean by it.
  const stillMentioning: string[] = [];
  let jobsTouched = false;
  const projectYml = textOf("dbt_project.yml");
  const packageName = projectPackageName(projectYml);

  if (oldModel && newModel && projectYml) {
    // A move to another folder: config keyed by the old folder stops applying.
    const lost = projectConfigsLostByMove(projectYml, from, to);
    if (lost.length > 0) {
      const block = from.split("/")[0];
      const ownKeyLength = from.split("/").length - 1;
      const where = lost.map(chain =>
        chain.length === ownKeyLength ? from : `${block}/${chain.join("/")}`,
      );
      // One plain sentence (what to do), then the exact keys as detail.
      warnings.push(
        `dbt_project.yml config for ${where.join(", ")} (materialization, schema, tags…) no longer applies at its new place, ${to}. Move that config or check the model.\n` +
          `Detail: ${lost.map(chain => [block, packageName ?? "<project>", ...chain].join(".")).join(", ")} applied to ${from}; it is now ${to}.`,
      );
    }
  }
  if (oldModel && !newModel) {
    warnings.push(
      `${from} was the model '${oldModel}', and ${to} is not a model path. ref('${oldModel}') calls, selectors and its schema entry were left as they are and will not resolve.`,
    );
  }

  // The moved file itself: by blob unless its own text names the model.
  let movedText: string | null = null;
  const symlink = source.mode === "120000";
  if (rewrite && !symlink && REWRITABLE.test(from)) {
    const bytes = bytesOf(from);
    if (bytes && !bytes.includes(0)) {
      if (isUtf8Text(bytes)) {
        const self = rewriteRefs(
          bytes.toString("utf8"),
          rewrite.was,
          rewrite.is,
          packageName,
        );
        if (self.count > 0) movedText = self.text;
      } else if (
        rewriteRefs(
          bytes.toString("latin1"),
          rewrite.was,
          rewrite.is,
          packageName,
        ).count > 0
      ) {
        throw new RenameError(
          `${from} is not UTF-8 text and refers to itself, so Mako cannot rewrite it without changing its bytes. Rename it with git, or rename it here without updating references.`,
          400,
        );
      }
    }
  }

  if (rewrite) {
    const { was, is } = rewrite;
    for (const path of others) {
      const bytes = bytesOf(path);
      if (!bytes || bytes.includes(0)) continue;
      const entry = tree.get(path);
      if (entry?.mode === "120000") {
        // A symlink's blob is its target path, not SQL: never rewritten.
        if (mentionsName(bytes.toString("utf8"), was)) {
          stillMentioning.push(path);
        }
        continue;
      }
      if (!isUtf8Text(bytes)) {
        if (mentionsName(bytes.toString("latin1"), was)) {
          warnings.push(
            `${path} is not UTF-8 text and may still name '${was}'. It was left as it is; edit it by hand.`,
          );
        }
        continue;
      }
      const text = bytes.toString("utf8");
      const isJob = repoPath(path).startsWith(`${DBT_JOBS_DIR}/`);
      let next: { text: string; count: number };
      if (isJob) {
        const job = rewriteJobCommands(text, was, is);
        next = job;
        if (job.count > 0) assertJobStillReads(path, text, job.text, is);
        for (const command of job.unrewritable) {
          warnings.push(
            `${path}: the command ${JSON.stringify(command)} names '${was}' but could not be rewritten in place. Edit it by hand.`,
          );
        }
        for (const line of job.text.split("\n")) {
          for (const hit of selectorsStillNaming(line, was)) {
            warnings.push(
              `${path}: the selector ${JSON.stringify(hit)} still names '${was}' (a dotted or method selector, which Mako does not rewrite).`,
            );
          }
        }
      } else {
        next = rewriteProjectFile(path, text, from, was, is, packageName);
      }
      if (path === "selectors.yml" && mentionsName(next.text, was)) {
        warnings.push(
          `selectors.yml still names '${was}'. Mako does not rewrite selector definitions; edit it by hand.`,
        );
      } else if (mentionsName(next.text, was)) {
        stillMentioning.push(path);
      }
      if (next.count > 0) {
        writes[path] = next.text;
        if (entry && entry.mode !== "100644") {
          modes[path] = entry.mode as IndexMode;
        }
        rewritten.push(path);
        if (isJob) jobsTouched = true;
      }
    }
    if (symlink) {
      warnings.push(
        `${from} is a symlink; it was moved as it is (its target was not rewritten).`,
      );
    }
    if (stillMentioning.length > 0) {
      warnings.push(
        `${countOf(stillMentioning.length, "file still mentions", "files still mention")} '${was}' as a whole word after the rewrite. Check ${listed(stillMentioning)}.`,
      );
    }
  }
  if (node) {
    if (!rewrite) {
      warnings.push(
        `ref('${node.was}') calls and job selectors were NOT rewritten; the project will not parse until they name '${node.is}'.`,
      );
    }
    warnings.push(
      `The warehouse relation for '${node.was}' still exists until it is dropped. dbt builds '${node.is}' next to it and never removes the old one.`,
      ...(await referencingSqlWarnings(repoDir, head, node.was)),
    );
  }

  const entries: IndexEntry[] = [];
  if (movedText === null) {
    entries.push({ path: to, oid: source.oid, mode: source.mode as IndexMode });
  } else {
    writes[to] = movedText;
    if (source.mode !== "100644") modes[to] = source.mode as IndexMode;
  }
  const refs = rewritten.length + (movedText === null ? 0 : 1);
  let commit: string | undefined;
  try {
    ({ commitOid: commit } = await commitDbtChanges(
      project,
      actor,
      { writes, deletes: [from], entries, modes },
      refs > 0
        ? `dbt: rename ${from} -> ${to} (${countOf(refs, "file", "files")} updated)`
        : `dbt: rename ${from} -> ${to}`,
      {
        blobs: { [from]: source.oid, [to]: null },
        tree: (await blobOidAt(repoDir, head, DBT_ROOT)) ?? undefined,
      },
    ));
  } catch (error) {
    throw asRenameError(error);
  }
  if (branch !== DEFAULT_BRANCH) {
    warnings.push(
      `Committed on your branch '${branch}'. Jobs and deploys build '${DEFAULT_BRANCH}' until it is merged.`,
    );
  }
  if (rewritten.length > 0 && !input.clientId) {
    // The dialog refuses a rewriting rename while unsaved edits mention the
    // model; an agent cannot see anyone's editor, so it is said instead.
    warnings.push(
      `${countOf(rewritten.length, "file was", "files were")} rewritten in the commit. An editor with unsaved changes to one of them needs a reload.`,
    );
  }

  // Poke open windows: the old tab follows the file, the new path and each
  // rewritten file pull fresh content, job views refetch. A commit on a
  // session branch concerns its author's windows only. The window that
  // asked moved the file itself and skips those two pokes (`clientId`); the
  // rewritten files are news to it as well.
  const poke = (path: string, mine: boolean, renamedTo?: string) =>
    publishRealtimeEvent(ctx.workspaceId, {
      type: "dbt.file.updated",
      projectId,
      path,
      ...(renamedTo ? { deleted: true, renamedTo } : {}),
      updatedBy: actor,
      clientId: mine ? input.clientId : undefined,
      origin: input.clientId ? "save" : "agent",
      forUserId: branch === DEFAULT_BRANCH ? undefined : actor,
    });
  poke(from, true, to);
  poke(to, true);
  for (const path of rewritten) poke(path, false);
  if (jobsTouched) {
    publishRealtimeEvent(ctx.workspaceId, {
      type: "dbt.job.updated",
      projectId,
      clientId: input.clientId,
    });
  }

  return {
    kind: "dbt_file",
    id: `${projectId}/${to}`,
    before,
    after: locationOf(projectId, to),
    // The move is the record: git's rename history answers old links.
    aliasesAdded: [],
    commit,
    warnings,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const countOf = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function listed(items: string[]): string {
  const shown = items.slice(0, WARN_LIST_MAX);
  const rest = items.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` and ${rest} more` : "");
}

/** What a failed read or commit means to the caller. */
function asRenameError(error: unknown): never {
  if (error instanceof BlobPreconditionError) {
    throw new RenameError(
      error.path === DBT_ROOT
        ? "The dbt project changed while renaming (a save or a push landed). Reload and try again."
        : `${error.path.slice(DBT_ROOT.length + 1)} changed while renaming. Reload and try again.`,
      409,
    );
  }
  if (error instanceof PathConflictError) {
    throw new RenameError(error.message.replaceAll(`${DBT_ROOT}/`, ""), 409);
  }
  if (error instanceof RepoRequiredError) {
    throw new RenameError(error.message, 412);
  }
  throw error;
}

/**
 * A project file: `ref()` calls everywhere, plus the model's own entry in
 * a properties YAML and its key in `dbt_project.yml`. Every name written
 * into YAML is read back before anything is committed.
 */
function rewriteProjectFile(
  path: string,
  text: string,
  fromPath: string,
  oldModel: string,
  newModel: string,
  packageName: string | undefined,
): { text: string; count: number } {
  const refs = rewriteRefs(text, oldModel, newModel, packageName);
  if (!/\.ya?ml$/i.test(path)) return refs;
  const named =
    path === "dbt_project.yml"
      ? rewriteProjectModelConfig(refs.text, fromPath, newModel)
      : rewriteNodeProperties(refs.text, oldModel, newModel);
  if (!renamedScalarsAreStrings(refs.text, named.text, newModel, named.count)) {
    throw notPlainText(path, newModel);
  }
  return { text: named.text, count: refs.count + named.count };
}

/** A rewritten job file still parses, and every command is still a string. */
function assertJobStillReads(
  path: string,
  before: string,
  after: string,
  newModel: string,
): void {
  try {
    loadYaml(before);
  } catch {
    return; // it did not parse before: not this rename's to judge
  }
  let commands: unknown;
  try {
    commands = (loadYaml(after) as { commands?: unknown } | null)?.commands;
  } catch {
    throw notPlainText(path, newModel);
  }
  if (Array.isArray(commands) && commands.some(c => typeof c !== "string")) {
    throw notPlainText(path, newModel);
  }
}

function notPlainText(path: string, newModel: string): RenameError {
  return new RenameError(
    `Renaming to '${newModel}' would leave ${path} with a name YAML does not read as plain text, so nothing was changed. Choose another name, or edit ${path} by hand first.`,
    409,
  );
}

/**
 * Shared consoles and app bindings whose SQL mentions the old relation
 * name. Mako cannot rewrite those (the relation's schema depends on the
 * target, and the SQL is its author's), so they are listed.
 */
async function referencingSqlWarnings(
  repoDir: string,
  head: string,
  oldModel: string,
): Promise<string[]> {
  const warnings: string[] = [];
  // A whole word, spelled out: `\b` is not portable across the regex
  // libraries git is built with (it matches nothing on macOS).
  const pattern = `(^|[^A-Za-z0-9_])${escapeRegExp(oldModel)}($|[^A-Za-z0-9_])`;
  try {
    for (const [one, many, pathspec] of [
      ["console", "consoles", `${CONSOLES_DIR}/`],
      ["app binding", "app bindings", "apps/*/bindings/*.sql"],
    ] as const) {
      const hits = await grepTree(repoDir, head, pattern, {
        pathspec,
        maxMatches: 500,
      });
      const paths = [...new Set(hits.map(hit => hit.path))];
      if (paths.length > 0) {
        warnings.push(
          `${countOf(paths.length, `${one} still mentions`, `${many} still mention`)} the old relation name: ${listed(paths)}`,
        );
      }
    }
  } catch (error) {
    logger.warn("Could not search the repo for a renamed model's name", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return warnings;
}
