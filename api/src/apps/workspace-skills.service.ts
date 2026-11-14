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
  listTree,
  readBlob,
  repoDirFor,
  resolveCommit,
  type GitAuthor,
} from "./repository.service";
import {
  SKILLS_README,
  SKILLS_README_PATH,
  SKILLS_DIR,
  SKILL_NAME_RE,
  SKILL_NAME_RULE,
  canonicalSkillName,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_RESOURCE_BYTES,
  MAX_WORKSPACE_SKILLS,
  classifySkillResources,
  formatCount,
  normalizeSkillResourcePath,
  parseSkillFile,
  parseSkillFileDetailed,
  serializeSkillFile,
  skillFilePath,
  skillNameFromPath,
  type RefusedSkillResource,
  type SkillResource,
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
  /** Files `read_skill_resource` serves, relative to the skill folder. */
  resources: SkillResource[];
  /** Files under a resource folder that are not served, with why. */
  refusedResources: RefusedSkillResource[];
}

/** A `skills/<name>/SKILL.md` at main that does not parse. Listed, never offered. */
export interface InvalidSkillFile {
  name: string;
  path: string;
  reason: string;
}

/** Something about a loaded skill its author should fix. Never hides it. */
export interface SkillFileWarning {
  name: string;
  path: string;
  reason: string;
}

/**
 * What the index shows of a description. skills.service imports this module,
 * so the number lives here and is re-exported there.
 */
export const INDEX_DESCRIPTION_CHARS = 200;

export interface SkillCatalog {
  workspaceId: string;
  /** Main commit the catalog was built from; null when there is no repo. */
  head: string | null;
  /** Valid skills, sorted by name. */
  skills: WorkspaceSkill[];
  invalid: InvalidSkillFile[];
  /** Loaded skills with a problem worth a line: a cut description, a refused resource. */
  warnings: SkillFileWarning[];
  /**
   * A skill file could not be read from git (a timeout, a spawn error): it
   * sits in `invalid` for this read only. The catalog is not cached and no
   * commit status is posted from it, so the next read tries again.
   */
  incomplete?: boolean;
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
  return { workspaceId, head: null, skills: [], invalid: [], warnings: [] };
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
  // Two readers of a new head share one build (and one catalog object): a
  // save is followed at once by its own status report and the caller's read.
  const building = catalogBuilds.get(workspaceId);
  if (building && building.head === head) return building.catalog;
  const build = {
    head,
    catalog: buildSkillCatalog(workspaceId, repoDir, head),
  };
  catalogBuilds.set(workspaceId, build);
  try {
    const catalog = await build.catalog;
    // An invalidation during the build means this result may be stale; a
    // read error means it is incomplete. Neither is kept.
    if (catalogBuilds.get(workspaceId) === build && !catalog.incomplete) {
      cacheCatalog(workspaceId, catalog);
    }
    return catalog;
  } finally {
    if (catalogBuilds.get(workspaceId) === build) {
      catalogBuilds.delete(workspaceId);
    }
  }
}

const catalogBuilds = new Map<
  string,
  { head: string; catalog: Promise<SkillCatalog> }
>();

async function buildSkillCatalog(
  workspaceId: string,
  repoDir: string,
  head: string,
): Promise<SkillCatalog> {
  const skills: WorkspaceSkill[] = [];
  const invalid: InvalidSkillFile[] = [];
  const warnings: SkillFileWarning[] = [];
  let incomplete = false;
  // One tree read serves both the skill files and their resource folders.
  const tree = (await listTree(repoDir, head)).filter(entry =>
    entry.path.startsWith(`${SKILLS_DIR}/`),
  );
  const paths = tree
    .map(entry => entry.path)
    .filter(path => /^skills\/[^/]+\/SKILL\.md$/.test(path))
    .slice(0, 1000);
  const sizeOf = new Map(tree.map(entry => [entry.path, entry.size]));
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
    // The tree already knows the size: an oversized file is never read.
    const treeSize = sizeOf.get(path) ?? 0;
    if (treeSize > MAX_SKILL_FILE_BYTES) {
      invalidReason = `file ${formatCount(treeSize)} bytes over the ${formatCount(MAX_SKILL_FILE_BYTES)} limit`;
    } else {
      try {
        const blob = await readBlob(repoDir, head, path);
        if (blob.isBinary) {
          invalidReason = "binary file: SKILL.md must be text";
        } else {
          contents = blob.contents;
        }
      } catch (error) {
        // The path came from this commit's tree, so the file exists: a
        // failed read is the machine's problem, not the author's.
        incomplete = true;
        invalidReason = "the file could not be read just now; retry";
        logger.warn("Unreadable skill file at main", {
          workspaceId,
          path,
          error,
        });
      }
    }
    const result =
      contents === null ? null : parseSkillFileDetailed(name, contents);
    if (!result || !result.ok) {
      invalid.push({
        name,
        path,
        reason:
          invalidReason ?? (result ? result.reason : "the file is unreadable"),
      });
      continue;
    }
    const parsed = result.skill;
    if (parsed.body.length > MAX_SKILL_BODY_CHARS) {
      invalid.push({
        name,
        path,
        reason: `body ${formatCount(parsed.body.length)} chars over the ${formatCount(MAX_SKILL_BODY_CHARS)} limit`,
      });
      continue;
    }
    if (skills.length >= MAX_WORKSPACE_SKILLS) {
      invalid.push({
        name,
        path,
        reason: `over the ${MAX_WORKSPACE_SKILLS} skills per workspace limit`,
      });
      continue;
    }
    const folder = `${SKILLS_DIR}/${name}/`;
    const { resources, refused } = classifySkillResources(
      tree
        .filter(entry => entry.path.startsWith(folder))
        .map(entry => ({
          path: entry.path.slice(folder.length),
          size: entry.size,
          mode: entry.mode,
        })),
    );
    if (parsed.loadWhen.length > INDEX_DESCRIPTION_CHARS) {
      warnings.push({
        name,
        path,
        reason: `description ${formatCount(parsed.loadWhen.length)} chars: the index shows the first ${INDEX_DESCRIPTION_CHARS}`,
      });
    }
    for (const file of refused) {
      warnings.push({
        name,
        path: `${folder}${file.path}`,
        reason: `resource not served: ${file.reason}`,
      });
    }
    skills.push({
      ...parsed,
      id: skillId(workspaceId, name),
      path,
      resources,
      refusedResources: refused,
    });
  }
  return {
    workspaceId,
    head,
    skills,
    invalid,
    warnings,
    ...(incomplete ? { incomplete: true } : {}),
  };
}

/** Drop the cached catalog; the next read rebuilds from main. */
export function invalidateSkillCatalog(workspaceId: string): void {
  catalogCache.delete(workspaceId);
  catalogBuilds.delete(workspaceId);
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

export async function findSkillById(
  workspaceId: string,
  id: string,
): Promise<WorkspaceSkill | null> {
  const catalog = await loadSkillCatalog(workspaceId);
  return catalog.skills.find(skill => skill.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Resources — extra files in the skill folder, read-only
// ---------------------------------------------------------------------------

export type SkillResourceRead =
  | {
      success: true;
      skill: string;
      path: string;
      content: string;
      size: number;
      /** Every resource path of the skill, as the system-skill read returns. */
      references: string[];
    }
  | { success: false; error: string };

/**
 * One resource file of a workspace skill, read at main. A path is served
 * only when it is one of the skill's listed
 * resources: the list comes from the git tree under the skill's own folder,
 * so no spelling of a path can reach a file outside it. Nothing is executed.
 */
export async function readWorkspaceSkillResource(
  workspaceId: string,
  skill: WorkspaceSkill,
  relPath: string,
): Promise<SkillResourceRead> {
  const normalized = normalizeSkillResourcePath(relPath);
  if (!normalized.ok) return { success: false, error: normalized.error };
  const listed = skill.resources.find(file => file.path === normalized.path);
  if (!listed) {
    const refused = skill.refusedResources.find(
      file => file.path === normalized.path,
    );
    if (refused) {
      return {
        success: false,
        error: `resource "${normalized.path}" of skill "${skill.name}" is not served: ${refused.reason}`,
      };
    }
    const available = skill.resources.map(file => file.path);
    return {
      success: false,
      error:
        `resource "${normalized.path}" not found for skill "${skill.name}". ` +
        (available.length > 0
          ? `Available: ${available.join(", ")}`
          : "This skill has no resources."),
    };
  }
  const repoDir = await boundRepoDirIfExists(workspaceId);
  const head = repoDir ? await resolveCommit(repoDir, MAIN) : null;
  if (repoDir == null || !head) {
    return { success: false, error: "the workspace repository is unavailable" };
  }
  try {
    const blob = await readBlob(
      repoDir,
      head,
      `${SKILLS_DIR}/${skill.name}/${listed.path}`,
    );
    if (blob.isBinary) {
      return {
        success: false,
        error: `resource "${listed.path}" is a binary file: only text is served`,
      };
    }
    if (blob.size > MAX_SKILL_RESOURCE_BYTES) {
      return {
        success: false,
        error: `resource "${listed.path}" is ${formatCount(blob.size)} bytes, over the ${formatCount(MAX_SKILL_RESOURCE_BYTES)} limit`,
      };
    }
    return {
      success: true,
      skill: skill.name,
      path: listed.path,
      content: blob.contents,
      size: blob.size,
      references: skill.resources.map(file => file.path),
    };
  } catch (error) {
    logger.warn("Unreadable skill resource at main", {
      workspaceId,
      skill: skill.name,
      path: listed.path,
      error,
    });
    return {
      success: false,
      error: `resource "${listed.path}" not found for skill "${skill.name}"`,
    };
  }
}

// ---------------------------------------------------------------------------
// Writes — commits on main
// ---------------------------------------------------------------------------

/**
 * A save, delete or flag flip moved main without a push event: report the
 * new head's skills status too. Imported lazily (the status module imports
 * this one), fire-and-forget, never throws.
 */
function reportSkillsStatusAfterWrite(workspaceId: string): void {
  void import("./skill-commit-status")
    .then(m => m.reportSkillsCommitStatus(workspaceId))
    .catch(error => {
      logger.warn("Skills commit status after a write failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

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
  reportSkillsStatusAfterWrite(workspaceId);
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
  reportSkillsStatusAfterWrite(workspaceId);
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
  reportSkillsStatusAfterWrite(workspaceId);
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
