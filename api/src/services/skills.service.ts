/**
 * Skills: files in the workspace repo, served whole (apps.md §27).
 *
 * Every non-suppressed skill's name and description is in the agent's
 * prompt every turn; pinned skills ride with budgeted body excerpts; everything
 * else is one `load_skill` away. No retrieval, no embeddings, no index rows,
 * no counters — the catalog is `loadSkillCatalog`, an in-memory view of
 * `skills/<name>/SKILL.md` at main. `search_skills` is a keyword match over that
 * catalog for the case where the index line did not ring a bell.
 */
import {
  aliasClaimantsOf,
  commitSkillDelete,
  commitSkillFlags,
  commitSkillRename,
  commitSkillSave,
  findSkill,
  findSkillById,
  loadSkillCatalog,
  resolveSkillRef,
  resolveSkillRefThroughHistory,
  skillId,
  type SkillRenameOutcome,
  type WorkspaceSkill,
} from "../apps/workspace-skills.service";
import { type GitAuthor } from "../apps/repository.service";
import {
  MAX_SKILL_BODY_CHARS,
  MAX_WORKSPACE_SKILLS,
} from "../apps/skill-files";
import { authorForUser } from "../apps/workspace-consoles.service";
import { loggers } from "../logging";
import {
  getSystemSkill,
  getSystemSkillIndex,
  readSystemSkillResource,
} from "../agent-lib/skills/system-skills";

const logger = loggers.app();

const MAX_NAME_LENGTH = 80;
/** The description is in every prompt: keep it a trigger line, not a summary. */
export const MAX_LOAD_WHEN_LENGTH = 300;
/** Past this the index alone stops working (selection degrades around 30–50 items). */
/** What the index shows per skill; longer descriptions are cut with an ellipsis. */
export const INDEX_DESCRIPTION_CHARS = 200;
/** Per-skill and total bounds for bodies injected into every agent turn. */
export const MAX_SKILL_EXCERPT_CHARS = 2_500;
export const MAX_PINNED_SKILL_BODY_CHARS = 7_500;

export interface SkillInput {
  name: string;
  loadWhen: string;
  body: string;
  entities?: string[];
  pinned?: boolean;
}

export interface SkillIndexEntry {
  id: string;
  name: string;
  loadWhen: string;
  scope: "workspace" | "system";
  pinned: boolean;
  references?: string[];
}

export interface SkillRetrievalHit {
  id: string;
  name: string;
  loadWhen: string;
  body: string;
  score: number;
  scope: "workspace" | "system";
}

export interface SkillRetrievalResult {
  /** Every offered skill (workspace, then system), name + description. */
  index: SkillIndexEntry[];
  /** Pinned workspace skills, full body. */
  injected: SkillRetrievalHit[];
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
    return `loadWhen exceeds ${MAX_LOAD_WHEN_LENGTH} characters — it is shown in every prompt, keep it to one trigger line`;
  }
  if (!input.body || input.body.trim().length === 0) {
    return "body is required";
  }
  if (input.body.length > MAX_SKILL_BODY_CHARS) {
    return `body exceeds ${MAX_SKILL_BODY_CHARS} characters`;
  }
  return null;
}

function normalizeEntities(declared: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of declared ?? []) {
    const norm = raw.toLowerCase().trim();
    if (norm.length < 2 || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

async function skillCommitAuthor(
  actorId: string | undefined,
): Promise<GitAuthor | undefined> {
  if (!actorId || actorId === "agent") return undefined;
  return authorForUser(actorId);
}

/**
 * Save (create or overwrite) a skill as a commit on main.
 *
 * "agent": a NEW skill starts SUPPRESSED — a proposal a human activates in
 * the Skills panel or by flipping `suppressed: false` in the file (apps.md
 * §22); proposals cost nothing until someone approves them. Updates keep
 * the existing flags unless the caller sets them.
 */
export async function saveSkill(
  workspaceId: string,
  input: SkillInput,
  createdBy: string,
  options: { origin?: "agent" | "user" } = {},
): Promise<
  | {
      success: true;
      skill: {
        id: string;
        name: string;
        created: boolean;
        pendingApproval?: boolean;
      };
    }
  | { success: false; error: string }
> {
  const validation = validateInput(input);
  if (validation) return { success: false, error: validation };
  // Only a CURRENT name is "the same skill". Saving under a retired name
  // creates a new skill with that name — the live name always beats the
  // alias — and, in the same commit, retires the alias from the skill
  // that used to be called that, so `load_skill("name")` has exactly one
  // answer from now on. (Updating a renamed skill means naming it by its
  // current name; `renameSkill` is the way to move it.)
  const name = input.name.trim();
  // A write under `name` acts on the skill whose CURRENT name it is —
  // suppressed or not — and keeps its flags: editing a pending proposal
  // keeps it pending; only an explicit approval (toggleSkillSuppressed)
  // retires another skill's alias. With no such skill, the save creates
  // one, and a NEW unsuppressed skill under a retired name retires that
  // alias in the same commit (the live name beats the alias).
  const catalog = await loadSkillCatalog(workspaceId);
  const existing = catalog.skills.find(skill => skill.name === name) ?? null;
  const pendingApproval = options.origin === "agent" && !existing;
  const aliasOwner = existing
    ? null
    : ((await resolveSkillRef(workspaceId, name))?.skill ?? null);
  const retireAliasFrom =
    aliasOwner && aliasOwner.name !== name && !pendingApproval
      ? aliasOwner.name
      : undefined;
  if (!existing) {
    if (catalog.skills.length >= MAX_WORKSPACE_SKILLS) {
      return {
        success: false,
        error: `Workspace has hit the ${MAX_WORKSPACE_SKILLS} skill limit. Delete or merge skills before adding more.`,
      };
    }
  }
  try {
    await commitSkillSave(
      workspaceId,
      {
        name,
        loadWhen: input.loadWhen.trim(),
        entities: normalizeEntities(input.entities ?? existing?.entities),
        suppressed: pendingApproval || !!existing?.suppressed,
        pinned: input.pinned ?? existing?.pinned ?? false,
        // Previous names are the file's record of its renames: a save must
        // not forget them, or the old links die on the next edit.
        aliases: existing?.aliases,
        body: input.body.trim(),
      },
      { author: await skillCommitAuthor(createdBy), retireAliasFrom },
    );
  } catch (error) {
    logger.error("Skill save: git commit failed", { workspaceId, error });
    return {
      success: false,
      error: `Could not commit the skill to the workspace repository: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    success: true,
    skill: {
      id: skillId(workspaceId, name),
      name,
      created: !existing,
      ...(pendingApproval ? { pendingApproval: true } : {}),
    },
  };
}

/**
 * Update a skill by its id — the admin route's path. The id names ONE
 * file, so a pending proposal that shares a retired name with a live
 * skill is edited in place and stays pending; nothing is created, no
 * alias is retired.
 */
export async function updateSkillById(
  workspaceId: string,
  id: string,
  patch: {
    loadWhen?: string;
    body?: string;
    entities?: string[];
    pinned?: boolean;
  },
  actorId?: string,
): Promise<
  | { success: true; skill: { id: string; name: string } }
  | { success: false; status: 400 | 404; error: string }
> {
  const existing = await findSkillById(workspaceId, id);
  if (!existing || existing.id !== id) {
    return { success: false, status: 404, error: "Skill not found" };
  }
  const input: SkillInput = {
    name: existing.name,
    loadWhen: patch.loadWhen ?? existing.loadWhen,
    body: patch.body ?? existing.body,
    entities: patch.entities ?? existing.entities,
    pinned: patch.pinned ?? existing.pinned,
  };
  const validation = validateInput(input);
  if (validation) return { success: false, status: 400, error: validation };
  try {
    await commitSkillSave(
      workspaceId,
      {
        name: existing.name,
        loadWhen: input.loadWhen.trim(),
        entities: normalizeEntities(input.entities),
        suppressed: existing.suppressed,
        pinned: input.pinned ?? false,
        aliases: existing.aliases,
        body: input.body.trim(),
      },
      { author: await skillCommitAuthor(actorId) },
    );
  } catch (error) {
    logger.error("Skill update: git commit failed", { workspaceId, error });
    return {
      success: false,
      status: 400,
      error: `Could not commit the skill to the workspace repository: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { success: true, skill: { id: existing.id, name: existing.name } };
}

export async function skillExists(
  workspaceId: string,
  name: string,
): Promise<boolean> {
  return (await findSkill(workspaceId, name)) !== null;
}

/**
 * Rename a skill (api/src/rename): `git mv skills/<from> skills/<to>` plus
 * `aliases: [from]` in the front matter, one commit on main. The one
 * rename path for the Skills panel, REST and `rename_object`. `from` may
 * be the skill's id, current name or an alias; the move is always from
 * the CURRENT name.
 */
export async function renameSkill(
  workspaceId: string,
  ref: string,
  to: string,
  actorId?: string,
): Promise<
  | {
      success: true;
      skill: { id: string; name: string; aliases: string[] };
      before: { id: string; name: string };
      aliasesAdded: string[];
      commit: string;
    }
  | { success: false; status: 400 | 404 | 409; error: string }
> {
  const trimmed = ref.trim();
  // Every ref `resolve` accepts names the skill here too — an id, the
  // current name, an alias, or a name only git history knows (a bare
  // laptop `git mv`) — so an old link that opens the skill can rename it.
  const existing =
    (await findSkillById(workspaceId, trimmed)) ??
    (await findSkill(workspaceId, trimmed)) ??
    (await resolveSkillRefThroughHistory(workspaceId, trimmed))?.skill;
  if (!existing) {
    return { success: false, status: 404, error: `skill "${ref}" not found` };
  }
  if (to.trim().length > MAX_NAME_LENGTH) {
    return {
      success: false,
      status: 400,
      error: `name exceeds ${MAX_NAME_LENGTH} characters`,
    };
  }
  let outcome: SkillRenameOutcome;
  try {
    outcome = await commitSkillRename(
      workspaceId,
      existing.name,
      to.trim(),
      await skillCommitAuthor(actorId),
    );
  } catch (error) {
    logger.error("Skill rename: git commit failed", { workspaceId, error });
    return {
      success: false,
      status: 400,
      error: `Could not commit the rename to the workspace repository: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!outcome.ok) return { success: false, ...outcome };
  const renamed = await findSkill(workspaceId, to.trim());
  return {
    success: true,
    skill: {
      id: skillId(workspaceId, to.trim()),
      name: to.trim(),
      aliases: renamed?.aliases ?? [],
    },
    before: { id: existing.id, name: existing.name },
    aliasesAdded: outcome.aliasesAdded,
    commit: outcome.commitOid,
  };
}

export { resolveSkillRef };

export async function deleteSkill(
  workspaceId: string,
  name: string,
  actorId?: string,
): Promise<
  { success: true; deleted: boolean } | { success: false; error: string }
> {
  if (!name || name.trim().length === 0) {
    return { success: false, error: "name is required" };
  }
  try {
    const deleted = await commitSkillDelete(
      workspaceId,
      name.trim(),
      await skillCommitAuthor(actorId),
    );
    return { success: true, deleted };
  } catch (error) {
    logger.error("Skill delete: git commit failed", { workspaceId, error });
    return {
      success: false,
      error: `Could not commit the deletion to the workspace repository: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** A skill by name: the workspace file at main, else a system skill. */
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
        pinned: boolean;
      };
    }
  | { success: false; error: string }
> {
  if (!name || name.trim().length === 0) {
    return { success: false, error: "name is required" };
  }
  const asWorkspaceSkill = (skill: WorkspaceSkill) => ({
    success: true as const,
    skill: {
      id: skill.id,
      name: skill.name,
      loadWhen: skill.loadWhen,
      body: skill.body,
      suppressed: skill.suppressed,
      pinned: skill.pinned,
    },
  });
  // Order: workspace CURRENT name → system skill → workspace alias → git
  // history. A workspace skill may shadow a system skill by taking its
  // name; once renamed away from it, the system skill is visible again —
  // an alias is a courtesy for old references, never a claim on a live name.
  const resolved = await resolveSkillRef(workspaceId, name);
  if (resolved?.via === "current") return asWorkspaceSkill(resolved.skill);
  const systemSkill = getSystemSkill(name.trim());
  if (!systemSkill) {
    if (resolved) return asWorkspaceSkill(resolved.skill);
    // Nothing claims the name: a folder moved by a bare `git mv` carries no
    // alias, but git remembers the move.
    const moved = await resolveSkillRefThroughHistory(workspaceId, name);
    if (moved) return asWorkspaceSkill(moved.skill);
    return { success: false, error: `skill "${name}" not found` };
  }
  return {
    success: true,
    skill: {
      id: systemSkill.id,
      name: systemSkill.name,
      loadWhen: systemSkill.description,
      body: systemSkill.body,
      suppressed: false,
      pinned: false,
    },
  };
}

export function readSkillResource(
  name: string,
  relPath: string,
):
  | {
      success: true;
      skill: string;
      path: string;
      content: string;
      references: string[];
    }
  | { success: false; error: string } {
  return readSystemSkillResource(name, relPath);
}

// ---------------------------------------------------------------------------
// Search — keyword match over the catalog
// ---------------------------------------------------------------------------

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(term => term.length >= 3),
    ),
  ];
}

/**
 * How many of the query's terms a skill mentions, weighted by where: the
 * name and description are the author's own trigger, the body is context.
 * Deliberately plain — the index in the prompt does the real routing.
 */
function keywordScore(
  terms: string[],
  skill: { name: string; loadWhen: string; entities: string[]; body: string },
): number {
  if (terms.length === 0) return 0;
  const name = skill.name.toLowerCase();
  const loadWhen = skill.loadWhen.toLowerCase();
  const entities = skill.entities.join(" ").toLowerCase();
  const body = skill.body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 3;
    else if (loadWhen.includes(term) || entities.includes(term)) score += 2;
    else if (body.includes(term)) score += 1;
  }
  return score / (terms.length * 3);
}

export async function searchSkills(
  workspaceId: string,
  query: string,
  limit = 5,
): Promise<SkillRetrievalHit[]> {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const catalog = await loadSkillCatalog(workspaceId);
  const ranked: SkillRetrievalHit[] = catalog.skills
    .filter(skill => !skill.suppressed)
    .map(skill => ({
      id: skill.id,
      name: skill.name,
      loadWhen: skill.loadWhen,
      body: skill.body,
      score: keywordScore(terms, skill),
      scope: "workspace" as const,
    }))
    .filter(hit => hit.score > 0);
  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return ranked.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Prompt block — the whole index, pinned bodies
// ---------------------------------------------------------------------------

function indexLine(loadWhen: string): string {
  return loadWhen.length > INDEX_DESCRIPTION_CHARS
    ? `${loadWhen.slice(0, INDEX_DESCRIPTION_CHARS - 1).trimEnd()}…`
    : loadWhen;
}

/**
 * What every turn gets: the full index (workspace skills first, then system
 * skills) and the pinned skills' bodies. Independent of the user's text —
 * the model reads the index and loads what it needs.
 */
export async function retrieveRelevantSkills(
  workspaceId: string,
): Promise<SkillRetrievalResult> {
  const catalog = await loadSkillCatalog(workspaceId);
  const offered = catalog.skills.filter(skill => !skill.suppressed);
  const index: SkillIndexEntry[] = [
    ...offered.map(skill => ({
      id: skill.id,
      name: skill.name,
      loadWhen: indexLine(skill.loadWhen),
      scope: "workspace" as const,
      pinned: skill.pinned,
    })),
    ...getSystemSkillIndex().map(skill => ({
      id: skill.id,
      name: skill.name,
      loadWhen: skill.description,
      scope: "system" as const,
      pinned: false,
      references: skill.references,
    })),
  ];
  const injected: SkillRetrievalHit[] = offered
    .filter(skill => skill.pinned)
    .map(skill => ({
      id: skill.id,
      name: skill.name,
      loadWhen: skill.loadWhen,
      body: skill.body,
      score: 1,
      scope: "workspace" as const,
    }));
  return { index, injected };
}

export function renderSkillsPromptBlock(result: SkillRetrievalResult): string {
  if (result.index.length === 0) return "";
  const lines: string[] = [];
  lines.push("\n\n---\n");
  lines.push("### Skills (workspace + system knowledge)");
  lines.push(
    "Skills extend or refine the self-directive for specific contexts. " +
      "If a skill conflicts with the directive, follow the directive. " +
      "This is the complete index: read it, and `load_skill` any skill " +
      "whose description matches what you are about to do — before you " +
      "start, not after. Pinned skill bodies are loaded below within a " +
      "fixed prompt budget. " +
      "`search_skills` finds a skill by keyword when the index line did " +
      "not ring a bell; `save_skill` proposes a new one.",
  );
  lines.push("");
  lines.push("#### Available skills (index)");
  for (const s of result.index) {
    const references =
      s.scope === "system" && s.references && s.references.length > 0
        ? ` (references: ${s.references.join(", ")})`
        : "";
    const pinned = s.pinned ? " (pinned)" : "";
    lines.push(
      `- [${s.scope}] \`${s.name}\`${pinned}: ${s.loadWhen}${references}`,
    );
  }
  if (result.injected.length > 0) {
    lines.push("");
    lines.push("#### Pinned skill excerpts (budgeted)");
    let remainingBodyChars = MAX_PINNED_SKILL_BODY_CHARS;
    let omitted = 0;
    for (const s of result.injected) {
      const trimmedBody = s.body.trim();
      if (!trimmedBody) continue;
      if (remainingBodyChars <= 0) {
        omitted++;
        continue;
      }
      const excerptLength = Math.min(
        trimmedBody.length,
        MAX_SKILL_EXCERPT_CHARS,
        remainingBodyChars,
      );
      const body = trimmedBody.slice(0, excerptLength);
      const truncated = body.length < trimmedBody.length;
      lines.push("");
      lines.push(`##### \`${s.name}\``);
      lines.push(`_loadWhen:_ ${s.loadWhen}`);
      lines.push("");
      lines.push(body);
      remainingBodyChars -= body.length;
      if (truncated) {
        lines.push("");
        lines.push(
          `[Excerpt truncated. Use load_skill("${s.name}") for the complete guide.]`,
        );
      }
    }
    if (omitted > 0) {
      lines.push("");
      lines.push(
        `[${omitted} additional pinned skill${omitted === 1 ? " was" : "s were"} omitted by the prompt budget; use load_skill by name from the index.]`,
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Admin (settings UI)
// ---------------------------------------------------------------------------

export interface AdminSkillSummary {
  id: string;
  name: string;
  path: string;
  loadWhen: string;
  bodyPreview: string;
  entities: string[];
  suppressed: boolean;
  pinned: boolean;
  /** Previous names (a rename records them); they still resolve. */
  aliases: string[];
  definitionInvalid: { reason: string; path: string } | null;
}

export interface AdminSkillDetail extends AdminSkillSummary {
  body: string;
}

function summaryOf(skill: WorkspaceSkill): AdminSkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    path: skill.path,
    loadWhen: skill.loadWhen,
    bodyPreview:
      skill.body.slice(0, 240) + (skill.body.length > 240 ? "…" : ""),
    entities: skill.entities,
    suppressed: skill.suppressed,
    pinned: skill.pinned,
    aliases: skill.aliases ?? [],
    definitionInvalid: null,
  };
}

/** Valid skills first (by name), then files that do not parse, with why. */
export async function listSkillsForAdmin(
  workspaceId: string,
): Promise<AdminSkillSummary[]> {
  const catalog = await loadSkillCatalog(workspaceId);
  return [
    ...catalog.skills.map(summaryOf),
    ...catalog.invalid.map(file => ({
      id: skillId(workspaceId, file.name),
      name: file.name,
      path: file.path,
      loadWhen: "",
      bodyPreview: "",
      entities: [],
      suppressed: false,
      pinned: false,
      aliases: [],
      definitionInvalid: { reason: file.reason, path: file.path },
    })),
  ];
}

export async function getSkillForAdmin(
  workspaceId: string,
  id: string,
): Promise<AdminSkillDetail | null> {
  const skill = await findSkillById(workspaceId, id);
  if (!skill) return null;
  return { ...summaryOf(skill), body: skill.body };
}

export async function toggleSkillSuppressed(
  workspaceId: string,
  id: string,
  suppressed: boolean,
  actorId?: string,
): Promise<boolean> {
  const skill = await findSkillById(workspaceId, id);
  if (!skill) return false;
  // Activating a proposal saved under a name another skill still lists
  // as an alias: now it takes the name, and that alias is retired in the
  // same commit (a name has one answer).
  const claimant = suppressed
    ? undefined
    : (await aliasClaimantsOf(workspaceId, skill.name)).find(
        other => other.name !== skill.name,
      );
  return commitSkillFlags(
    workspaceId,
    skill.name,
    { suppressed },
    await skillCommitAuthor(actorId),
    { retireAliasFrom: claimant?.name },
  );
}

export async function setSkillPinned(
  workspaceId: string,
  id: string,
  pinned: boolean,
  actorId?: string,
): Promise<boolean> {
  const skill = await findSkillById(workspaceId, id);
  if (!skill) return false;
  return commitSkillFlags(
    workspaceId,
    skill.name,
    { pinned },
    await skillCommitAuthor(actorId),
  );
}

export async function deleteSkillById(
  workspaceId: string,
  id: string,
  actorId?: string,
): Promise<boolean> {
  const skill = await findSkillById(workspaceId, id);
  if (!skill) return false;
  return commitSkillDelete(
    workspaceId,
    skill.name,
    await skillCommitAuthor(actorId),
  );
}
