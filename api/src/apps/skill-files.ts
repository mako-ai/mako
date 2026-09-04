/**
 * Workspace skills as repo content (apps.md §10 Block D1, §27).
 *
 * A workspace skill is `skills/<name>/SKILL.md` in the workspace repo — the
 * same package shape as the git-versioned system skills under
 * api/src/agent-skills/, so one format serves both kinds:
 *
 *   ---
 *   name: mrr_walkthrough_fr
 *   description: <when to load it — this line is in every prompt>
 *   entities: [mrr, france]        # optional author-declared triggers
 *   suppressed: true               # optional soft-disable, omitted when false
 *   pinned: true                   # optional: full body in every prompt
 *   ---
 *   <body — the playbook>
 *
 * The folder name is the identity (discovery = glob, like bindings/*.sql);
 * the frontmatter `name` is carried for human readers and system-skill
 * parity, but a mismatch resolves in the folder's favor.
 *
 * This module is pure format — serialize/parse only. Reading and writing the
 * repo lives in workspace-skills.service.ts.
 */
import yaml from "js-yaml";

export const SKILLS_DIR = "skills";
export const SKILL_FILE_GLOB = `${SKILLS_DIR}/*/SKILL.md`;
/** Written with the first skill save so the folder explains itself. */
export const SKILLS_README_PATH = `${SKILLS_DIR}/README.md`;

export const SKILLS_README = `# Workspace skills

Workspace-taught agent skills, one folder per skill (\`skills/<name>/SKILL.md\`).
These files ARE the skills: the agent's \`save_skill\` writes here, and anything
committed here (from a clone, a terminal) is in the agent's index on its next
turn. There is no other store.

Format (same as Mako's system skills): YAML frontmatter with \`name\`,
\`description\` (when to load it — every skill's name and description is in
the agent's prompt, so keep it short), optional \`entities\`, optional
\`suppressed: true\` (kept but never offered), optional \`pinned: true\` (the
full body is in every prompt, for the handful of skills every turn needs),
then the playbook body. The folder name is the identity.
`;

/** Same contract as skills.service validation: lowercase snake_case. */
export const SKILL_NAME_RE = /^[a-z0-9_]+$/;

export interface WorkspaceSkillFile {
  name: string;
  /** When to load it — `description` in frontmatter. */
  loadWhen: string;
  entities: string[];
  suppressed: boolean;
  /** Full body rides in every prompt (the skills equivalent of a non-deferred tool). */
  pinned: boolean;
  body: string;
}

export function skillFilePath(name: string): string {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: ${JSON.stringify(name)}`);
  }
  return `${SKILLS_DIR}/${name}/SKILL.md`;
}

/** `skills/<name>/SKILL.md` → `<name>`, or null for any other path. */
export function skillNameFromPath(path: string): string | null {
  const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
  if (!m || !SKILL_NAME_RE.test(m[1])) return null;
  return m[1];
}

export function serializeSkillFile(skill: WorkspaceSkillFile): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.loadWhen,
  };
  if (skill.entities.length > 0) frontmatter.entities = skill.entities;
  if (skill.suppressed) frontmatter.suppressed = true;
  if (skill.pinned) frontmatter.pinned = true;
  const head = yaml.dump(frontmatter, { lineWidth: 100 }).trimEnd();
  return `---\n${head}\n---\n\n${skill.body.trim()}\n`;
}

/**
 * Parse a SKILL.md. `name` comes from the caller (the folder), which is
 * authoritative; frontmatter `description` (alias: `loadWhen`) is required —
 * a file without one returns null rather than entering the index with an
 * empty trigger.
 */
export function parseSkillFile(
  name: string,
  content: string,
): WorkspaceSkillFile | null {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(
    normalized,
  );
  if (!match) return null;

  let data: Record<string, unknown>;
  try {
    const parsed = yaml.load(match[1]);
    if (!parsed || typeof parsed !== "object") return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const loadWhen =
    typeof data.description === "string"
      ? data.description.trim()
      : typeof data.loadWhen === "string"
        ? data.loadWhen.trim()
        : "";
  if (!loadWhen) return null;

  const entities = Array.isArray(data.entities)
    ? data.entities
        .filter((e): e is string => typeof e === "string")
        .map(e => e.toLowerCase().trim())
        .filter(e => e.length > 0)
    : [];

  const body = (match[2] ?? "").trim();
  if (!body) return null;

  return {
    name,
    loadWhen,
    entities,
    suppressed: data.suppressed === true,
    pinned: data.pinned === true,
    body,
  };
}
