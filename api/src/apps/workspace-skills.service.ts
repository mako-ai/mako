/**
 * Workspace skills in the workspace repo — git is the source of truth,
 * Mongo's `skills` collection is the DERIVED retrieval index (embeddings,
 * $text, useCount telemetry), the same doctrine consoles follow (apps.md
 * §10 Block D1, §16).
 *
 * Adoption: workspaces predate this layout, so `skills/README.md` on main is
 * the marker that git owns skills. Until it exists, Mongo may hold skills
 * git has never seen — the first skill save on a pre-existing workspace
 * adopts them all in one commit, and the sync never deletes index rows for
 * a repo that has not adopted. The workspace_skills_to_git migration
 * performs the same adoption for every workspace that already has a repo.
 *
 * Must not import worktree.service (it imports this module for the push
 * hook).
 */
import { Types } from "mongoose";
import { Skill, type ISkill } from "../database/workspace-schema";
import {
  embedText,
  getEmbeddingModelName,
  isEmbeddingAvailable,
} from "../services/embedding.service";
import { extractEntities } from "../agent-lib/entity-extraction";
import { loggers } from "../logging";
import {
  ensureWorkspaceRepo,
  freshenBeforeMainWrite,
  queueMirrorPush,
  resolveMirrorTarget,
} from "./cloud-repo.service";
import { RepoRequiredError, appsRequireConnectedRepo } from "./config";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  globTree,
  listTree,
  readBlob,
  repoDirFor,
  repoExists,
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

/** Mirrors skills.service's MAX_SKILLS_PER_WORKSPACE — bounds the index. */
const MAX_SYNCED_SKILLS = 200;

// Ref policy: skills pin to the default branch while their Mongo index is
// main-scoped — see branch-policy.ts (commitBranchFor "skill") for why.
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

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

/** Whether this repo's skills folder has been adopted (see module doc). */
export async function skillsAdopted(repoDir: string): Promise<boolean> {
  return (await readRepoFile(repoDir, SKILLS_README_PATH)) !== null;
}

/** Every parseable skill file on main. Missing repo/branch → empty. */
export async function listSkillFilesFromRepo(
  workspaceId: string,
): Promise<WorkspaceSkillFile[]> {
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return [];
  if (!(await resolveCommit(repoDir, MAIN))) return [];
  const paths = await globTree(repoDir, MAIN, SKILL_FILE_GLOB, 1000);
  const out: WorkspaceSkillFile[] = [];
  for (const path of paths.sort()) {
    const name = skillNameFromPath(path);
    if (!name) {
      logger.warn("Skipping skill file with invalid name", {
        workspaceId,
        path,
      });
      continue;
    }
    const raw = await readRepoFile(repoDir, path);
    const parsed = raw === null ? null : parseSkillFile(name, raw);
    if (!parsed) {
      logger.warn("Skipping unparseable skill file", { workspaceId, path });
      continue;
    }
    out.push(parsed);
  }
  return out;
}

/** Production gate (apps.md §17): no connected repo, no durable skill save. */
async function assertDurableWritable(workspaceId: string): Promise<void> {
  if (appsRequireConnectedRepo() && !(await resolveMirrorTarget(workspaceId))) {
    throw new RepoRequiredError();
  }
}

/**
 * Commit one skill save onto main. On a repo that has not adopted yet, the
 * same commit adopts: the caller's snapshot of the workspace's Mongo skills
 * (`loadAdoptable`, called lazily — only that first commit needs the bodies)
 * and the `skills/README.md` marker ride along, so no Mongo-only skill can
 * be orphaned by the sync afterwards.
 */
export async function commitSkillSave(
  workspaceId: string,
  skill: WorkspaceSkillFile,
  options: {
    author?: GitAuthor;
    loadAdoptable?: () => Promise<WorkspaceSkillFile[]>;
  } = {},
): Promise<void> {
  await assertDurableWritable(workspaceId);
  const repoDir = await ensureWorkspaceRepo(workspaceId, options.author);
  // Commit onto the mirror's main, not a stale cached tip.
  await freshenBeforeMainWrite(workspaceId);
  const writes: Record<string, string> = {};
  let message = `Save skill "${skill.name}"`;
  if (!(await skillsAdopted(repoDir))) {
    writes[SKILLS_README_PATH] = SKILLS_README;
    for (const existing of (await options.loadAdoptable?.()) ?? []) {
      if (existing.name === skill.name) continue;
      const path = skillFilePath(existing.name);
      if ((await readRepoFile(repoDir, path)) === null) {
        writes[path] = serializeSkillFile(existing);
      }
    }
    message = `Adopt workspace skills into git; save skill "${skill.name}"`;
  }
  writes[skillFilePath(skill.name)] = serializeSkillFile(skill);
  await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    { writes },
    { message, author: options.author },
  );
  queueMirrorPush(workspaceId);
}

/** Every path under a skill's folder (a laptop may have added extras). */
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

/**
 * Commit a skill deletion. No-op (returns false) when the repo or the file
 * does not exist — a Mongo-only skill on an unadopted workspace has nothing
 * to delete in git.
 */
export async function commitSkillDelete(
  workspaceId: string,
  name: string,
  author?: GitAuthor,
): Promise<boolean> {
  if (!SKILL_NAME_RE.test(name)) return false;
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return false;
  await freshenBeforeMainWrite(workspaceId);
  const deletes = await skillFolderPaths(repoDir, name);
  if (deletes.length === 0) return false;
  await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    { deletes },
    { message: `Delete skill "${name}"`, author },
  );
  queueMirrorPush(workspaceId);
  return true;
}

/**
 * Commit a suppressed-flag flip by rewriting the file's frontmatter. No-op
 * when the file is not in git yet (unadopted workspace).
 */
export async function commitSkillSuppressed(
  workspaceId: string,
  name: string,
  suppressed: boolean,
  author?: GitAuthor,
): Promise<boolean> {
  if (!SKILL_NAME_RE.test(name)) return false;
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return false;
  await freshenBeforeMainWrite(workspaceId);
  const path = skillFilePath(name);
  const raw = await readRepoFile(repoDir, path);
  const parsed = raw === null ? null : parseSkillFile(name, raw);
  if (!parsed) return false;
  if (parsed.suppressed === suppressed) return true;
  await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    { writes: { [path]: serializeSkillFile({ ...parsed, suppressed }) } },
    {
      message: `${suppressed ? "Suppress" : "Unsuppress"} skill "${name}"`,
      author,
    },
  );
  queueMirrorPush(workspaceId);
  return true;
}

function sameEntities(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every(e => bs.has(e));
}

/** Declared (file) entities ∪ extracted — same union saveSkill computes. */
function indexEntities(skill: WorkspaceSkillFile): string[] {
  const extracted = extractEntities(`${skill.loadWhen}\n${skill.body}`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...skill.entities, ...extracted]) {
    const norm = raw.toLowerCase().trim();
    if (norm.length < 2 || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

async function embeddingFor(
  loadWhen: string,
  workspaceId: string,
): Promise<{ embedding?: number[]; model?: string }> {
  if (!isEmbeddingAvailable()) return {};
  try {
    const embedding = await embedText(loadWhen, { workspaceId });
    if (!embedding) return {};
    return { embedding, model: getEmbeddingModelName() ?? undefined };
  } catch (error) {
    logger.warn("Skill embedding failed during index sync", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/**
 * Reconcile the Mongo retrieval index with the repo's skills/ folder —
 * called after every push to the git endpoint (worktree.service
 * notifyRepoPushed) so a skill edited in a terminal or a laptop clone is in
 * the agent's index by its next turn.
 *
 * Deliberately conservative: it never touches an unadopted repo (Mongo may
 * hold skills git has never seen), it preserves telemetry (useCount,
 * lastUsedAt) and createdBy on update, and it re-embeds only when the
 * trigger text actually changed.
 */
export async function syncSkillsIndexFromRepo(
  workspaceId: string,
  userId?: string,
): Promise<void> {
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return;
  if (!(await skillsAdopted(repoDir))) return;

  let files = await listSkillFilesFromRepo(workspaceId);
  if (files.length > MAX_SYNCED_SKILLS) {
    logger.warn(
      "Workspace has more skill files than the index cap; truncating",
      {
        workspaceId,
        fileCount: files.length,
        cap: MAX_SYNCED_SKILLS,
      },
    );
    files = files.slice(0, MAX_SYNCED_SKILLS);
  }

  const wsObjectId = new Types.ObjectId(workspaceId);
  const rows = (await Skill.find({ workspaceId: wsObjectId })) as ISkill[];
  const rowByName = new Map(rows.map(r => [r.name, r]));
  const fileNames = new Set(files.map(f => f.name));

  for (const file of files) {
    const entities = indexEntities(file);
    const row = rowByName.get(file.name);
    if (!row) {
      const { embedding, model } = await embeddingFor(
        file.loadWhen,
        workspaceId,
      );
      await Skill.create({
        workspaceId: wsObjectId,
        name: file.name,
        loadWhen: file.loadWhen,
        body: file.body,
        entities,
        declaredEntities: file.entities,
        loadWhenEmbedding: embedding,
        embeddingModel: model,
        scopeType: "workspace",
        createdBy: userId && userId.length > 0 ? userId : "agent",
        suppressed: file.suppressed,
        useCount: 0,
      });
      continue;
    }
    const unchanged =
      row.loadWhen === file.loadWhen &&
      row.body === file.body &&
      row.suppressed === file.suppressed &&
      sameEntities(row.entities ?? [], entities) &&
      sameEntities(row.declaredEntities ?? [], file.entities);
    if (unchanged) continue;
    if (row.body !== file.body) {
      row.previousBody = row.body;
      row.previousUpdatedAt = row.updatedAt;
    }
    if (row.loadWhen !== file.loadWhen) {
      const { embedding, model } = await embeddingFor(
        file.loadWhen,
        workspaceId,
      );
      if (embedding) {
        row.loadWhenEmbedding = embedding;
        row.embeddingModel = model;
      }
    }
    row.loadWhen = file.loadWhen;
    row.body = file.body;
    row.entities = entities;
    row.declaredEntities = file.entities;
    row.suppressed = file.suppressed;
    await row.save();
  }

  const stale = rows.filter(r => !fileNames.has(r.name));
  if (stale.length > 0) {
    await Skill.deleteMany({
      workspaceId: wsObjectId,
      _id: { $in: stale.map(r => r._id) },
    });
  }
}

/**
 * Adopt a workspace's Mongo skills into its repo: write every skill file
 * that is missing plus the `skills/README.md` marker, in one commit. Used
 * by the workspace_skills_to_git migration (repos that already exist) —
 * the first skill save adopts lazily everywhere else. Re-runnable.
 */
export async function adoptWorkspaceSkills(workspaceId: string): Promise<{
  workspaceId: string;
  skills: number;
  written: number;
  adopted: boolean;
}> {
  const rows = (await Skill.find({
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .select("name loadWhen body declaredEntities suppressed")
    .lean()) as Array<
    Pick<
      ISkill,
      "name" | "loadWhen" | "body" | "declaredEntities" | "suppressed"
    >
  >;
  const repoDir = await ensureWorkspaceRepo(workspaceId);
  const alreadyAdopted = await skillsAdopted(repoDir);
  const writes: Record<string, string> = {};
  for (const row of rows) {
    if (!SKILL_NAME_RE.test(row.name)) {
      logger.warn("Skipping skill with a name git cannot hold", {
        workspaceId,
        name: row.name,
      });
      continue;
    }
    const path = skillFilePath(row.name);
    if ((await readRepoFile(repoDir, path)) !== null) continue;
    // The file carries what the author declared, never the derived
    // retrieval index (`entities` = declared ∪ extracted body tokens).
    writes[path] = serializeSkillFile({
      name: row.name,
      loadWhen: row.loadWhen,
      entities: row.declaredEntities ?? [],
      suppressed: !!row.suppressed,
      body: row.body,
    });
  }
  if (!alreadyAdopted) writes[SKILLS_README_PATH] = SKILLS_README;
  const written = Object.keys(writes).length;
  if (written > 0) {
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes },
      {
        message: `Adopt workspace skills into git (${rows.length} skill${rows.length === 1 ? "" : "s"})`,
      },
    );
    queueMirrorPush(workspaceId);
  }
  return { workspaceId, skills: rows.length, written, adopted: true };
}
