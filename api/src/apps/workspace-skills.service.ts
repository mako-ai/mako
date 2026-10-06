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
  commitBlobsOnBranch,
  globTree,
  listTree,
  readBlob,
  repoDirFor,
  resolveCommit,
  treeOidAt,
  type GitAuthor,
  type IndexEntry,
  type IndexMode,
} from "./repository.service";
import { findRenamedFolder } from "../rename/git-renames";
import {
  SKILLS_DIR,
  SKILLS_README,
  editSkillFrontMatterChecked,
  SKILLS_README_PATH,
  SKILL_FILE_GLOB,
  SKILL_NAME_RE,
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
        reason: "folder name must be lowercase snake_case (a-z, 0-9, _)",
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

/**
 * Lookup order for a name (api/src/rename/types.ts): the current name,
 * then an alias — and an alias only when exactly ONE skill claims it. Two
 * skills both claiming `old` (a rename, then a copy that kept the
 * frontmatter) resolve to neither: an old link must not silently open the
 * wrong playbook. A live name always beats an alias.
 */
export async function resolveSkillRef(
  workspaceId: string,
  name: string,
): Promise<{ skill: WorkspaceSkill; via: "current" | "alias" } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const catalog = await loadSkillCatalog(workspaceId);
  const current = catalog.skills.find(skill => skill.name === trimmed);
  const claimants = catalog.skills.filter(skill =>
    (skill.aliases ?? []).includes(trimmed),
  );
  // A SUPPRESSED current-name skill — an agent's unapproved proposal saved
  // under a name a live skill was renamed away from — does not beat that
  // skill's alias: `load_skill("old")` must keep answering with the
  // approved playbook, not the proposal's body. The proposal is still in
  // the catalog (listed, approvable by id); approving it retires the alias
  // and then the live name wins as usual.
  const liveClaimant =
    claimants.length === 1 && !claimants[0].suppressed ? claimants[0] : null;
  if (current && !(current.suppressed && liveClaimant)) {
    return { skill: current, via: "current" };
  }
  if (liveClaimant) return { skill: liveClaimant, via: "alias" };
  if (current) return { skill: current, via: "current" };
  return claimants.length === 1 ? { skill: claimants[0], via: "alias" } : null;
}

/**
 * Last resort for a name nothing claims: a folder renamed by a bare
 * `git mv` (no `aliases` written) is still a rename to git. Follows
 * `skills/<name>/SKILL.md` through main's rename history (bounded, see
 * rename/git-renames.ts) to the skill that lives there now. Spawns git, so
 * callers try `resolveSkillRef` first.
 */
export async function resolveSkillRefThroughHistory(
  workspaceId: string,
  name: string,
): Promise<{ skill: WorkspaceSkill; via: "alias" } | null> {
  const trimmed = name.trim();
  if (!SKILL_NAME_RE.test(trimmed)) return null;
  if (!(await getWorkspaceRepo(workspaceId))) return null;
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return null;
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) return null;
  // One git log per (main head, name): every `load_skill` of a system skill
  // misses the workspace catalog first, and a scan per miss would be a
  // process spawn per turn. The answer cannot change until main moves.
  const key = `${workspaceId}\0${head}\0${trimmed}`;
  let moved = historyCache.get(key);
  if (moved === undefined) {
    moved = await findRenamedFolder(
      repoDir,
      MAIN,
      SKILLS_DIR,
      trimmed,
      "SKILL.md",
    );
    historyCache.set(key, moved);
    while (historyCache.size > MAX_CACHED_HISTORY_LOOKUPS) {
      const oldest = historyCache.keys().next().value as string | undefined;
      if (!oldest) break;
      historyCache.delete(oldest);
    }
  }
  if (!moved || moved === trimmed) return null;
  const catalog = await loadSkillCatalog(workspaceId);
  const skill = catalog.skills.find(s => s.name === moved);
  return skill ? { skill, via: "alias" } : null;
}

/** (workspace, main head, name) → where the folder went, or null. Bounded. */
const MAX_CACHED_HISTORY_LOOKUPS = 512;
const historyCache = new Map<string, string | null>();

/** Skills whose `aliases` list `name` (a name another skill now holds). */
export async function aliasClaimantsOf(
  workspaceId: string,
  name: string,
): Promise<WorkspaceSkill[]> {
  const catalog = await loadSkillCatalog(workspaceId);
  return catalog.skills.filter(skill => (skill.aliases ?? []).includes(name));
}

/** A skill by its current name or (unambiguous) alias. */
export async function findSkill(
  workspaceId: string,
  name: string,
): Promise<WorkspaceSkill | null> {
  return (await resolveSkillRef(workspaceId, name))?.skill ?? null;
}

/**
 * A skill by id. Ids are derived from the name (`skillId`), so a rename
 * changes the id; an id minted from an old name (an open Skills panel, a
 * tool result in a transcript) still resolves through the alias — with the
 * same one-claimant rule as names.
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
 * Commit one skill save onto main. The first save on a repo also writes the
 * `skills/README.md` marker so the folder explains itself.
 */
export async function commitSkillSave(
  workspaceId: string,
  skill: WorkspaceSkillFile,
  options: {
    author?: GitAuthor;
    /**
     * A skill that still lists `skill.name` among its `aliases`: the new
     * skill takes the name, so the alias is retired from that file in the
     * same commit (a name must have one answer). Its file is rewritten
     * only when it parses; otherwise the save is refused rather than
     * leaving two claimants or clobbering a hand-written file.
     */
    retireAliasFrom?: string;
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
  if (options.retireAliasFrom) {
    const path = skillFilePath(options.retireAliasFrom);
    const raw = await readRepoFile(repoDir, path);
    const parsed =
      raw === null ? null : parseSkillFile(options.retireAliasFrom, raw);
    if (!parsed) {
      throw new Error(
        `"${skill.name}" is a previous name of the skill "${options.retireAliasFrom}", whose SKILL.md does not parse; fix it before reusing the name`,
      );
    }
    // A line edit of the front matter: the retired skill's file is one
    // the user did not touch, and nothing but its alias list may change.
    // Re-parsed before it is written — a file this cannot edit safely is
    // refused, and the save does not happen.
    const edited = editSkillFrontMatterChecked(
      options.retireAliasFrom,
      raw as string,
      {
        aliases: (parsed.aliases ?? []).filter(a => a !== skill.name),
      },
    );
    if (!edited.ok) {
      throw new Error(
        `"${skill.name}" is a previous name of the skill "${options.retireAliasFrom}": ${edited.reason}`,
      );
    }
    writes[path] = edited.contents;
    message += ` (retires the alias from "${options.retireAliasFrom}")`;
  }
  await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    { writes },
    { message, author: options.author },
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
     * Activating a proposal that was saved under a name another skill
     * still lists as an alias: the activated skill takes the name, so
     * that alias is retired in the same commit (see commitSkillSave).
     */
    retireAliasFrom?: string;
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
  if (options.retireAliasFrom && !next.suppressed) {
    const otherPath = skillFilePath(options.retireAliasFrom);
    const otherRaw = await readRepoFile(repoDir, otherPath);
    const other =
      otherRaw === null
        ? null
        : parseSkillFile(options.retireAliasFrom, otherRaw);
    const edited =
      other && otherRaw !== null
        ? editSkillFrontMatterChecked(options.retireAliasFrom, otherRaw, {
            aliases: (other.aliases ?? []).filter(a => a !== name),
          })
        : ({
            ok: false,
            reason: `skills/${options.retireAliasFrom}/SKILL.md does not parse`,
          } as const);
    if (!edited.ok) {
      throw new Error(
        `"${name}" is a previous name of the skill "${options.retireAliasFrom}": ${edited.reason}; fix it before activating`,
      );
    }
    writes[otherPath] = edited.contents;
    message += ` (retires the alias from "${options.retireAliasFrom}")`;
  }
  await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    { writes },
    {
      message,
      author,
    },
  );
  invalidateSkillCatalog(workspaceId);
  queueMirrorPush(workspaceId);
  return true;
}

export type SkillRenameOutcome =
  | { ok: true; commitOid: string; aliasesAdded: string[]; moved: string[] }
  | {
      ok: false;
      status: 400 | 404 | 409;
      error: string;
    };

/**
 * Rename a skill: move `skills/<from>/` to `skills/<to>/` (every file in
 * the folder, references included) and record `from` in the SKILL.md
 * front matter `aliases`, in ONE commit on main. The old name keeps
 * resolving (`resolveSkillRef`), and the record travels with the file.
 *
 * Refusals, in the order they are checked: bad names; `from` not a skill
 * (by current name — an alias is not a thing to rename again); `to`
 * already a skill's current name (never shadow a live one); `to` an alias
 * of ANOTHER skill (its old links would start opening this one). Renaming
 * back to one of the skill's OWN aliases is fine: the alias list just
 * swaps. A SKILL.md that does not parse is refused rather than rewritten —
 * a rename must not lose a byte of a playbook someone wrote by hand.
 */
export async function commitSkillRename(
  workspaceId: string,
  from: string,
  to: string,
  author?: GitAuthor,
): Promise<SkillRenameOutcome> {
  const fromName = from.trim();
  const toName = to.trim();
  if (!SKILL_NAME_RE.test(fromName) || !SKILL_NAME_RE.test(toName)) {
    return {
      ok: false,
      status: 400,
      error: "Skill names must be lowercase snake_case (a-z, 0-9, _)",
    };
  }
  if (fromName === toName) {
    return { ok: false, status: 400, error: "The new name is the old name" };
  }
  await requireWorkspaceRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  invalidateSkillCatalog(workspaceId);
  const catalog = await loadSkillCatalog(workspaceId);
  const current = catalog.skills.find(skill => skill.name === fromName);
  if (!current) {
    return { ok: false, status: 404, error: `No skill named "${fromName}"` };
  }
  if (catalog.skills.some(skill => skill.name === toName)) {
    return {
      ok: false,
      status: 409,
      error: `A skill named "${toName}" already exists`,
    };
  }
  const claimant = catalog.skills.find(
    skill => skill !== current && (skill.aliases ?? []).includes(toName),
  );
  if (claimant) {
    return {
      ok: false,
      status: 409,
      error: `"${toName}" is a previous name of the skill "${claimant.name}"; old links to it would open this skill instead`,
    };
  }
  const head = await resolveCommit(repoDir, MAIN);
  const oldEntries = head
    ? (await listTree(repoDir, head)).filter(e =>
        e.path.startsWith(`skills/${fromName}/`),
      )
    : [];
  const oldPaths = oldEntries.map(e => e.path);
  if (!head || oldPaths.length === 0) {
    return {
      ok: false,
      status: 404,
      error: `No files under skills/${fromName}/`,
    };
  }
  if (
    (await listTree(repoDir, head)).some(e =>
      e.path.startsWith(`skills/${toName}/`),
    )
  ) {
    return {
      ok: false,
      status: 409,
      error: `skills/${toName}/ already has files`,
    };
  }
  // Read at the commit whose tree was listed — the same one the commit
  // below pins — never at the live ref, which may already have moved.
  let raw: string | null = null;
  try {
    const blob = await readBlob(repoDir, head, skillFilePath(fromName));
    raw = blob.isBinary ? null : blob.contents;
  } catch {
    raw = null;
  }
  const parsed = raw === null ? null : parseSkillFile(fromName, raw);
  if (!parsed) {
    return {
      ok: false,
      status: 400,
      error: `skills/${fromName}/SKILL.md does not parse; fix its front matter before renaming so nothing is lost`,
    };
  }
  const aliases = [...new Set([...(parsed.aliases ?? []), fromName])].filter(
    alias => alias !== toName,
  );
  const aliasesAdded = aliases.filter(a => !(parsed.aliases ?? []).includes(a));
  // Only `name` and `aliases` change; comments, license, allowed-tools,
  // metadata and the body are the author's and are kept byte for byte.
  // The moved file is re-parsed under its NEW folder name before anything
  // is committed; a front matter the editor cannot handle is a 409 with
  // the hand fix, and the folder stays where it is.
  const renamedFile = editSkillFrontMatterChecked(toName, raw as string, {
    name: toName,
    aliases,
  });
  if (!renamedFile.ok) {
    return { ok: false, status: 409, error: renamedFile.reason };
  }

  // Every file but SKILL.md moves by oid with its mode (an executable
  // helper stays executable, a symlink stays a symlink); SKILL.md is the
  // one rewrite. The commit pins the OLD FOLDER'S TREE oid as listed and
  // requires the new folder absent: an edit, an added file or a delete
  // landing in between changes that oid, so the rename is refused (409)
  // instead of dropping or orphaning what landed.
  const writes: Record<string, string | Buffer> = {};
  const modes: Record<string, IndexMode> = {};
  const entries: IndexEntry[] = [];
  const expectBlobs: Record<string, string | null> = {
    [`skills/${fromName}`]: await treeOidAt(
      repoDir,
      head,
      `skills/${fromName}`,
    ),
    [`skills/${toName}`]: null,
  };
  const moved: string[] = [];
  for (const entry of oldEntries) {
    const newPath = `skills/${toName}/${entry.path.slice(`skills/${fromName}/`.length)}`;
    if (entry.path === skillFilePath(fromName)) {
      writes[newPath] = renamedFile.contents;
      if (entry.mode !== "100644") modes[newPath] = entry.mode as IndexMode;
    } else {
      entries.push({
        path: newPath,
        oid: entry.oid,
        mode: entry.mode as IndexMode,
      });
    }
    moved.push(newPath);
  }
  let result: Awaited<ReturnType<typeof commitBlobsOnBranch>>;
  try {
    result = await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes, modes, entries, deletes: oldPaths },
      {
        message: `Rename skill "${fromName}" -> "${toName}"`,
        author,
        expectBlobs,
      },
    );
  } catch (error) {
    if (error instanceof BlobPreconditionError) {
      return {
        ok: false,
        status: 409,
        error: `${error.path} changed on main while renaming — retry.`,
      };
    }
    throw error;
  }
  invalidateSkillCatalog(workspaceId);
  queueMirrorPush(workspaceId);
  return { ok: true, commitOid: result.commitOid, aliasesAdded, moved };
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
