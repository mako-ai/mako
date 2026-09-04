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
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  globTree,
  listTree,
  readBlob,
  repoDirFor,
  resolveCommit,
  type GitAuthor,
} from "./repository.service";
import {
  SKILLS_README,
  SKILLS_README_PATH,
  SKILL_FILE_GLOB,
  SKILL_NAME_RE,
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

const catalogCache = new Map<string, SkillCatalog>();

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
  const cached = catalogCache.get(workspaceId);
  if (cached && cached.head === head) return cached;

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
    try {
      const blob = await readBlob(repoDir, MAIN, path);
      contents = blob.isBinary ? null : blob.contents;
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
          contents === null
            ? "unreadable or binary skill file"
            : "unparseable skill file (frontmatter with `description` and a body are required)",
      });
      continue;
    }
    skills.push({ ...parsed, id: skillId(workspaceId, name), path });
  }
  const catalog: SkillCatalog = { workspaceId, head, skills, invalid };
  catalogCache.set(workspaceId, catalog);
  return catalog;
}

/** Drop the cached catalog; the next read rebuilds from main. */
export function invalidateSkillCatalog(workspaceId: string): void {
  catalogCache.delete(workspaceId);
}

export async function findSkill(
  workspaceId: string,
  name: string,
): Promise<WorkspaceSkill | null> {
  const trimmed = name.trim();
  const catalog = await loadSkillCatalog(workspaceId);
  return catalog.skills.find(skill => skill.name === trimmed) ?? null;
}

export async function findSkillById(
  workspaceId: string,
  id: string,
): Promise<WorkspaceSkill | null> {
  const catalog = await loadSkillCatalog(workspaceId);
  return catalog.skills.find(skill => skill.id === id) ?? null;
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
  options: { author?: GitAuthor } = {},
): Promise<void> {
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  const writes: Record<string, string> = {};
  if (!(await skillsAdopted(repoDir))) {
    writes[SKILLS_README_PATH] = SKILLS_README;
  }
  writes[skillFilePath(skill.name)] = serializeSkillFile(skill);
  await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    { writes },
    { message: `Save skill "${skill.name}"`, author: options.author },
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
  await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    { writes: { [path]: serializeSkillFile(next) } },
    { message: `${verbs.join(" + ")} skill "${name}"`, author },
  );
  invalidateSkillCatalog(workspaceId);
  queueMirrorPush(workspaceId);
  return true;
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
