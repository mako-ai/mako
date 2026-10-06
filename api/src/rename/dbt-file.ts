/**
 * Graceful rename of a dbt project file (kind `dbt_file`).
 *
 * A dbt file is addressed by its PATH — `/x/<projectId>/file/<path>` — and
 * has no id of its own: the path is the identity, and for a model the file
 * name is also the model name and (after the next run) the warehouse
 * relation. A rename therefore has three jobs, all in ONE commit on the
 * actor's branch:
 *
 *   1. move the file (delete + add, which git shows as a rename);
 *   2. when the file is a model or seed (not a snapshot — those are named
 *      by their `{% snapshot %}` block) and `updateRefs` is on
 *      (default), rewrite `ref('old')` across the project and `--select old`
 *      in `dbt/jobs/*.yml` (dbt-ref-rewrite.ts) so the project still
 *      parses;
 *   3. report what it could NOT fix as `warnings`: the old relation in the
 *      warehouse (dbt does not drop it), and consoles / app bindings /
 *      dashboards whose SQL names the old relation.
 *
 * WHICH BRANCH. Exactly where the existing dbt writes land
 * (dbt-working-tree.service.ts): the actor's SESSION branch. A workspace
 * API key over MCP carries its creator as the user, so it commits on
 * that user's branch; only a caller with no user at all (none today)
 * falls to the "agent" actor, which the branch policy sends to the
 * default branch. Not main by fiat — a rename is an edit like any other,
 * and forcing it onto main would make it the one dbt change teammates on
 * other branches see before it is merged. `result.commit` is the sha on
 * that branch; a warning names the branch when it is not the default one.
 *
 * OLD LINKS. There is no alias file for a path, so an old `/x/…/file/<old>`
 * link resolves through git's rename detection (git-renames.ts): the chain
 * a → b → c is followed on the actor's branch and the client is told to open
 * `c`. A bare `git mv` from a laptop therefore redirects exactly like a UI
 * rename — the move IS the record.
 */
import { createHash } from "node:crypto";
import { Types } from "mongoose";
import {
  Dashboard,
  DbtProject,
  type IDbtProject,
} from "../database/workspace-schema";
import { CONSOLES_DIR } from "../apps/console-files";
import { repoForWorkspace } from "../apps/worktree.service";
import {
  DEFAULT_BRANCH,
  grepTree,
  readBlobsBatch,
  repoExists,
  resolveCommit,
  BlobPreconditionError,
  PathConflictError,
  listTree,
  type IndexEntry,
  type IndexMode,
} from "../apps/repository.service";
import {
  DBT_ROOT,
  commitDbtChanges,
  getCheckoutBranch,
  listWorkingFiles,
  readWorkingFile,
} from "../dbt/dbt-working-tree.service";
import {
  mentionsName,
  refNameForDbtPath,
  rewriteJobCommands,
  rewriteNodeProperties,
  rewriteProjectModelConfig,
  rewriteRefs,
  selectorsStillNaming,
} from "../dbt/dbt-ref-rewrite";
import { DBT_JOBS_DIR } from "../dbt/dbt-config-files";
import { publishRealtimeEvent } from "../services/realtime.service";
import { resolveDbtAccess } from "../dbt/rbac";
import { loggers } from "../logging";
import { findRenamedPath } from "./git-renames";
import { isUtf8Text } from "../apps/text-bytes";
import {
  RenameError,
  type RenameContext,
  type RenameResult,
  type ResolvedRef,
} from "./types";
import yaml from "js-yaml";

const logger = loggers.api("rename-dbt-file");

/** How many referencing consoles/bindings/dashboards a warning names. */
const WARN_LIST_MAX = 10;

export interface DbtFileRef {
  projectId?: string;
  /** Project-relative, `models/foo.sql` — never prefixed with `dbt/`. */
  path: string;
}

/**
 * Accept every way a dbt file gets named: the in-app URL
 * (`/x/<projectId>/file/<path>`), `<projectId>/<path>`, the repo path
 * (`dbt/<path>`) or the project-relative path (`<path>`).
 */
export function parseDbtFileRef(ref: string): DbtFileRef | null {
  const clean = ref.trim();
  if (!clean) return null;
  const url = /^\/x\/([a-zA-Z0-9-]+)\/file\/(.+)$/.exec(clean);
  if (url) {
    return {
      projectId: url[1],
      path: normalizePath(decodeURIComponent(url[2])),
    };
  }
  const withProject = /^([0-9a-f]{24})\/(.+)$/.exec(clean);
  if (withProject) {
    return { projectId: withProject[1], path: normalizePath(withProject[2]) };
  }
  return { path: normalizePath(clean) };
}

function normalizePath(path: string): string {
  const p = path.replace(/^\/+/, "");
  return p.startsWith(`${DBT_ROOT}/`) ? p.slice(DBT_ROOT.length + 1) : p;
}

export function isSafeDbtPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length < 1024 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some(seg => seg === "" || seg === ".." || seg === ".git")
  );
}

export function dbtFileUrl(projectId: string, path: string): string {
  return `/x/${projectId}/file/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The workspace's dbt project (one per workspace), optionally by id. */
export async function findDbtProject(
  workspaceId: string,
  projectId?: string,
): Promise<IDbtProject | null> {
  const query: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(workspaceId),
  };
  if (projectId) {
    if (!Types.ObjectId.isValid(projectId)) return null;
    query._id = new Types.ObjectId(projectId);
  }
  return DbtProject.findOne(query);
}

/**
 * The dbt routes' RBAC for file writes (dbt/rbac.ts): member or above; a
 * viewer is read-only. A workspace API key has no user and no role — the
 * dbt MCP tools apply no per-user check there (the key's scopes are the
 * gate), and neither does this.
 */
function assertMayWriteDbt(ctx: RenameContext): void {
  if (!ctx.userId) return;
  const decision = resolveDbtAccess({
    method: "POST",
    path: "/dbt/projects/_/files/rename",
    role: ctx.role,
  });
  if (!decision.ok) {
    throw new RenameError(decision.error ?? "Access denied", 403);
  }
}

/**
 * The actor the dbt write tools act as: the user, or "agent" for a
 * workspace API key — which the branch policy sends to the default branch.
 */
function actingUserId(ctx: RenameContext): string {
  return ctx.userId ?? "agent";
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export async function resolveDbtFile(
  ctx: RenameContext,
  ref: string,
): Promise<ResolvedRef | null> {
  const parsed = parseDbtFileRef(ref);
  if (!parsed || !isSafeDbtPath(parsed.path)) return null;
  const project = await findDbtProject(ctx.workspaceId, parsed.projectId);
  if (!project) return null;
  const projectId = project._id.toString();
  const actor = actingUserId(ctx);
  const located = (path: string, via: "current" | "alias"): ResolvedRef => ({
    kind: "dbt_file",
    id: `${projectId}/${path}`,
    via,
    current: {
      title: path.slice(path.lastIndexOf("/") + 1),
      slug: path,
      path: `${DBT_ROOT}/${path}`,
      url: dbtFileUrl(projectId, path),
    },
  });
  if (await readWorkingFile(project, actor, parsed.path)) {
    return located(parsed.path, "current");
  }
  const repoDir = await repoForWorkspace(ctx.workspaceId);
  if (!(await repoExists(repoDir))) return null;
  const branch = await getCheckoutBranch(project, actor);
  const ref_ = (await resolveCommit(repoDir, `refs/heads/${branch}`))
    ? `refs/heads/${branch}`
    : `refs/heads/${DEFAULT_BRANCH}`;
  const moved = await findRenamedPath(
    repoDir,
    ref_,
    `${DBT_ROOT}/${parsed.path}`,
    DBT_ROOT,
  );
  if (!moved || !moved.startsWith(`${DBT_ROOT}/`)) return null;
  return located(moved.slice(DBT_ROOT.length + 1), "alias");
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

export interface RenameDbtFileInput {
  projectId?: string;
  from: string;
  to: string;
  /** Rewrite `ref()`s and job selectors when the file is a model. Default true. */
  updateRefs?: boolean;
  /** Realtime echo suppression for the window that asked. */
  clientId?: string;
}

/** The dbt project's `name` (dbt_project.yml), for the two-arg ref form. */
async function projectPackageName(
  project: IDbtProject,
  actor: string,
): Promise<string | undefined> {
  const file = await readWorkingFile(project, actor, "dbt_project.yml");
  if (!file) return undefined;
  try {
    const doc = yaml.load(file.content) as { name?: unknown } | null;
    return typeof doc?.name === "string" ? doc.name : undefined;
  } catch {
    return undefined;
  }
}

/** Git's blob id for these bytes (`git hash-object`). */
function gitBlobOid(content: Buffer): string {
  return createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

/** Files the rewrite looks at: anything textual dbt parses, plus docs. */
function isRewritableDbtPath(path: string): boolean {
  return /\.(sql|yml|yaml|md|markdown|py)$/i.test(path);
}

export async function renameDbtFile(
  ctx: RenameContext,
  input: RenameDbtFileInput,
): Promise<RenameResult> {
  const from = normalizePath(input.from);
  const to = normalizePath(input.to);
  if (!isSafeDbtPath(from) || !isSafeDbtPath(to)) {
    throw new RenameError("Invalid from/to path", 400);
  }
  if (from === to) throw new RenameError("The new path is the old path", 400);
  assertMayWriteDbt(ctx);
  const project = await findDbtProject(ctx.workspaceId, input.projectId);
  if (!project) throw new RenameError("dbt project not found", 404);
  const projectId = project._id.toString();
  const actor = actingUserId(ctx);

  const [source, target] = await Promise.all([
    readWorkingFile(project, actor, from),
    readWorkingFile(project, actor, to),
  ]);
  if (!source) throw new RenameError(`File not found: ${from}`, 404);
  if (target) throw new RenameError(`"${to}" already exists`, 409);

  // The branch the rename commits to (the session branch, or main when it
  // has none yet) — every blob below is read from it.
  const repoDir = await repoForWorkspace(ctx.workspaceId);
  const checkoutBranch = await getCheckoutBranch(project, actor);
  const readRef = (await resolveCommit(repoDir, `refs/heads/${checkoutBranch}`))
    ? `refs/heads/${checkoutBranch}`
    : `refs/heads/${DEFAULT_BRANCH}`;
  // The moved file's raw bytes: its blob oid is what the commit expects, and
  // a file that is not UTF-8 text cannot be moved through the text write
  // path without corrupting it (every invalid byte would become U+FFFD).
  const sourceRaw = (
    await readBlobsBatch(repoDir, readRef, [`${DBT_ROOT}/${from}`])
  ).get(`${DBT_ROOT}/${from}`);
  if (!sourceRaw) throw new RenameError(`File not found: ${from}`, 404);
  // Modes travel with the move: an executable stays executable, and a
  // symlink (`120000`, whose blob is the link TARGET) is moved by oid —
  // its "content" is never rewritten, that would corrupt the link.
  const modeByPath = new Map(
    (await listTree(repoDir, readRef)).map(e => [
      e.path.slice(DBT_ROOT.length + 1),
      e,
    ]),
  );
  const sourceEntry = modeByPath.get(from);
  const sourceIsSymlink = sourceEntry?.mode === "120000";
  if (!sourceIsSymlink && !isUtf8Text(sourceRaw)) {
    throw new RenameError(
      `${from} is not UTF-8 text, so Mako cannot move it without changing its bytes — rename it with git.`,
      400,
    );
  }

  const writes: Record<string, string> = {};
  const modes: Record<string, IndexMode> = {};
  const entries: IndexEntry[] = [];
  const deletes = [from];
  // What this rename read, by blob oid: the commit refuses if any of it
  // changed before the commit lands (a save racing the rename).
  const expectBlobs: Record<string, string | null> = {
    [from]: gitBlobOid(sourceRaw),
    [to]: null,
  };
  // The moved content is THESE bytes, the ones the commit's precondition
  // pins — never the earlier `readWorkingFile` text: a save landing between
  // the two reads would pass the check and be dropped from the move.
  const sourceText = sourceRaw.toString("utf8");
  const warnings: string[] = [];
  const rewritten: string[] = [];
  // Files that still name the old model as a whole word after the rewrite
  // (plain SQL, YAML selectors, a config key under another folder, …):
  // Mako does not know what they mean by it, so they are listed.
  const stillMentioning: string[] = [];
  let jobsTouched = false;

  const oldModel = refNameForDbtPath(from);
  const newModel = refNameForDbtPath(to);
  const updateRefs = input.updateRefs !== false;
  // A node name is unique in a dbt project: renaming onto a name another
  // model, seed or snapshot already has would merge their refs (and the
  // "old relation" warning would invite dropping a live table).
  if (newModel && newModel !== oldModel) {
    const taken = await nodeNameTakenBy(
      project,
      actor,
      repoDir,
      readRef,
      newModel,
      from,
    );
    if (taken) {
      throw new RenameError(
        `A node named '${newModel}' already exists (${taken}); dbt node names must be unique.`,
        409,
      );
    }
  }
  let movedContent = sourceText;

  if (oldModel && !newModel) {
    warnings.push(
      `'${from}' was the model '${oldModel}'; '${to}' is not a model path, so ref('${oldModel}') calls, selectors and its schema entry were left as they are and will fail to resolve.`,
    );
  }
  if (oldModel && newModel && oldModel !== newModel) {
    if (updateRefs) {
      const packageName = await projectPackageName(project, actor);
      const files = (await listWorkingFiles(project, actor))
        .map(f => f.path)
        .filter(p => p !== from && isRewritableDbtPath(p));
      const blobs = await readBlobsBatch(
        repoDir,
        readRef,
        files.map(p => `${DBT_ROOT}/${p}`),
      );
      for (const path of files) {
        const buf = blobs.get(`${DBT_ROOT}/${path}`);
        if (!buf || buf.includes(0)) continue; // binary: not dbt text
        const entry = modeByPath.get(path);
        if (entry?.mode === "120000") {
          // A symlink's blob is its target path, not SQL: never rewritten.
          if (mentionsName(buf.toString("utf8"), oldModel)) {
            stillMentioning.push(path);
          }
          continue;
        }
        if (!isUtf8Text(buf)) {
          // Rewriting it as text would change every invalid byte.
          if (mentionsName(buf.toString("latin1"), oldModel)) {
            warnings.push(
              `${path} is not UTF-8 text and may still name '${oldModel}' — it was left as it is; edit it by hand.`,
            );
          }
          continue;
        }
        const text = buf.toString("utf8");
        const isJob = `${DBT_ROOT}/${path}`.startsWith(`${DBT_JOBS_DIR}/`);
        let next: { text: string; count: number };
        if (isJob) {
          const job = rewriteJobCommands(text, oldModel, newModel);
          next = job;
          for (const cmd of job.unrewritable) {
            warnings.push(
              `${path}: command ${JSON.stringify(cmd)} names '${oldModel}' but could not be rewritten in place — edit it by hand.`,
            );
          }
          if (mentionsName(job.text, oldModel)) stillMentioning.push(path);
          for (const line of job.text.split("\n")) {
            for (const hit of selectorsStillNaming(line, oldModel)) {
              warnings.push(
                `${path}: selector ${JSON.stringify(hit)} still names '${oldModel}' (a dotted or method selector Mako cannot rewrite safely).`,
              );
            }
          }
        } else {
          next = rewriteProjectFile(
            path,
            text,
            from,
            oldModel,
            newModel,
            packageName,
          );
          if (mentionsName(next.text, oldModel)) stillMentioning.push(path);
        }
        if (next.count > 0) {
          writes[path] = next.text;
          if (entry && entry.mode !== "100644") {
            modes[path] = entry.mode as IndexMode;
          }
          expectBlobs[path] = gitBlobOid(buf);
          rewritten.push(path);
          if (isJob) jobsTouched = true;
        }
      }
      // The moved file may ref itself (a comment, a docs block) — rewrite it too.
      if (sourceIsSymlink) {
        warnings.push(
          `${from} is a symlink; it was moved as-is (its target was not rewritten).`,
        );
      } else {
        movedContent = rewriteRefs(
          sourceText,
          oldModel,
          newModel,
          packageName,
        ).text;
      }
      if (mentionsName(movedContent, oldModel)) stillMentioning.push(to);
    } else {
      warnings.push(
        `ref('${oldModel}') calls and job selectors were NOT rewritten (updateRefs: false); the project will not parse until they name '${newModel}'.`,
      );
    }
    if (updateRefs && stillMentioning.length > 0) {
      const shown = stillMentioning.slice(0, WARN_LIST_MAX);
      const rest = stillMentioning.length - shown.length;
      warnings.push(
        `${stillMentioning.length} file${stillMentioning.length === 1 ? " still mentions" : "s still mention"} '${oldModel}' as a whole word after the rewrite — check ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}.`,
      );
    }
    warnings.push(
      `The warehouse relation for '${oldModel}' still exists until it is dropped — dbt builds '${newModel}' next to it and never removes the old one.`,
    );
    warnings.push(...(await referencingSqlWarnings(ctx, project, oldModel)));
  }
  if (sourceIsSymlink && sourceEntry) {
    entries.push({ path: to, oid: sourceEntry.oid, mode: "120000" });
  } else {
    writes[to] = movedContent;
    if (sourceEntry && sourceEntry.mode !== "100644") {
      modes[to] = sourceEntry.mode as IndexMode;
    }
  }

  const message =
    rewritten.length > 0
      ? `dbt: rename ${from} -> ${to} (+${rewritten.length} ref${rewritten.length === 1 ? "" : "s"} updated)`
      : `dbt: rename ${from} -> ${to}`;
  let result: Awaited<ReturnType<typeof commitDbtChanges>>;
  try {
    result = await commitDbtChanges(
      project,
      actor,
      { writes, deletes, entries, modes },
      message,
      expectBlobs,
    );
  } catch (error) {
    if (error instanceof BlobPreconditionError) {
      throw new RenameError(
        `${error.path.replace(/^dbt\//, "")} changed while renaming — reload and try again.`,
        409,
      );
    }
    if (error instanceof PathConflictError) {
      throw new RenameError(error.message.replace(/dbt\//g, ""), 409);
    }
    throw error;
  }
  const branch = await getCheckoutBranch(project, actor);
  if (branch !== DEFAULT_BRANCH) {
    warnings.push(
      `Committed on your branch '${branch}'; jobs and deploys build '${DEFAULT_BRANCH}' until it is merged.`,
    );
  }
  if (rewritten.length > 0 && !input.clientId) {
    // The UI refuses a rewriting rename while unsaved edits mention the
    // model; an agent/MCP rename cannot see anyone's editor, so say it.
    warnings.push(
      `Open editors with unsaved changes to files mentioning '${oldModel}' will need a reload: ${rewritten.length} file${rewritten.length === 1 ? " was" : "s were"} rewritten in the commit.`,
    );
  }

  // Poke open windows: the old tab retargets, the new path and every
  // rewritten file pull fresh content, job views refetch. A commit on a
  // session branch is invisible to teammates on other branches — a
  // workspace-wide poke would move THEIR tabs to a path their branch does
  // not have — so it is scoped to the actor's windows (`forUserId`), like
  // every other branch-local dbt edit.
  const forUserId = branch === DEFAULT_BRANCH ? undefined : actor;
  const poke = (path: string, extra: Record<string, unknown> = {}) =>
    publishRealtimeEvent(ctx.workspaceId, {
      type: "dbt.file.updated",
      projectId,
      path,
      updatedBy: actor,
      clientId: input.clientId,
      origin: ctx.userId ? "save" : "agent",
      forUserId,
      ...extra,
    });
  poke(from, { deleted: true, renamedTo: to });
  poke(to);
  for (const path of rewritten) poke(path);
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
    before: {
      title: from.slice(from.lastIndexOf("/") + 1),
      slug: from,
      path: `${DBT_ROOT}/${from}`,
      url: dbtFileUrl(projectId, from),
    },
    after: {
      title: to.slice(to.lastIndexOf("/") + 1),
      slug: to,
      path: `${DBT_ROOT}/${to}`,
      url: dbtFileUrl(projectId, to),
    },
    // The move itself is the alias: git's rename detection answers old links.
    aliasesAdded: [],
    commit: result.commitOid,
    warnings,
  };
}

/**
 * A project file: `ref()` calls everywhere, plus — in a properties YAML —
 * the node's own `- name:` entry so its tests and descriptions follow.
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
  if (path === "dbt_project.yml") {
    const cfg = rewriteProjectModelConfig(refs.text, fromPath, newModel);
    return { text: cfg.text, count: refs.count + cfg.count };
  }
  const props = rewriteNodeProperties(refs.text, oldModel, newModel);
  return { text: props.text, count: refs.count + props.count };
}

/**
 * Another node already called `name`: a model or seed file whose name is
 * `name` (other than the file being moved), or a `{% snapshot name %}`
 * block. Returns what holds it, or null.
 */
async function nodeNameTakenBy(
  project: IDbtProject,
  actor: string,
  repoDir: string,
  readRef: string,
  name: string,
  except: string,
): Promise<string | null> {
  const files = (await listWorkingFiles(project, actor)).map(f => f.path);
  const byFile = files.find(p => p !== except && refNameForDbtPath(p) === name);
  if (byFile) return byFile;
  // Snapshots are named by their block: read the (few) snapshot files and
  // look for `{% snapshot <name> %}`.
  const snapshots = files.filter(
    p => p.startsWith("snapshots/") && /\.sql$/i.test(p),
  );
  if (snapshots.length === 0) return null;
  const blobs = await readBlobsBatch(
    repoDir,
    readRef,
    snapshots.map(p => `${DBT_ROOT}/${p}`),
  );
  const block = new RegExp(
    `\\{%-?\\s*snapshot\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s`,
  );
  for (const p of snapshots) {
    const buf = blobs.get(`${DBT_ROOT}/${p}`);
    if (buf && !buf.includes(0) && block.test(buf.toString("utf8"))) {
      return `snapshot in ${p}`;
    }
  }
  return null;
}

/**
 * Consoles, app bindings and dashboards whose SQL mentions the old relation
 * name — Mako cannot rewrite those (the relation name depends on the target
 * schema, and the SQL is the author's), so they are listed for the caller.
 */
async function referencingSqlWarnings(
  ctx: RenameContext,
  project: IDbtProject,
  oldModel: string,
): Promise<string[]> {
  const warnings: string[] = [];
  const pattern = `\\b${oldModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`;
  try {
    const repoDir = await repoForWorkspace(ctx.workspaceId);
    if (await repoExists(repoDir)) {
      const branch = await getCheckoutBranch(project, actingUserId(ctx));
      const ref_ = (await resolveCommit(repoDir, `refs/heads/${branch}`))
        ? `refs/heads/${branch}`
        : `refs/heads/${DEFAULT_BRANCH}`;
      for (const [label, pathspec] of [
        ["console", `${CONSOLES_DIR}/`],
        ["app binding", "apps/*/bindings/*.sql"],
      ] as const) {
        const hits = await grepTree(repoDir, ref_, pattern, {
          pathspec,
          maxMatches: 500,
        });
        const paths = [...new Set(hits.map(h => h.path))];
        if (paths.length > 0) warnings.push(listWarning(label, paths));
      }
    }
  } catch (error) {
    logger.warn("Could not search the repo for references to a renamed model", {
      workspaceId: ctx.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const dashboards = await Dashboard.find({
      workspaceId: new Types.ObjectId(ctx.workspaceId),
      "dataSources.query.code": { $regex: pattern },
    })
      .select("title")
      .limit(200)
      .lean();
    if (dashboards.length > 0) {
      warnings.push(
        listWarning(
          "dashboard",
          dashboards.map(d => `${d.title} (/d/${d._id})`),
        ),
      );
    }
  } catch (error) {
    logger.warn(
      "Could not search dashboards for references to a renamed model",
      {
        workspaceId: ctx.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
  return warnings;
}

function listWarning(label: string, items: string[]): string {
  const shown = items.slice(0, WARN_LIST_MAX);
  const rest = items.length - shown.length;
  const noun = items.length === 1 ? label : `${label}s`;
  return (
    `${items.length} ${noun} still mention the old relation name: ${shown.join(", ")}` +
    (rest > 0 ? ` and ${rest} more` : "")
  );
}
