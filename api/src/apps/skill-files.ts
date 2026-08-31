/**
 * Workspace skills as repo content (apps.md §10 Block D1).
 *
 * A workspace skill is `skills/<name>/SKILL.md` in the workspace repo — the
 * same package shape as the git-versioned system skills under
 * api/src/agent-skills/, so one format serves both kinds:
 *
 *   ---
 *   name: mrr_walkthrough_fr
 *   description: <the retrieval trigger — Mongo's `loadWhen`>
 *   entities: [mrr, france]        # optional author-declared triggers
 *   suppressed: true               # optional soft-disable, omitted when false
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
/**
 * Marker that a workspace's skills have been adopted into git. While absent,
 * Mongo rows may exist that git has never seen, so the push-driven index sync
 * must not treat "not in git" as "deleted".
 */
export const SKILLS_README_PATH = `${SKILLS_DIR}/README.md`;

export const SKILLS_README = `# Workspace skills

Workspace-taught agent skills, one folder per skill (\`skills/<name>/SKILL.md\`).
Managed by Mako: the agent's \`save_skill\` writes here, and anything committed
here (from a clone, a terminal) is in the agent's retrieval index by its next
turn.

Format (same as Mako's system skills): YAML frontmatter with \`name\`,
\`description\` (the retrieval trigger), optional \`entities\` and
\`suppressed\`, then the playbook body. The folder name is the identity.
`;

/** Same contract as skills.service validation: lowercase snake_case. */
export const SKILL_NAME_RE = /^[a-z0-9_]+$/;

export interface WorkspaceSkillFile {
  name: string;
  /** The retrieval trigger — `description` in frontmatter, `loadWhen` in Mongo. */
  loadWhen: string;
  entities: string[];
  suppressed: boolean;
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
    body,
  };
}
