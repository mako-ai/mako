/**
 * Workspace skills in the workspace repo — git is the source of truth,
 * Mongo's `skills` collection is the DERIVED retrieval index (embeddings,
 * $text, useCount telemetry, SHA), the same doctrine consoles follow
 * (apps.md §10 Block D1, §16).
 *
 * Adoption: workspaces predate this layout, so `skills/README.md` on main is
 * the marker that git owns skills. Until it exists, Mongo may hold skills
 * git has never seen — the first skill save on a pre-existing workspace
 * adopts them all in one commit, and the sync never deletes index rows for
 * a repo that has not adopted. The workspace_skills_to_git migration
 * performs the same adoption for every workspace that already has a repo.
 *
 * GET/list serves the files at main and overlays Mongo for id, telemetry,
 * SHA, and embeddings (issue #956, same contract as consoles/flows). Leftover
 * local git without a GitHub binding is not a read surface —
 * `boundRepoDirIfExists` / `getWorkspaceRepo` gate every walk. Unbound
 * GET/list is empty, never 412. GET/list must not create, delete, or
 * reconcile the index — SHA mismatch resyncs existing rows only.
 *
 * Must not import worktree.service (it imports this module for the push
 * hook).
 */
import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { Skill, type ISkill } from "../database/workspace-schema";
import {
  embedText,
  getEmbeddingModelName,
  isEmbeddingAvailable,
} from "../services/embedding.service";
import { extractEntities } from "../agent-lib/entity-extraction";
import { getWorkspaceRepo } from "../services/workspace-repos.service";
import { loggers } from "../logging";
import { freshenBeforeMainWrite, queueMirrorPush } from "./cloud-repo.service";
import {
  requireWorkspaceRepo,
  boundRepoDirIfExists,
} from "./workspace-repo-required";
import {
  DEFAULT_BRANCH,
  blobOid,
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

/** Mirrors skills.service's MAX_SKILLS_PER_WORKSPACE — bounds the index. */
const MAX_SYNCED_SKILLS = 200;

// Ref policy: skills pin to the default branch while their Mongo index is
// main-scoped — see branch-policy.ts (commitBranchFor "skill") for why.
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

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
): Promise<{ embedding?: number[]; model?: string }> {
  if (!isEmbeddingAvailable()) return {};
  try {
    const embedding = await embedText(loadWhen);
    if (!embedding) return {};
    return { embedding, model: getEmbeddingModelName() ?? undefined };
  } catch (error) {
    logger.warn("Skill embedding failed during index sync", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
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

/** Whether this repo's skills folder has been adopted (see module doc). */
export async function skillsAdopted(repoDir: string): Promise<boolean> {
  return (await readRepoFile(repoDir, SKILLS_README_PATH)) !== null;
}

// ---------------------------------------------------------------------------
// GET/list — git is the definition, Mongo is the overlay
// ---------------------------------------------------------------------------

/** Mirrors skills.service / SkillSchema maxlength — a file past these cannot save. */
const MAX_LOAD_WHEN_LENGTH = 500;
const MAX_BODY_LENGTH = 20000;

/**
 * Stable id for a skill that exists as `skills/<name>/SKILL.md` but has no
 * index row yet (same contract as `derivedConsoleId` / `derivedFlowId`).
 */
export function derivedSkillId(
  workspaceId: string,
  name: string,
): Types.ObjectId {
  const digest = createHash("sha1")
    .update(`skills:${workspaceId}:${name}`)
    .digest("hex");
  return new Types.ObjectId(digest.slice(0, 24));
}

export interface SkillDefinitionAtMain {
  path: string;
  name: string;
  oid: string;
  contents: string;
  parsed: WorkspaceSkillFile | null;
}

export interface LiveSkill {
  def: SkillDefinitionAtMain;
  row: ISkill | null;
  id: Types.ObjectId;
}

function rowAsPlain(row: ISkill): Record<string, unknown> {
  const maybeToObject = row as ISkill & {
    toObject?: () => Record<string, unknown>;
  };
  if (typeof maybeToObject.toObject === "function") {
    return maybeToObject.toObject();
  }
  return { ...(row as unknown as Record<string, unknown>) };
}

/**
 * Authored skill files at `main`. Empty when no GitHub repo is bound —
 * leftover local git is not a definition store (issue #956). Never throws
 * `RepoRequiredError`; a missing binding is an empty list, not 412.
 */
export async function listSkillDefinitionsAtMain(
  workspaceId: string,
): Promise<SkillDefinitionAtMain[]> {
  if (!(await getWorkspaceRepo(workspaceId))) return [];
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return [];
  if (!(await resolveCommit(repoDir, MAIN))) return [];
  const paths = await globTree(repoDir, MAIN, SKILL_FILE_GLOB, 1000);
  const defs: SkillDefinitionAtMain[] = [];
  for (const path of paths.sort()) {
    const name = skillNameFromPath(path);
    if (!name) {
      logger.warn("Skipping skill file with invalid name", {
        workspaceId,
        path,
      });
      continue;
    }
    try {
      const blob = await readBlob(repoDir, MAIN, path);
      if (blob.isBinary) {
        logger.warn("Unreadable binary skill file at main", {
          workspaceId,
          path,
        });
        defs.push({
          path,
          name,
          oid: blobOid(Buffer.from(blob.contents, "base64")),
          contents: "",
          parsed: null,
        });
        continue;
      }
      const parsed = parseSkillFile(name, blob.contents);
      if (!parsed) {
        logger.warn("Unparseable skill file at main", { workspaceId, path });
      }
      defs.push({
        path,
        name,
        oid: blobOid(blob.contents),
        contents: blob.contents,
        parsed,
      });
    } catch {
      logger.warn("Unreadable skill file at main", { workspaceId, path });
      defs.push({
        path,
        name,
        oid: "unreadable",
        contents: "",
        parsed: null,
      });
    }
  }
  return defs;
}

/** Every parseable skill file on main. Missing repo/branch → empty. */
export async function listSkillFilesFromRepo(
  workspaceId: string,
): Promise<WorkspaceSkillFile[]> {
  return (await listSkillDefinitionsAtMain(workspaceId)).flatMap(def =>
    def.parsed ? [def.parsed] : [],
  );
}

function skillIndexDrift(
  defs: SkillDefinitionAtMain[],
  rows: ISkill[],
): boolean {
  const byName = new Map<string, ISkill>();
  for (const row of rows) {
    byName.set(row.name, row);
  }
  for (const def of defs) {
    const row = byName.get(def.name);
    if (!row) continue;
    if (row.sourceBlobSha !== def.oid) return true;
    if (row.definitionInvalid && def.parsed) return true;
  }
  return false;
}

/**
 * A file the reactor would refuse to save must not look valid in GET.
 * Lengths match SkillSchema; name matches the folder identity contract.
 */
export function skillFileApplyFailure(file: WorkspaceSkillFile): string | null {
  if (!SKILL_NAME_RE.test(file.name)) {
    return "name must be lowercase snake_case (a-z, 0-9, underscore)";
  }
  if (!file.loadWhen || file.loadWhen.trim().length === 0) {
    return "loadWhen is required";
  }
  if (file.loadWhen.length > MAX_LOAD_WHEN_LENGTH) {
    return `loadWhen exceeds ${MAX_LOAD_WHEN_LENGTH} characters`;
  }
  if (!file.body || file.body.trim().length === 0) {
    return "body is required";
  }
  if (file.body.length > MAX_BODY_LENGTH) {
    return `body exceeds ${MAX_BODY_LENGTH} characters`;
  }
  return null;
}

function applySkillDefinition(doc: ISkill, file: WorkspaceSkillFile): void {
  doc.name = file.name;
  doc.loadWhen = file.loadWhen;
  doc.body = file.body;
  doc.declaredEntities = file.entities;
  doc.entities = indexEntities(file);
  doc.suppressed = file.suppressed;
}

async function markSkillInvalid(
  doc: ISkill,
  reason: string,
  path: string,
): Promise<void> {
  // $set only the invalid stamp. Saving the loaded document re-runs the
  // whole schema (createdBy required, maxlength, …) and 500s GET/list
  // when the last-good row itself cannot save.
  try {
    await Skill.updateOne(
      { _id: doc._id },
      { $set: { definitionInvalid: { reason, at: new Date(), path } } },
    );
  } catch (error) {
    logger.warn("Failed to mark skill invalid", {
      skillId: doc._id.toString(),
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * SHA-check derived rows against blobs at main; resync matching rows on
 * mismatch. Does not create or delete — GET/list must not mint index rows.
 * Git-only files stay git-only until push-sync.
 */
export async function ensureSkillsDerivedCache(
  workspaceId: string,
): Promise<"ok" | "resynced" | "unbound"> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return "unbound";
  const defs = await listSkillDefinitionsAtMain(workspaceId);
  const rows = await Skill.find({
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (!skillIndexDrift(defs, rows)) return "ok";
  const byName = new Map<string, ISkill>();
  for (const row of rows) {
    byName.set(row.name, row);
  }
  for (const def of defs) {
    const row = byName.get(def.name);
    if (!row) continue;
    try {
      await ensureSkillDerivedCache(row);
    } catch (error) {
      logger.warn("ensureSkillDerivedCache failed", {
        workspaceId,
        name: def.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return "resynced";
}

function joinLiveSkills(
  workspaceId: string,
  defs: SkillDefinitionAtMain[],
  rows: ISkill[],
): LiveSkill[] {
  const byName = new Map<string, ISkill>();
  for (const row of rows) {
    byName.set(row.name, row);
  }
  return defs.map(def => {
    const row = byName.get(def.name) ?? null;
    return {
      def,
      row,
      id: row?._id ?? derivedSkillId(workspaceId, def.name),
    };
  });
}

/**
 * Live skills: files at main, overlaying the Mongo index.
 *
 * Unbound workspace → `[]` (leftover Mongo rows and leftover local git do
 * not populate the list). Git-only files appear; Mongo-only rows do not.
 */
export async function loadLiveSkills(
  workspaceId: string,
): Promise<LiveSkill[]> {
  let status: "ok" | "resynced" | "unbound";
  try {
    status = await ensureSkillsDerivedCache(workspaceId);
  } catch (error) {
    logger.warn("ensureSkillsDerivedCache failed", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    status = "ok";
  }
  if (status === "unbound") return [];
  const defs = await listSkillDefinitionsAtMain(workspaceId);
  const rows = await Skill.find({
    workspaceId: new Types.ObjectId(workspaceId),
  });
  return joinLiveSkills(workspaceId, defs, rows);
}

/**
 * Resolve a skill id for GET. Live only when `skills/<name>/SKILL.md`
 * exists at main. Unbound or Mongo-only → `null` (404).
 */
export async function loadLiveSkillById(
  workspaceId: string,
  skillId: string,
): Promise<LiveSkill | null> {
  if (!Types.ObjectId.isValid(skillId)) return null;
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return null;

  const row = await Skill.findOne({
    _id: new Types.ObjectId(skillId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (row) {
    const defs = await listSkillDefinitionsAtMain(workspaceId);
    const def = defs.find(item => item.name === row.name);
    if (!def) return null;
    if (row.sourceBlobSha !== def.oid || row.definitionInvalid) {
      try {
        await ensureSkillDerivedCache(row);
      } catch (error) {
        logger.warn("ensureSkillDerivedCache failed for GET by id", {
          workspaceId,
          skillId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { def, row, id: row._id };
  }

  const live = await loadLiveSkills(workspaceId);
  return live.find(item => item.id.toString() === skillId) ?? null;
}

/**
 * Git definition overlaid on the Mongo index row (or a stub when the
 * file has no row). The body comes from the file when it parses AND
 * would save; a file the reactor would refuse must not look valid in GET.
 */
export function liveSkillToPlain(
  live: LiveSkill,
  workspaceId: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = live.row
    ? rowAsPlain(live.row)
    : {
        _id: live.id,
        workspaceId: new Types.ObjectId(workspaceId),
        name: live.def.name,
        loadWhen: "",
        body: "",
        entities: [],
        declaredEntities: [],
        suppressed: false,
        createdBy: "git",
        useCount: 0,
        scopeType: "workspace",
      };
  base._id = live.id;
  base.name = live.def.name;
  base.workspaceId = live.row?.workspaceId ?? new Types.ObjectId(workspaceId);
  const parsed = live.def.parsed;
  if (!parsed) {
    base.definitionInvalid = live.row?.definitionInvalid ?? {
      reason: "unparseable skill file",
      at: new Date(),
      path: live.def.path,
    };
    base.sourceBlobSha = live.def.oid;
    return base;
  }
  let applyFailure: string | null;
  try {
    applyFailure = skillFileApplyFailure(parsed);
  } catch (error) {
    applyFailure = error instanceof Error ? error.message : String(error);
  }
  if (applyFailure) {
    base.definitionInvalid = live.row?.definitionInvalid ?? {
      reason: applyFailure,
      at: new Date(),
      path: live.def.path,
    };
    base.sourceBlobSha = live.def.oid;
    return base;
  }
  try {
    applySkillDefinition(base as unknown as ISkill, parsed);
  } catch (error) {
    base.definitionInvalid = live.row?.definitionInvalid ?? {
      reason: error instanceof Error ? error.message : String(error),
      at: new Date(),
      path: live.def.path,
    };
    base.sourceBlobSha = live.def.oid;
    return base;
  }
  base.sourceBlobSha = live.def.oid;
  delete base.definitionInvalid;
  return base;
}

/**
 * SHA-check the derived cache against `skills/<name>/SKILL.md` at main.
 * Resyncs the row when the blob moved; never writes Mongo over an invalid file.
 * Leftover local git without a GitHub binding is ignored — runtime keeps
 * the SHA-checked Mongo cache (issue #956).
 */
export async function ensureSkillDerivedCache(skill: {
  _id: { toString(): string };
  workspaceId: { toString(): string };
  name?: string;
  sourceBlobSha?: string;
  definitionInvalid?: { reason: string } | null;
}): Promise<"ok" | "invalid" | "missing" | "resynced"> {
  if (!skill.name) return "ok";
  if (!SKILL_NAME_RE.test(skill.name)) {
    return skill.definitionInvalid ? "invalid" : "ok";
  }
  const workspaceId = skill.workspaceId.toString();
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) {
    return skill.definitionInvalid ? "invalid" : "ok";
  }
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) return skill.definitionInvalid ? "invalid" : "ok";
  const path = skillFilePath(skill.name);
  let contents: string;
  try {
    const blob = await readBlob(repoDir, head, path);
    if (blob.isBinary) {
      const row = await Skill.findById(skill._id);
      if (row) await markSkillInvalid(row, "binary skill file", path);
      return "invalid";
    }
    contents = blob.contents;
  } catch {
    const row = await Skill.findById(skill._id);
    if (row) await markSkillInvalid(row, "skill file missing at main", path);
    return "missing";
  }
  const sha = blobOid(contents);
  if (skill.sourceBlobSha === sha && !skill.definitionInvalid) return "ok";
  const parsed = parseSkillFile(skill.name, contents);
  const row = await Skill.findById(skill._id);
  if (!row) return "missing";
  if (!parsed) {
    await markSkillInvalid(row, "unparseable skill file", path);
    return "invalid";
  }
  try {
    if (row.body !== parsed.body) {
      row.previousBody = row.body;
      row.previousUpdatedAt = row.updatedAt;
    }
    if (row.loadWhen !== parsed.loadWhen) {
      const { embedding, model } = await embeddingFor(parsed.loadWhen);
      if (embedding) {
        row.loadWhenEmbedding = embedding;
        row.embeddingModel = model;
      }
    }
    applySkillDefinition(row, parsed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fresh = await Skill.findById(skill._id);
    if (fresh) await markSkillInvalid(fresh, reason, path);
    return "invalid";
  }
  row.definitionInvalid = undefined;
  row.sourceBlobSha = sha;
  try {
    await row.save();
  } catch (error) {
    // applySkillDefinition already mutated `row`. Saving that document
    // again (via markSkillInvalid) would re-raise the same ValidationError
    // and 500 GET/list. Reload the persisted row, then stamp invalid.
    const reason = error instanceof Error ? error.message : String(error);
    const fresh = await Skill.findById(skill._id);
    if (fresh) await markSkillInvalid(fresh, reason, path);
    return "invalid";
  }
  return "resynced";
}

/** No local git repo, no durable skill mutation (issue #956). */
async function assertDurableWritable(workspaceId: string): Promise<void> {
  await requireWorkspaceRepo(workspaceId);
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
  const repoDir = await requireWorkspaceRepo(workspaceId);
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
  await requireWorkspaceRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
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
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return;
  if (!(await skillsAdopted(repoDir))) return;

  const defs = await listSkillDefinitionsAtMain(workspaceId);
  let parsedDefs = defs.filter(
    (def): def is SkillDefinitionAtMain & { parsed: WorkspaceSkillFile } =>
      def.parsed !== null,
  );
  if (parsedDefs.length > MAX_SYNCED_SKILLS) {
    logger.warn(
      "Workspace has more skill files than the index cap; truncating",
      {
        workspaceId,
        fileCount: parsedDefs.length,
        cap: MAX_SYNCED_SKILLS,
      },
    );
    parsedDefs = parsedDefs.slice(0, MAX_SYNCED_SKILLS);
  }

  const wsObjectId = new Types.ObjectId(workspaceId);
  const rows = (await Skill.find({ workspaceId: wsObjectId })) as ISkill[];
  const rowByName = new Map(rows.map(r => [r.name, r]));
  const fileNames = new Set(parsedDefs.map(def => def.name));

  for (const def of parsedDefs) {
    const file = def.parsed;
    const entities = indexEntities(file);
    const row = rowByName.get(file.name);
    if (!row) {
      const { embedding, model } = await embeddingFor(file.loadWhen);
      await Skill.create({
        _id: derivedSkillId(workspaceId, file.name),
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
        sourceBlobSha: def.oid,
      });
      continue;
    }
    const unchanged =
      row.loadWhen === file.loadWhen &&
      row.body === file.body &&
      row.suppressed === file.suppressed &&
      sameEntities(row.entities ?? [], entities) &&
      sameEntities(row.declaredEntities ?? [], file.entities) &&
      row.sourceBlobSha === def.oid &&
      !row.definitionInvalid;
    if (unchanged) continue;
    if (row.body !== file.body) {
      row.previousBody = row.body;
      row.previousUpdatedAt = row.updatedAt;
    }
    if (row.loadWhen !== file.loadWhen) {
      const { embedding, model } = await embeddingFor(file.loadWhen);
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
    row.sourceBlobSha = def.oid;
    row.definitionInvalid = undefined;
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
  const repoDir = await requireWorkspaceRepo(workspaceId);
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
