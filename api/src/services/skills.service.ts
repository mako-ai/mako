/**
 * Skills service — per-workspace knowledge + procedure primitive (issue #365).
 *
 * Skills have a name, a short `loadWhen` trigger, and a body. Retrieval is a
 * weighted combination of entity overlap (authored + extracted tokens) and
 * semantic similarity over the `loadWhen` embedding. The full index (name +
 * loadWhen) is always injected into the agent's system prompt; bodies are
 * injected only for top-k matches above a threshold, or when the agent
 * explicitly calls `load_skill`.
 */

import { Types } from "mongoose";
import { Skill, type ISkill } from "../database/workspace-schema";
import {
  embedText,
  getEmbeddingModelName,
  isEmbeddingAvailable,
  isVectorSearchAvailable,
} from "./embedding.service";
import { databaseConnectionService } from "./database-connection.service";
import { extractEntities, entityOverlap } from "../agent-lib/entity-extraction";
import { loggers } from "../logging";

const logger = loggers.app();

const MAX_NAME_LENGTH = 80;
const MAX_LOAD_WHEN_LENGTH = 500;
const MAX_BODY_LENGTH = 20000;
/** Hard cap on skills per workspace. Keeps the injected index bounded. */
const MAX_SKILLS_PER_WORKSPACE = 200;
/** How many skill bodies to auto-inject per turn. */
const AUTO_INJECT_LIMIT = 3;
/**
 * Minimum weighted score for auto-injection. Below this we still show the
 * skill in the index, but we don't inject the body. The agent can still
 * `load_skill` explicitly if it decides it needs it.
 */
const AUTO_INJECT_THRESHOLD = 0.25;
/** Weights for the composite retrieval score. Sum should be ~1. */
const ENTITY_WEIGHT = 0.6;
const SEMANTIC_WEIGHT = 0.4;

export interface SkillInput {
  name: string;
  loadWhen: string;
  body: string;
  /** Optional author-declared entities, unioned with the extractor's output. */
  entities?: string[];
}

export interface SkillIndexEntry {
  id: string;
  name: string;
  loadWhen: string;
  suppressed: boolean;
  useCount: number;
}

export interface SkillRetrievalHit {
  id: string;
  name: string;
  loadWhen: string;
  body: string;
  score: number;
  entityOverlap: number;
  semanticScore: number;
  injected: boolean;
}

export interface SkillRetrievalResult {
  /** The compact index of every non-suppressed skill — always injected. */
  index: SkillIndexEntry[];
  /** Top-k hits with bodies for auto-injection (score >= threshold). */
  injected: SkillRetrievalHit[];
  /** Candidates that scored but didn't clear the threshold (for trace). */
  considered: SkillRetrievalHit[];
  /** Entities we pulled out of the query, surfaced for trace/debug. */
  queryEntities: string[];
}

function validateInput(input: SkillInput): string | null {
  if (!input.name || input.name.trim().length === 0) return "name is required";
  if (input.name.length > MAX_NAME_LENGTH) {
    return `name exceeds ${MAX_NAME_LENGTH} characters`;
  }
  if (!/^[a-z0-9_]+$/.test(input.name)) {
    return "name must be lowercase snake_case (a-z, 0-9, underscore)";
  }
  if (!input.loadWhen || input.loadWhen.trim().length === 0) {
    return "loadWhen is required";
  }
  if (input.loadWhen.length > MAX_LOAD_WHEN_LENGTH) {
    return `loadWhen exceeds ${MAX_LOAD_WHEN_LENGTH} characters`;
  }
  if (!input.body || input.body.trim().length === 0) {
    return "body is required";
  }
  if (input.body.length > MAX_BODY_LENGTH) {
    return `body exceeds ${MAX_BODY_LENGTH} characters`;
  }
  return null;
}

function unionEntities(
  declared: readonly string[] | undefined,
  extracted: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...(declared ?? []), ...extracted]) {
    const norm = raw.toLowerCase().trim();
    if (norm.length < 2) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

async function computeEmbedding(text: string): Promise<{
  embedding: number[] | null;
  model: string | null;
}> {
  if (!isEmbeddingAvailable()) return { embedding: null, model: null };
  try {
    const embedding = await embedText(text);
    if (!embedding) return { embedding: null, model: null };
    return { embedding, model: getEmbeddingModelName() };
  } catch (err) {
    logger.warn("Skill embedding failed, storing without vector", {
      error: err,
    });
    return { embedding: null, model: null };
  }
}

export async function saveSkill(
  workspaceId: string,
  input: SkillInput,
  createdBy: string,
): Promise<
  | { success: true; skill: { id: string; name: string; created: boolean } }
  | { success: false; error: string }
> {
  const validation = validateInput(input);
  if (validation) return { success: false, error: validation };

  const name = input.name.trim();
  const loadWhen = input.loadWhen.trim();
  const body = input.body.trim();

  const extracted = extractEntities(`${loadWhen}\n${body}`);
  const entities = unionEntities(input.entities, extracted);

  // Compute embedding over loadWhen ONLY. Body content is too long and noisy
  // for the embedding to represent usefully; entity overlap carries body-
  // level matching. See issue #365 design notes.
  const { embedding, model } = await computeEmbedding(loadWhen);

  const existing = await Skill.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    name,
  });

  if (!existing) {
    const totalSkills = await Skill.countDocuments({
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (totalSkills >= MAX_SKILLS_PER_WORKSPACE) {
      return {
        success: false,
        error: `Workspace has hit the ${MAX_SKILLS_PER_WORKSPACE} skill limit. Delete or merge skills before adding more.`,
      };
    }

    const created = await Skill.create({
      workspaceId: new Types.ObjectId(workspaceId),
      name,
      loadWhen,
      body,
      entities,
      loadWhenEmbedding: embedding ?? undefined,
      embeddingModel: model ?? undefined,
      scopeType: "workspace",
      createdBy,
      suppressed: false,
      useCount: 0,
    });
    return {
      success: true,
      skill: { id: created._id.toString(), name: created.name, created: true },
    };
  }

  // Overwrite path — preserve single-slot undo in `previousBody`.
  existing.previousBody = existing.body;
  existing.previousUpdatedAt = existing.updatedAt;
  existing.loadWhen = loadWhen;
  existing.body = body;
  existing.entities = entities;
  if (embedding) {
    existing.loadWhenEmbedding = embedding;
    existing.embeddingModel = model ?? undefined;
  }
  await existing.save();

  return {
    success: true,
    skill: { id: existing._id.toString(), name: existing.name, created: false },
  };
}

export async function deleteSkill(
  workspaceId: string,
  name: string,
): Promise<
  { success: true; deleted: boolean } | { success: false; error: string }
> {
  if (!name || name.trim().length === 0) {
    return { success: false, error: "name is required" };
  }
  const res = await Skill.deleteOne({
    workspaceId: new Types.ObjectId(workspaceId),
    name: name.trim(),
  });
  return { success: true, deleted: res.deletedCount > 0 };
}

export async function loadSkill(
  workspaceId: string,
  name: string,
): Promise<
  | {
      success: true;
      skill: {
        id: string;
        name: string;
        loadWhen: string;
        body: string;
        suppressed: boolean;
      };
    }
  | { success: false; error: string }
> {
  if (!name || name.trim().length === 0) {
    return { success: false, error: "name is required" };
  }
  const skill = await Skill.findOneAndUpdate(
    {
      workspaceId: new Types.ObjectId(workspaceId),
      name: name.trim(),
    },
    { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } },
    { new: true },
  );
  if (!skill) {
    return { success: false, error: `skill "${name}" not found` };
  }
  return {
    success: true,
    skill: {
      id: skill._id.toString(),
      name: skill.name,
      loadWhen: skill.loadWhen,
      body: skill.body,
      suppressed: skill.suppressed,
    },
  };
}

/**
 * Fallback semantic search via $vectorSearch. Only used when
 * isVectorSearchAvailable() is true AND the query produced an embedding.
 */
async function vectorSearchSkills(
  queryEmbedding: number[],
  workspaceId: string,
  limit: number,
): Promise<Array<{ id: string; score: number }>> {
  const { db } = await databaseConnectionService.getMainConnection();
  const results = await db
    .collection("skills")
    .aggregate([
      {
        $vectorSearch: {
          index: "skill_embeddings",
          path: "loadWhenEmbedding",
          queryVector: queryEmbedding,
          numCandidates: Math.max(limit * 10, 50),
          limit: Math.max(limit * 2, 10),
          filter: {
            workspaceId: new Types.ObjectId(workspaceId),
            suppressed: { $ne: true },
          },
        },
      },
      {
        $project: {
          _id: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ])
    .toArray();
  return results.map(r => ({
    id: (r._id as Types.ObjectId).toString(),
    score: (r.score as number) || 0,
  }));
}

/**
 * Full text search fallback when vector search is unavailable.
 * Uses Mongo's $text index over name + loadWhen + body.
 */
async function textSearchSkills(
  query: string,
  workspaceId: string,
  limit: number,
): Promise<Array<{ id: string; score: number }>> {
  try {
    const results = await Skill.find(
      {
        $text: { $search: query },
        workspaceId: new Types.ObjectId(workspaceId),
        suppressed: { $ne: true },
      },
      { score: { $meta: "textScore" } },
    )
      .select("_id")
      .sort({ score: { $meta: "textScore" } })
      .limit(limit * 2)
      .lean();
    const items = results as Array<{ _id: Types.ObjectId; score?: number }>;
    return items.map(r => ({ id: r._id.toString(), score: r.score ?? 0 }));
  } catch (err) {
    logger.debug("Skill text search failed", { error: err });
    return [];
  }
}

/**
 * Explicit skill search tool — entity overlap + either vector or text.
 * Returns ranked full skill bodies.
 */
export async function searchSkills(
  workspaceId: string,
  query: string,
  limit = 5,
): Promise<SkillRetrievalHit[]> {
  if (!query || query.trim().length === 0) return [];

  const queryEntities = extractEntities(query);
  const all = await Skill.find({
    workspaceId: new Types.ObjectId(workspaceId),
    suppressed: { $ne: true },
  })
    .select("+loadWhenEmbedding")
    .lean();

  if (all.length === 0) return [];

  // Semantic scoring: prefer vectorSearch when available, else textSearch.
  let semanticScoreById = new Map<string, number>();
  const canVector = isEmbeddingAvailable() && (await isVectorSearchAvailable());

  if (canVector) {
    const queryEmbedding = await embedText(query).catch(() => null);
    if (queryEmbedding) {
      const hits = await vectorSearchSkills(
        queryEmbedding,
        workspaceId,
        limit,
      ).catch(err => {
        logger.warn("Skill vector search failed, falling back to text", {
          error: err,
        });
        return [] as Array<{ id: string; score: number }>;
      });
      const maxScore = Math.max(...hits.map(h => h.score), 0.001);
      semanticScoreById = new Map(
        hits.map(h => [h.id, maxScore > 0 ? h.score / maxScore : 0]),
      );
    }
  }

  if (semanticScoreById.size === 0) {
    const hits = await textSearchSkills(query, workspaceId, limit);
    const maxScore = Math.max(...hits.map(h => h.score), 0.001);
    semanticScoreById = new Map(
      hits.map(h => [h.id, maxScore > 0 ? h.score / maxScore : 0]),
    );
  }

  const ranked: SkillRetrievalHit[] = all.map(s => {
    const id = (s._id as Types.ObjectId).toString();
    const overlap = entityOverlap(queryEntities, s.entities ?? []);
    const entityScore =
      queryEntities.length > 0
        ? Math.min(1, overlap / Math.max(3, queryEntities.length / 2))
        : 0;
    const semanticScore = semanticScoreById.get(id) ?? 0;
    const score = entityScore * ENTITY_WEIGHT + semanticScore * SEMANTIC_WEIGHT;
    return {
      id,
      name: s.name,
      loadWhen: s.loadWhen,
      body: s.body,
      score,
      entityOverlap: overlap,
      semanticScore,
      injected: false,
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

/**
 * Per-turn retrieval. Called from the agent route before building the
 * system prompt. Returns:
 *   - `index`: every non-suppressed skill (name + loadWhen only) — always shown
 *   - `injected`: up to AUTO_INJECT_LIMIT skill bodies above threshold
 *   - `considered`: candidates that scored but didn't clear threshold
 *   - `queryEntities`: extracted tokens (for trace)
 *
 * Also increments use counters for auto-injected skills.
 */
export async function retrieveRelevantSkills(
  workspaceId: string,
  queryText: string,
): Promise<SkillRetrievalResult> {
  const wsObjectId = new Types.ObjectId(workspaceId);

  // Always load the index of non-suppressed skills for injection.
  const indexDocs = await Skill.find({
    workspaceId: wsObjectId,
    suppressed: { $ne: true },
  })
    .select("name loadWhen suppressed useCount entities")
    .sort({ useCount: -1, updatedAt: -1 })
    .lean();

  const index: SkillIndexEntry[] = indexDocs.map(s => ({
    id: (s._id as Types.ObjectId).toString(),
    name: s.name,
    loadWhen: s.loadWhen,
    suppressed: !!s.suppressed,
    useCount: s.useCount ?? 0,
  }));

  if (indexDocs.length === 0 || !queryText || queryText.trim().length === 0) {
    return { index, injected: [], considered: [], queryEntities: [] };
  }

  const queryEntities = extractEntities(queryText);
  const hasEntities = queryEntities.length > 0;

  // Semantic score (per-doc) when available.
  let semanticScoreById = new Map<string, number>();
  const canVector = isEmbeddingAvailable() && (await isVectorSearchAvailable());
  if (canVector) {
    try {
      const qEmbedding = await embedText(queryText);
      if (qEmbedding) {
        const vecHits = await vectorSearchSkills(
          qEmbedding,
          workspaceId,
          AUTO_INJECT_LIMIT + 3,
        );
        const maxScore = Math.max(...vecHits.map(h => h.score), 0.001);
        semanticScoreById = new Map(
          vecHits.map(h => [h.id, maxScore > 0 ? h.score / maxScore : 0]),
        );
      }
    } catch (err) {
      logger.debug("Skill retrieval: vector path failed, ignoring", {
        error: err,
      });
    }
  }

  const candidates: SkillRetrievalHit[] = indexDocs.map(s => {
    const id = (s._id as Types.ObjectId).toString();
    const overlap = entityOverlap(queryEntities, s.entities ?? []);
    const entityScore = hasEntities
      ? Math.min(1, overlap / Math.max(3, queryEntities.length / 2))
      : 0;
    const semanticScore = semanticScoreById.get(id) ?? 0;
    const score = entityScore * ENTITY_WEIGHT + semanticScore * SEMANTIC_WEIGHT;
    return {
      id,
      name: s.name,
      loadWhen: s.loadWhen,
      body: "",
      score,
      entityOverlap: overlap,
      semanticScore,
      injected: false,
    };
  });

  candidates.sort((a, b) => b.score - a.score);

  const toInjectIds = candidates
    .filter(c => c.score >= AUTO_INJECT_THRESHOLD)
    .slice(0, AUTO_INJECT_LIMIT)
    .map(c => c.id);

  // Fetch bodies only for the ones we'll inject.
  const bodies: Array<{ _id: Types.ObjectId; body: string }> =
    toInjectIds.length
      ? ((await Skill.find({ _id: { $in: toInjectIds } })
          .select("body")
          .lean()) as unknown as Array<{ _id: Types.ObjectId; body: string }>)
      : [];
  const bodyById = new Map(
    bodies.map(b => [b._id.toString(), b.body as string]),
  );

  const injected: SkillRetrievalHit[] = [];
  const considered: SkillRetrievalHit[] = [];
  for (const c of candidates) {
    if (c.score <= 0 && !hasEntities) continue;
    if (toInjectIds.includes(c.id)) {
      injected.push({
        ...c,
        body: bodyById.get(c.id) ?? "",
        injected: true,
      });
    } else if (c.score > 0) {
      considered.push(c);
    }
  }

  // Fire-and-forget: bump useCount + lastUsedAt for skills we injected.
  if (injected.length > 0) {
    void Skill.updateMany(
      { _id: { $in: injected.map(i => new Types.ObjectId(i.id)) } },
      { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } },
    ).catch(err => {
      logger.debug("Skill useCount bump failed", { error: err });
    });
  }

  return {
    index,
    injected,
    considered: considered.slice(0, 5),
    queryEntities,
  };
}

/**
 * Render the skills block for injection into the agent's system prompt.
 * Keeps the format compact and includes a retrieval trace so behavior is
 * observable in chat traces.
 */
export function renderSkillsPromptBlock(result: SkillRetrievalResult): string {
  if (result.index.length === 0) return "";

  const lines: string[] = [];
  lines.push("\n\n---\n");
  lines.push("### Skills (workspace-scoped knowledge)");
  lines.push(
    "Skills extend or refine the self-directive for specific contexts. " +
      "If a skill conflicts with the directive, follow the directive. " +
      "Use `load_skill` to pull in any indexed skill on demand, `save_skill` " +
      "to record new workspace knowledge, `delete_skill` to retract, and " +
      "`search_skills` as a fallback.",
  );
  lines.push("");
  lines.push("#### Available skills (index)");
  for (const s of result.index) {
    lines.push(`- \`${s.name}\`: ${s.loadWhen}`);
  }

  if (result.injected.length > 0) {
    lines.push("");
    lines.push("#### Auto-loaded skills (relevant to current turn)");
    for (const s of result.injected) {
      lines.push("");
      lines.push(`##### \`${s.name}\``);
      lines.push(`_loadWhen:_ ${s.loadWhen}`);
      lines.push("");
      lines.push(s.body);
    }
  }

  // Retrieval trace — invisible to casual chat readers but in the trace.
  lines.push("");
  lines.push("<!-- skills retrieval trace");
  lines.push(
    `query_entities: [${result.queryEntities.slice(0, 20).join(", ")}]`,
  );
  for (const s of result.injected) {
    lines.push(
      `injected   ${s.name.padEnd(30)} score=${s.score.toFixed(2)} overlap=${s.entityOverlap} sem=${s.semanticScore.toFixed(2)}`,
    );
  }
  for (const s of result.considered) {
    lines.push(
      `considered ${s.name.padEnd(30)} score=${s.score.toFixed(2)} overlap=${s.entityOverlap} sem=${s.semanticScore.toFixed(2)}`,
    );
  }
  lines.push("-->");
  return lines.join("\n");
}

export interface AdminSkillSummary {
  id: string;
  name: string;
  loadWhen: string;
  bodyPreview: string;
  entities: string[];
  suppressed: boolean;
  useCount: number;
  lastUsedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function listSkillsForAdmin(
  workspaceId: string,
): Promise<AdminSkillSummary[]> {
  const docs = await Skill.find({
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .select(
      "name loadWhen body entities suppressed useCount lastUsedAt createdBy createdAt updatedAt",
    )
    .sort({ updatedAt: -1 })
    .lean();

  return docs.map(d => {
    const body = (d.body as string) ?? "";
    return {
      id: (d._id as Types.ObjectId).toString(),
      name: d.name,
      loadWhen: d.loadWhen,
      bodyPreview: body.slice(0, 240) + (body.length > 240 ? "…" : ""),
      entities: (d.entities as string[]) ?? [],
      suppressed: !!d.suppressed,
      useCount: d.useCount ?? 0,
      lastUsedAt: (d.lastUsedAt as Date | undefined) ?? null,
      createdBy: d.createdBy,
      createdAt: d.createdAt as Date,
      updatedAt: d.updatedAt as Date,
    };
  });
}

export async function getSkillForAdmin(
  workspaceId: string,
  id: string,
): Promise<ISkill | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  return Skill.findOne({
    _id: new Types.ObjectId(id),
    workspaceId: new Types.ObjectId(workspaceId),
  });
}

export async function toggleSkillSuppressed(
  workspaceId: string,
  id: string,
  suppressed: boolean,
): Promise<boolean> {
  if (!Types.ObjectId.isValid(id)) return false;
  const res = await Skill.updateOne(
    {
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    },
    { $set: { suppressed } },
  );
  return res.matchedCount > 0;
}

export async function deleteSkillById(
  workspaceId: string,
  id: string,
): Promise<boolean> {
  if (!Types.ObjectId.isValid(id)) return false;
  const res = await Skill.deleteOne({
    _id: new Types.ObjectId(id),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  return res.deletedCount > 0;
}
