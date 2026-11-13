/**
 * Skills: files in the workspace repo, served whole (apps.md §27).
 *
 * Every non-suppressed skill's name and description is in the agent's
 * prompt every turn; pinned skills ride with budgeted body excerpts; everything
 * else is one `load_skill` away. No retrieval, no embeddings, no index rows
 * — the catalog is `loadSkillCatalog`, an in-memory view of
 * `skills/<name>/SKILL.md` at main. `search_skills` is a keyword match over that
 * catalog for the case where the index line did not ring a bell.
 *
 * Usage counts (skill-usage.service) sit beside the catalog, never in it:
 * the tools record a read after serving it, and the listings show the totals.
 */
import {
  commitSkillDelete,
  commitSkillFlags,
  commitSkillSave,
  findSkill,
  findSkillById,
  findSkillTwins,
  resolveSkill,
  loadSkillCatalog,
  readWorkspaceSkillResource,
  skillId,
  INDEX_DESCRIPTION_CHARS,
  type InvalidSkillFile,
  type SkillCatalog,
  type WorkspaceSkill,
} from "../apps/workspace-skills.service";
import { type GitAuthor } from "../apps/repository.service";
import {
  MAX_SKILL_BODY_CHARS,
  MAX_WORKSPACE_SKILLS,
  SKILL_NAME_RE,
  SKILL_NAME_RULE,
  canonicalSkillName,
  type SkillResource,
} from "../apps/skill-files";
import { authorForUser } from "../apps/workspace-consoles.service";
import { STOPWORDS } from "../agent-lib/entity-extraction";
import { loggers } from "../logging";
import {
  getSystemSkill,
  getSystemSkillIndex,
  getSystemSkillResources,
  readSystemSkillResource,
} from "../agent-lib/skills/system-skills";
import {
  getSkillUsageOrNull,
  skillUsageKey,
  type SkillUsageSummary,
} from "./skill-usage.service";

const logger = loggers.app();

const MAX_NAME_LENGTH = 80;
/** The description is in every prompt: keep it a trigger line, not a summary. */
export const MAX_LOAD_WHEN_LENGTH = 300;
/** What the index shows per skill; longer descriptions are cut with an ellipsis. */
export { INDEX_DESCRIPTION_CHARS };
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
  if (!SKILL_NAME_RE.test(input.name)) {
    return `name must be ${SKILL_NAME_RULE}`;
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
  const name = input.name.trim();
  const existing = await findSkill(workspaceId, name);
  if (!existing) {
    const twin = (await findSkillTwins(workspaceId, name))[0];
    if (twin) {
      return {
        success: false,
        error: `Skill "${twin.name}" already exists. Save under that name to update it; "${name}" differs only in '-' vs '_'.`,
      };
    }
  }
  const pendingApproval = options.origin === "agent" && !existing;
  if (!existing) {
    const catalog = await loadSkillCatalog(workspaceId);
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
        body: input.body.trim(),
      },
      { author: await skillCommitAuthor(createdBy) },
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

export async function skillExists(
  workspaceId: string,
  name: string,
): Promise<boolean> {
  // A twin spelling (`foo-bar` for `foo_bar`) counts: a save would refuse it.
  return (await findSkillTwins(workspaceId, name)).length > 0;
}

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
        /** Files `read_skill_resource` serves for this skill: path and bytes. */
        resources: SkillResource[];
      };
    }
  | { success: false; error: string }
> {
  if (!name || name.trim().length === 0) {
    return { success: false, error: "name is required" };
  }
  const skill = await resolveSkill(workspaceId, name);
  if (skill) {
    return {
      success: true,
      skill: {
        id: skill.id,
        name: skill.name,
        loadWhen: skill.loadWhen,
        body: skill.body,
        suppressed: skill.suppressed,
        pinned: skill.pinned,
        resources: skill.resources,
      },
    };
  }
  const systemSkill = getSystemSkill(name.trim());
  if (!systemSkill) {
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
      resources: getSystemSkillResources(systemSkill.name),
    },
  };
}

/**
 * One resource file of a skill, resolved the way `load_skill` resolves the
 * skill: the workspace file at main first, else the system skill. Reading
 * only: nothing is executed.
 */
export async function readSkillResource(
  workspaceId: string,
  name: string,
  relPath: string,
): Promise<
  | {
      success: true;
      skill: string;
      scope: "workspace" | "system";
      path: string;
      content: string;
      /** Every resource path of the skill. */
      references: string[];
    }
  | { success: false; error: string }
> {
  if (!name || name.trim().length === 0) {
    return { success: false, error: "name is required" };
  }
  const skill = await resolveSkill(workspaceId, name);
  if (skill) {
    const read = await readWorkspaceSkillResource(workspaceId, skill, relPath);
    if (read.success) return { ...read, scope: "workspace" };
    // A workspace skill named like a system one shadows its body, not its
    // reference files: those stay readable, as they were before workspace
    // skills had resources.
    const shadowed = getSystemSkill(skill.name)
      ? readSystemSkillResource(skill.name, relPath)
      : null;
    return shadowed?.success ? { ...shadowed, scope: "system" } : read;
  }
  const read = readSystemSkillResource(name, relPath);
  if (read.success) return { ...read, scope: "system" };
  if (!getSystemSkill(name.trim())) {
    return { success: false, error: `skill "${name}" not found` };
  }
  return read;
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
        .filter(term => term.length >= 3 && !STOPWORDS.has(term)),
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
  /** Without, only the name, description and entities count. */
  { body: searchBody = true }: { body?: boolean } = {},
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
    else if (searchBody && body.includes(term)) score += 1;
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
  const workspace: SkillRetrievalHit[] = catalog.skills
    .filter(skill => !skill.suppressed)
    .map(skill => ({
      id: skill.id,
      name: skill.name,
      loadWhen: skill.loadWhen,
      body: skill.body,
      score: keywordScore(terms, skill),
      scope: "workspace" as const,
    }));
  // System skills too: they are in the same index, and an agent outside the
  // product (MCP) finds them only by asking. A workspace skill of the same
  // name is the one load_skill serves, so it shadows the system one. Their
  // bodies are long and mention most things: only what they say they are
  // for counts, so an unrelated question brings none of them.
  const taken = new Set(catalog.skills.map(skill => skill.name));
  const system: SkillRetrievalHit[] = getSystemSkillIndex()
    .filter(entry => !taken.has(entry.name))
    .flatMap(entry => {
      const skill = getSystemSkill(entry.name);
      if (!skill) return [];
      return [
        {
          id: skill.id,
          name: skill.name,
          loadWhen: skill.description,
          body: skill.body,
          score: keywordScore(
            terms,
            { ...skill, loadWhen: skill.description },
            { body: false },
          ),
          scope: "system" as const,
        },
      ];
    });
  const ranked = [...workspace, ...system].filter(hit => hit.score > 0);
  // On a tie the workspace's own skill comes first.
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      (a.scope === b.scope ? 0 : a.scope === "workspace" ? -1 : 1) ||
      a.name.localeCompare(b.name),
  );
  return ranked.slice(0, limit);
}

/** The words of a skill name: `mrr_walkthrough-fr` → mrr, walkthrough. */
function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 3 && !STOPWORDS.has(word));
}

/**
 * Hidden skill files a query asked for by name: the query holds the whole
 * name (`-` and `_` folded), or every word of it. A search that would have
 * found the skill says so, instead of returning the next best match as if
 * nothing were missing.
 */
export async function findInvalidSkillsMatching(
  workspaceId: string,
  query: string,
): Promise<InvalidSkillFile[]> {
  const invalid = (await loadSkillCatalog(workspaceId)).invalid;
  if (invalid.length === 0) return [];
  const folded = canonicalSkillName(query);
  const words = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(word => word.length > 0),
  );
  return invalid.filter(file => {
    const whole = canonicalSkillName(file.name);
    if (whole.length >= 3 && folded.includes(whole)) return true;
    const wanted = nameWords(file.name);
    return wanted.length > 0 && wanted.every(word => words.has(word));
  });
}

/** One line for a tool result: which hidden files matched, and why each is hidden. */
export function invalidSkillsNotice(files: InvalidSkillFile[]): string {
  const list = files.map(file => `${file.path} (${file.reason})`).join("; ");
  return files.length === 1
    ? `1 skill file matches this query by name but is hidden from the agent: ${list}. Tell the user and name the fix.`
    : `${files.length} skill files match this query by name but are hidden from the agent: ${list}. Tell the user and name the fix.`;
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
  definitionInvalid: { reason: string; path: string } | null;
  /** Problems that do not hide the skill: a cut description, a refused resource. */
  warnings: string[];
  /** Files `read_skill_resource` serves for this skill. */
  resources: SkillResource[];
  /** Loads, resource reads and keyword-match bodies in the last 30 days. */
  loads30d: number;
  /** Last read of any kind (ISO time), null when never read. */
  lastLoadedAt: string | null;
}

export interface AdminSkillDetail extends AdminSkillSummary {
  body: string;
}

function usageFields(
  usage: Map<string, SkillUsageSummary> | null,
  scope: "workspace" | "system",
  name: string,
): { loads30d: number; lastLoadedAt: string | null } {
  const entry = usage?.get(skillUsageKey(scope, name));
  return {
    loads30d: entry?.loads30d ?? 0,
    lastLoadedAt: entry?.lastLoadedAt?.toISOString() ?? null,
  };
}

/**
 * Usage per index entry for `list_skills`, or null when the numbers cannot
 * be read: the listing then leaves the two fields out, never shows a false 0.
 */
export async function skillUsageForIndex(
  workspaceId: string,
): Promise<
  | ((
      scope: "workspace" | "system",
      name: string,
    ) => { loads30d: number; lastLoadedAt: string | null })
  | null
> {
  const usage = await getSkillUsageOrNull(workspaceId);
  if (!usage) return null;
  return (scope, name) => usageFields(usage, scope, name);
}

/** A skill's warnings as lines: the SKILL.md ones bare, the others with their file. */
function warningTexts(catalog: SkillCatalog, name: string): string[] {
  return catalog.warnings
    .filter(warning => warning.name === name)
    .map(warning =>
      warning.path.endsWith("/SKILL.md")
        ? warning.reason
        : `${warning.path}: ${warning.reason}`,
    );
}

function summaryOf(
  skill: WorkspaceSkill,
  warnings: string[] = [],
  usage: Map<string, SkillUsageSummary> | null = null,
): AdminSkillSummary {
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
    definitionInvalid: null,
    warnings,
    resources: skill.resources,
    ...usageFields(usage, "workspace", skill.name),
  };
}

/** Valid skills first (by name), then files that do not parse, with why. */
export async function listSkillsForAdmin(
  workspaceId: string,
): Promise<AdminSkillSummary[]> {
  const catalog = await loadSkillCatalog(workspaceId);
  const usage = await getSkillUsageOrNull(workspaceId);
  return [
    ...catalog.skills.map(skill =>
      summaryOf(skill, warningTexts(catalog, skill.name), usage),
    ),
    ...catalog.invalid.map(file => ({
      id: skillId(workspaceId, file.name),
      name: file.name,
      path: file.path,
      loadWhen: "",
      bodyPreview: "",
      entities: [],
      suppressed: false,
      pinned: false,
      definitionInvalid: { reason: file.reason, path: file.path },
      warnings: [],
      resources: [],
      loads30d: 0,
      lastLoadedAt: null,
    })),
  ];
}

export async function getSkillForAdmin(
  workspaceId: string,
  id: string,
): Promise<AdminSkillDetail | null> {
  const skill = await findSkillById(workspaceId, id);
  if (!skill) return null;
  const catalog = await loadSkillCatalog(workspaceId);
  const usage = await getSkillUsageOrNull(workspaceId);
  return {
    ...summaryOf(skill, warningTexts(catalog, skill.name), usage),
    body: skill.body,
  };
}

export async function toggleSkillSuppressed(
  workspaceId: string,
  id: string,
  suppressed: boolean,
  actorId?: string,
): Promise<boolean> {
  const skill = await findSkillById(workspaceId, id);
  if (!skill) return false;
  return commitSkillFlags(
    workspaceId,
    skill.name,
    { suppressed },
    await skillCommitAuthor(actorId),
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
