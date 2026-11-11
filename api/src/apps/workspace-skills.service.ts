/**
 * Workspace skills ARE the files in the workspace repo (apps.md §27).
 *
 * `skills/<name>/SKILL.md` at main is the only store: no index rows, no
 * embeddings, no push-sync, nothing that can drift from git. Reads go
 * through `loadSkillCatalog`, an in-memory catalog keyed by the main commit
 * — a push moves the commit, so the next read rebuilds; between pushes the
 * catalog is served from memory. Writes are commits on main
 * (`commitSkillSave` / `commitSkillDelete` / `commitSkillFlags`), mirrored
 * to GitHub like every other kind.
 *
 * Unbound workspaces (no GitHub repo) have no skills — the same posture as
 * consoles, flows and dbt. Leftover local git without a binding is not a
 * read surface (`boundRepoDirIfExists` / `getWorkspaceRepo` gate every walk).
 *
 * Must not import worktree.service (it imports the apps stack for the push
 * hook).
 */
import { createHash } from "node:crypto";
import { loggers } from "../logging";
import { getWorkspaceRepo } from "../services/workspace-repos.service";
import { freshenBeforeMainWrite, queueMirrorPush } from "./cloud-repo.service";
import {
  requireWorkspaceRepo,
  boundRepoDirIfExists,
} from "./workspace-repo-required";
import {
  BlobPreconditionError,
  DEFAULT_BRANCH,
  blobOidAt,
  commitBlobsOnBranch,
  globTree,
  listTree,
  readBlob,
  readBlobsBatch,
  repoDirFor,
  resolveCommit,
  type GitAuthor,
  type IndexEntry,
  type IndexMode,
} from "./repository.service";
import { capAliases } from "../rename/alias-cap";
import { findRenamedFolder } from "../rename/git-renames";
import { isUtf8Text } from "./text-bytes";
import {
  SKILLS_DIR,
  SKILLS_README,
  editSkillFrontMatter,
  SKILLS_README_PATH,
  SKILL_FILE_GLOB,
  SKILL_NAME_RE,
  SKILL_NAME_RULE,
  canonicalSkillName,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_FILE_BYTES,
  MAX_WORKSPACE_SKILLS,
  parseSkillFile,
  serializeSkillFile,
  skillFilePath,
  skillNameFromPath,
  type WorkspaceSkillFile,
} from "./skill-files";

const logger = loggers.api("skills-git");

// Ref policy: skills pin to the default branch — see branch-policy.ts
// (commitBranchFor "skill") for why.
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

/** A parsed skill file at main. `id` is stable for as long as the name is. */
export interface WorkspaceSkill extends WorkspaceSkillFile {
  id: string;
  path: string;
}

/** A `skills/<name>/SKILL.md` at main that does not parse. Listed, never offered. */
export interface InvalidSkillFile {
  name: string;
  path: string;
  reason: string;
}

export interface SkillCatalog {
  workspaceId: string;
  /** Main commit the catalog was built from; null when there is no repo. */
  head: string | null;
  /** Valid skills, sorted by name. */
  skills: WorkspaceSkill[];
  invalid: InvalidSkillFile[];
}

/**
 * Stable id for a skill, derived from its name (24 hex chars so it looks
 * like every other id the client handles). Nothing else mints skill ids.
 */
export function skillId(workspaceId: string, name: string): string {
  return createHash("sha1")
    .update(`skills:${workspaceId}:${name}`)
    .digest("hex")
    .slice(0, 24);
}

/** Cloud Run is multi-tenant; never retain every workspace catalog forever. */
export const MAX_CACHED_SKILL_CATALOGS = 16;
const catalogCache = new Map<string, SkillCatalog>();

function getCachedCatalog(
  workspaceId: string,
  head: string,
): SkillCatalog | null {
  const cached = catalogCache.get(workspaceId);
  if (!cached || cached.head !== head) return null;
  // Refresh recency for the insertion-ordered Map used as a tiny LRU.
  catalogCache.delete(workspaceId);
  catalogCache.set(workspaceId, cached);
  return cached;
}

function cacheCatalog(workspaceId: string, catalog: SkillCatalog): void {
  catalogCache.delete(workspaceId);
  catalogCache.set(workspaceId, catalog);
  while (catalogCache.size > MAX_CACHED_SKILL_CATALOGS) {
    const oldest = catalogCache.keys().next().value as string | undefined;
    if (!oldest) break;
    catalogCache.delete(oldest);
  }
}

function emptyCatalog(workspaceId: string): SkillCatalog {
  return { workspaceId, head: null, skills: [], invalid: [] };
}

/**
 * The skills at main. Rebuilt only when the main commit moved; an empty
 * catalog (no binding, no repo, no main) is never cached.
 */
export async function loadSkillCatalog(
  workspaceId: string,
): Promise<SkillCatalog> {
  if (!(await getWorkspaceRepo(workspaceId))) return emptyCatalog(workspaceId);
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return emptyCatalog(workspaceId);
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) return emptyCatalog(workspaceId);
  const cached = getCachedCatalog(workspaceId, head);
  if (cached) return cached;

  const skills: WorkspaceSkill[] = [];
  const invalid: InvalidSkillFile[] = [];
  const paths = await globTree(repoDir, MAIN, SKILL_FILE_GLOB, 1000);
  for (const path of paths.sort()) {
    const name = skillNameFromPath(path);
    if (!name) {
      invalid.push({
        name: path.split("/")[1] ?? path,
        path,
        reason: `folder name must be ${SKILL_NAME_RULE}`,
      });
      continue;
    }
    let contents: string | null = null;
    let invalidReason: string | null = null;
    try {
      const blob = await readBlob(repoDir, MAIN, path);
      if (blob.isBinary) {
        invalidReason = "binary skill file";
      } else if (blob.size > MAX_SKILL_FILE_BYTES) {
        invalidReason = `skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes`;
      } else {
        contents = blob.contents;
      }
    } catch (error) {
      logger.warn("Unreadable skill file at main", {
        workspaceId,
        path,
        error,
      });
    }
    const parsed = contents === null ? null : parseSkillFile(name, contents);
    if (!parsed) {
      invalid.push({
        name,
        path,
        reason:
          invalidReason ??
          (contents === null
            ? "unreadable or binary skill file"
            : "unparseable skill file (frontmatter with `description` and a body are required)"),
      });
      continue;
    }
    if (parsed.body.length > MAX_SKILL_BODY_CHARS) {
      invalid.push({
        name,
        path,
        reason: `body exceeds ${MAX_SKILL_BODY_CHARS} characters`,
      });
      continue;
    }
    if (skills.length >= MAX_WORKSPACE_SKILLS) {
      invalid.push({
        name,
        path,
        reason: `workspace exceeds the ${MAX_WORKSPACE_SKILLS} skill limit`,
      });
      continue;
    }
    skills.push({ ...parsed, id: skillId(workspaceId, name), path });
  }
  const catalog: SkillCatalog = { workspaceId, head, skills, invalid };
  cacheCatalog(workspaceId, catalog);
  return catalog;
}

/** Drop the cached catalog; the next read rebuilds from main. */
export function invalidateSkillCatalog(workspaceId: string): void {
  catalogCache.delete(workspaceId);
}

/** The skill whose folder is exactly `name`. Writes key on this. */
export async function findSkill(
  workspaceId: string,
  name: string,
): Promise<WorkspaceSkill | null> {
  const trimmed = name.trim();
  const catalog = await loadSkillCatalog(workspaceId);
  return catalog.skills.find(skill => skill.name === trimmed) ?? null;
}

/**
 * The skills whose name equals `name` once `-` and `_` are folded together
 * (see canonicalSkillName), exact spelling included.
 */
export async function findSkillTwins(
  workspaceId: string,
  name: string,
): Promise<WorkspaceSkill[]> {
  const canonical = canonicalSkillName(name);
  const catalog = await loadSkillCatalog(workspaceId);
  return catalog.skills.filter(
    skill => canonicalSkillName(skill.name) === canonical,
  );
}

/**
 * Reads: the exact folder first; else the one skill that matches with `-` and
 * `_` folded together. Two such skills (`foo-bar` and `foo_bar`) and no exact
 * match resolve to nothing: never a guess between two playbooks.
 */
export async function resolveSkill(
  workspaceId: string,
  name: string,
): Promise<WorkspaceSkill | null> {
  const exact = await findSkill(workspaceId, name);
  if (exact) return exact;
  const twins = await findSkillTwins(workspaceId, name);
  return twins.length === 1 ? twins[0] : null;
}

/** The skills that list `name` (in either spelling) among their old names. */
export async function aliasClaimantsOf(
  workspaceId: string,
  name: string,
): Promise<WorkspaceSkill[]> {
  const canonical = canonicalSkillName(name);
  const catalog = await loadSkillCatalog(workspaceId);
  return catalog.skills.filter(skill =>
    (skill.aliases ?? []).some(a => canonicalSkillName(a) === canonical),
  );
}

/**
 * A name, as a rename leaves it (api/src/rename/types.ts): the skill
 * called that today, else the ONE skill it is an old name of. A live name
 * always beats an old one, and an old name two skills claim (a rename, then
 * a copy that kept the front matter) resolves to neither: an old reference
 * must not open the wrong playbook.
 *
 * Only LIVE skills compete. A suppressed skill (an agent's proposal nobody
 * approved yet) saved under a name a live skill was renamed away from does
 * not take that name, and does not make the live skill's claim ambiguous:
 * `load_skill("old")` keeps answering with the approved playbook. The
 * proposal stays listed and approvable by id; approving it retires the
 * alias, and then its name wins as any live name does.
 */
export async function resolveSkillRef(
  workspaceId: string,
  name: string,
): Promise<{ skill: WorkspaceSkill; via: "current" | "alias" } | null> {
  if (!name.trim()) return null;
  const current = await resolveSkill(workspaceId, name);
  const claimants = await aliasClaimantsOf(workspaceId, name);
  const live = claimants.filter(skill => !skill.suppressed);
  const liveClaimant = live.length === 1 ? live[0] : null;
  if (current && !(current.suppressed && liveClaimant)) {
    return { skill: current, via: "current" };
  }
  if (liveClaimant) return { skill: liveClaimant, via: "alias" };
  if (current) return { skill: current, via: "current" };
  return claimants.length === 1 ? { skill: claimants[0], via: "alias" } : null;
}

/** (workspace, main commit, name) → where the folder went. Bounded. */
const MAX_CACHED_HISTORY_LOOKUPS = 512;
const historyCache = new Map<string, string | null>();

/**
 * Last resort for a name nothing claims: a folder renamed by a bare
 * `git mv` wrote no alias, but it is still a rename to git. Follows
 * `skills/<name>/SKILL.md` through main's rename history
 * (rename/git-renames.ts) to the skill that is there now. It spawns git, so
 * callers try `resolveSkillRef` first, and the answer is remembered until
 * main moves: every `load_skill` of a system skill misses the workspace
 * catalog first.
 */
export async function resolveSkillThroughHistory(
  workspaceId: string,
  name: string,
): Promise<WorkspaceSkill | null> {
  const trimmed = name.trim();
  if (!SKILL_NAME_RE.test(trimmed)) return null;
  const catalog = await loadSkillCatalog(workspaceId);
  if (!catalog.head) return null;
  // An old name two skills claim opens neither; history does not pick one.
  if ((await aliasClaimantsOf(workspaceId, trimmed)).length > 0) return null;
  const key = `${workspaceId}\0${catalog.head}\0${trimmed}`;
  let moved = historyCache.get(key);
  if (moved === undefined) {
    moved = await findRenamedFolder(
      repoDirFor(workspaceId),
      catalog.head,
      SKILLS_DIR,
      trimmed,
      "SKILL.md",
    );
    historyCache.set(key, moved);
    while (historyCache.size > MAX_CACHED_HISTORY_LOOKUPS) {
      historyCache.delete(historyCache.keys().next().value as string);
    }
  }
  return moved ? (catalog.skills.find(s => s.name === moved) ?? null) : null;
}

/**
 * A skill by id. An id is derived from the name (`skillId`), so a rename
 * changes it; an id minted from an old name (an open Skills panel, a tool
 * result in a transcript) still finds the skill, under the same one-claimant
 * rule as names.
 */
export async function findSkillById(
  workspaceId: string,
  id: string,
): Promise<WorkspaceSkill | null> {
  const catalog = await loadSkillCatalog(workspaceId);
  const current = catalog.skills.find(skill => skill.id === id);
  if (current) return current;
  const claimants = catalog.skills.filter(skill =>
    (skill.aliases ?? []).some(alias => skillId(workspaceId, alias) === id),
  );
  return claimants.length === 1 ? claimants[0] : null;
}

// ---------------------------------------------------------------------------
// Writes — commits on main
// ---------------------------------------------------------------------------

async function readRepoFile(
  repoDir: string,
  relPath: string,
): Promise<string | null> {
  try {
    const blob = await readBlob(repoDir, MAIN, relPath);
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

/** Whether the folder's README marker exists (written with the first save). */
export async function skillsAdopted(repoDir: string): Promise<boolean> {
  return (await readRepoFile(repoDir, SKILLS_README_PATH)) !== null;
}

/**
 * The edit that takes `name` off the old names of the skill `owner`, for the
 * commit that gives the name to another skill: a name has one answer. The
 * owner's file is one the caller did not ask to touch, so only its alias
 * list changes, it is pinned to the blob read here, and a file that cannot
 * be edited safely throws: the commit must not happen without it.
 */
async function retiredAliasEdit(
  repoDir: string,
  name: string,
  owner: string,
): Promise<{ path: string; contents: string; oid: string | null }> {
  const path = skillFilePath(owner);
  const head = await resolveCommit(repoDir, MAIN);
  const oid = head ? await blobOidAt(repoDir, head, path) : null;
  const raw = head
    ? await readBlob(repoDir, head, path).then(
        blob => (blob.isBinary ? null : blob.contents),
        () => null,
      )
    : null;
  const parsed = raw === null ? null : parseSkillFile(owner, raw);
  const edited =
    raw !== null && parsed
      ? editSkillFrontMatter(owner, raw, {
          aliases: (parsed.aliases ?? []).filter(
            alias => canonicalSkillName(alias) !== canonicalSkillName(name),
          ),
        })
      : ({ ok: false, reason: `${path} does not parse` } as const);
  if (!edited.ok) {
    throw new Error(
      `"${name}" is a previous name of the skill "${owner}", and ${edited.reason}`,
    );
  }
  return { path, contents: edited.contents, oid };
}

/** A commit on main that keeps what it read: a racing save is a retry. */
async function commitPinned(
  repoDir: string,
  mutation: Parameters<typeof commitBlobsOnBranch>[2],
  options: Parameters<typeof commitBlobsOnBranch>[3],
) {
  try {
    return await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      mutation,
      options,
    );
  } catch (error) {
    if (error instanceof BlobPreconditionError) {
      throw new Error(`${error.path} changed on main meanwhile. Try again.`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Commit one skill save onto main. The first save on a repo also writes the
 * `skills/README.md` marker so the folder explains itself.
 */
export async function commitSkillSave(
  workspaceId: string,
  skill: WorkspaceSkillFile,
  options: {
    author?: GitAuthor;
    /**
     * The skills that list `skill.name` among their old names: the saved
     * skill takes the name, so they drop it in the same commit.
     */
    retireAliasFrom?: string[];
  } = {},
): Promise<void> {
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  const writes: Record<string, string> = {};
  if (!(await skillsAdopted(repoDir))) {
    writes[SKILLS_README_PATH] = SKILLS_README;
  }
  writes[skillFilePath(skill.name)] = serializeSkillFile(skill);
  let message = `Save skill "${skill.name}"`;
  const expectBlobs: Record<string, string | null> = {};
  for (const owner of options.retireAliasFrom ?? []) {
    const retired = await retiredAliasEdit(repoDir, skill.name, owner);
    writes[retired.path] = retired.contents;
    expectBlobs[retired.path] = retired.oid;
    message += ` (no longer a previous name of "${owner}")`;
  }
  await commitPinned(
    repoDir,
    { writes },
    { message, author: options.author, expectBlobs },
  );
  invalidateSkillCatalog(workspaceId);
  queueMirrorPush(workspaceId);
}

async function skillFolderPaths(
  repoDir: string,
  name: string,
): Promise<string[]> {
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) return [];
  const prefix = `skills/${name}/`;
  return (await listTree(repoDir, head))
    .map(e => e.path)
    .filter(p => p.startsWith(prefix));
}

/** Remove the skill's folder from main. False when there is nothing to delete. */
export async function commitSkillDelete(
  workspaceId: string,
  name: string,
  author?: GitAuthor,
): Promise<boolean> {
  if (!SKILL_NAME_RE.test(name)) return false;
  await requireWorkspaceRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  const deletes = await skillFolderPaths(repoDir, name);
  if (deletes.length === 0) return false;
  await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    { deletes },
    { message: `Delete skill "${name}"`, author },
  );
  invalidateSkillCatalog(workspaceId);
  queueMirrorPush(workspaceId);
  return true;
}

/**
 * Flip `suppressed` and/or `pinned` by rewriting the file's frontmatter.
 * False when the file is not at main; true (no commit) when nothing changes.
 */
export async function commitSkillFlags(
  workspaceId: string,
  name: string,
  flags: { suppressed?: boolean; pinned?: boolean },
  author?: GitAuthor,
  options: {
    /**
     * Approving a proposal saved under a name other skills list among their
     * old names: the approved skill takes the name, so they drop it in the
     * same commit (as in commitSkillSave).
     */
    retireAliasFrom?: string[];
  } = {},
): Promise<boolean> {
  if (!SKILL_NAME_RE.test(name)) return false;
  await requireWorkspaceRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  const path = skillFilePath(name);
  const raw = await readRepoFile(repoDir, path);
  const parsed = raw === null ? null : parseSkillFile(name, raw);
  if (!parsed) return false;
  const next: WorkspaceSkillFile = {
    ...parsed,
    suppressed: flags.suppressed ?? parsed.suppressed,
    pinned: flags.pinned ?? parsed.pinned,
  };
  if (next.suppressed === parsed.suppressed && next.pinned === parsed.pinned) {
    return true;
  }
  const verbs: string[] = [];
  if (next.suppressed !== parsed.suppressed) {
    verbs.push(next.suppressed ? "Suppress" : "Unsuppress");
  }
  if (next.pinned !== parsed.pinned) verbs.push(next.pinned ? "Pin" : "Unpin");
  const writes: Record<string, string> = { [path]: serializeSkillFile(next) };
  let message = `${verbs.join(" + ")} skill "${name}"`;
  const expectBlobs: Record<string, string | null> = {};
  for (const owner of next.suppressed ? [] : (options.retireAliasFrom ?? [])) {
    const retired = await retiredAliasEdit(repoDir, name, owner);
    writes[retired.path] = retired.contents;
    expectBlobs[retired.path] = retired.oid;
    message += ` (no longer a previous name of "${owner}")`;
  }
  await commitPinned(repoDir, { writes }, { message, author, expectBlobs });
  invalidateSkillCatalog(workspaceId);
  queueMirrorPush(workspaceId);
  return true;
}

export type SkillRenameOutcome =
  | { ok: true; commitOid: string; aliasesAdded: string[] }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Rename a skill: move `skills/<from>/` to `skills/<to>/` (every file of
 * the folder) and record `from` in the SKILL.md front matter `aliases`, in
 * ONE commit on main. The old name keeps resolving (`resolveSkillRef`), and
 * the record travels with the file.
 *
 * `from` is a skill's CURRENT name, and `to` a valid one (the caller's
 * check). Refused: a `to` that is a skill already, in either spelling of
 * `-` and `_`; a `to` that is an old name of ANOTHER skill (references to
 * it would start opening this one); a SKILL.md that does not parse or is
 * not UTF-8 (a rename must not lose a byte someone wrote by hand). Renaming
 * back to one of the skill's OWN old names is fine: the two swap.
 *
 * Every file but SKILL.md moves as the blob it is, with its mode: an
 * executable helper stays executable, a symlink a symlink. The commit pins
 * the old folder as listed and requires the new one absent, so an edit, an
 * added file or a delete landing in between refuses the rename (409)
 * instead of being dropped or left behind.
 */
export async function commitSkillRename(
  workspaceId: string,
  from: string,
  to: string,
  author?: GitAuthor,
): Promise<SkillRenameOutcome> {
  const refuse = (status: 400 | 404 | 409, error: string) =>
    ({ ok: false, status, error }) as const;
  await requireWorkspaceRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  invalidateSkillCatalog(workspaceId);
  const catalog = await loadSkillCatalog(workspaceId);
  const head = catalog.head;
  const current = catalog.skills.find(skill => skill.name === from);
  if (!head || !current) return refuse(404, `No skill named "${from}".`);
  const sameName = (a: string, b: string) =>
    canonicalSkillName(a) === canonicalSkillName(b);
  const twin = catalog.skills.find(
    skill => skill !== current && sameName(skill.name, to),
  );
  if (twin) {
    return refuse(
      409,
      twin.name === to
        ? `A skill named "${to}" already exists.`
        : `Skill "${twin.name}" already exists; "${to}" differs from it only in '-' vs '_'.`,
    );
  }
  const claimant = catalog.skills.find(
    skill =>
      skill !== current && (skill.aliases ?? []).some(a => sameName(a, to)),
  );
  if (claimant) {
    return refuse(
      409,
      `"${to}" is a previous name of the skill "${claimant.name}". References to that name would open this skill instead.`,
    );
  }
  const tree = await listTree(repoDir, head);
  const oldRoot = `${SKILLS_DIR}/${from}/`;
  const newRoot = `${SKILLS_DIR}/${to}/`;
  if (tree.some(entry => entry.path.startsWith(newRoot))) {
    return refuse(409, `${newRoot} already has files.`);
  }
  const moving = tree.filter(entry => entry.path.startsWith(oldRoot));
  const skillFile = skillFilePath(from);
  const bytes = (await readBlobsBatch(repoDir, head, [skillFile])).get(
    skillFile,
  );
  if (bytes && !bytes.includes(0) && !isUtf8Text(bytes)) {
    return refuse(
      400,
      `${skillFile} is not UTF-8 text, so Mako cannot edit it without changing its bytes. Rename it with git and add \`aliases: [${from}]\` by hand.`,
    );
  }
  const raw = bytes && !bytes.includes(0) ? bytes.toString("utf8") : null;
  const parsed = raw === null ? null : parseSkillFile(from, raw);
  if (raw === null || !parsed) {
    return refuse(
      400,
      `${skillFile} does not parse. Fix its front matter before renaming, so nothing is lost.`,
    );
  }
  // Oldest first; the name being taken back is no longer an old one.
  const had = parsed.aliases ?? [];
  const aliases = capAliases(
    [...new Set([...had, from])].filter(alias => !sameName(alias, to)),
  );
  const renamed = editSkillFrontMatter(to, raw, { name: to, aliases });
  if (!renamed.ok) return refuse(409, renamed.reason);

  const writes: Record<string, string> = {};
  const modes: Record<string, IndexMode> = {};
  const entries: IndexEntry[] = [];
  for (const entry of moving) {
    const path = `${newRoot}${entry.path.slice(oldRoot.length)}`;
    if (entry.path === skillFile) {
      writes[path] = renamed.contents;
      if (entry.mode !== "100644") modes[path] = entry.mode as IndexMode;
    } else {
      entries.push({ path, oid: entry.oid, mode: entry.mode as IndexMode });
    }
  }
  let commitOid: string;
  try {
    ({ commitOid } = await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes, modes, entries, deletes: moving.map(entry => entry.path) },
      {
        message: `Rename skill "${from}" -> "${to}"`,
        author,
        expectBlobs: {
          [oldRoot.slice(0, -1)]: await blobOidAt(
            repoDir,
            head,
            oldRoot.slice(0, -1),
          ),
          [newRoot.slice(0, -1)]: null,
        },
      },
    ));
  } catch (error) {
    if (error instanceof BlobPreconditionError) {
      return refuse(
        409,
        `${error.path} changed on main while renaming. Try again.`,
      );
    }
    throw error;
  }
  invalidateSkillCatalog(workspaceId);
  queueMirrorPush(workspaceId);
  return {
    ok: true,
    commitOid,
    aliasesAdded: aliases.filter(alias => !had.includes(alias)),
  };
}

/** Kept for the suppress route and older callers. */
export async function commitSkillSuppressed(
  workspaceId: string,
  name: string,
  suppressed: boolean,
  author?: GitAuthor,
): Promise<boolean> {
  return commitSkillFlags(workspaceId, name, { suppressed }, author);
}
