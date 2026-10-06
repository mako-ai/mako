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
 *   pinned: true                   # optional: budgeted body excerpt in every prompt
 *   aliases: [old_name]            # optional: previous folder names (a rename records them)
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
/** Matches the agent/API save contract; larger authored files are invalid. */
export const MAX_SKILL_BODY_CHARS = 20_000;
/** Bounds one git blob before it is retained in the in-memory catalog. */
export const MAX_SKILL_FILE_BYTES = 64_000;
/** Bounds both API saves and catalogs authored directly in git. */
export const MAX_WORKSPACE_SKILLS = 200;
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
\`suppressed: true\` (kept but never offered), optional \`pinned: true\` (a
budgeted body excerpt is in every prompt, for skills every turn needs),
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
  /** A budgeted body excerpt rides in every prompt. */
  pinned: boolean;
  /**
   * Previous folder names, written by a rename so `load_skill("old")`
   * and old links keep resolving (api/src/rename). Travels with the file,
   * so a clone or a laptop `git mv` that keeps it behaves the same.
   */
  aliases?: string[];
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

/**
 * Edit a SKILL.md's front matter IN PLACE: set `name` and/or replace the
 * `aliases` list, keeping every other line (comments, `license`,
 * `allowed-tools`, `metadata`, keys this code does not know) byte for
 * byte. The list is written in flow style (`aliases: [a, b]`); an empty
 * list removes the key. Null when the file has no front matter block —
 * a rename must not rewrite what it cannot see the shape of.
 */
export function editSkillFrontMatter(
  contents: string,
  edit: { name?: string; aliases?: string[] },
): string | null {
  const normalized = contents.replace(/^\uFEFF/, "");
  const nl = normalized.includes("\r\n") ? "\r\n" : "\n";
  const lines = normalized.split(nl);
  if (!/^---\s*$/.test(lines[0] ?? "")) return null;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      close = i;
      break;
    }
  }
  if (close < 0) return null;
  const fm = lines.slice(1, close);

  if (edit.name !== undefined) {
    const at = fm.findIndex(l => /^name:/.test(l));
    const line = `name: ${edit.name}`;
    if (at >= 0) fm[at] = line;
    else fm.unshift(line);
  }
  if (edit.aliases !== undefined) {
    const at = fm.findIndex(l => /^aliases:/.test(l));
    if (at >= 0) {
      let end = at + 1;
      if (!/^aliases:\s*\[/.test(fm[at])) {
        while (end < fm.length && /^\s+-\s/.test(fm[end])) end++;
      }
      fm.splice(at, end - at);
    }
    if (edit.aliases.length > 0) {
      fm.push(`aliases: [${edit.aliases.join(", ")}]`);
    }
  }
  return ["---", ...fm, ...lines.slice(close)].join(nl);
}

export function serializeSkillFile(skill: WorkspaceSkillFile): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.loadWhen,
  };
  if (skill.entities.length > 0) frontmatter.entities = skill.entities;
  if (skill.suppressed) frontmatter.suppressed = true;
  if (skill.pinned) frontmatter.pinned = true;
  if (skill.aliases && skill.aliases.length > 0) {
    frontmatter.aliases = skill.aliases;
  }
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

  // Aliases are names too: anything that is not a valid skill name could
  // never have been a folder, so it is dropped rather than carried along.
  const aliases = Array.isArray(data.aliases)
    ? [
        ...new Set(
          data.aliases
            .filter((a): a is string => typeof a === "string")
            .map(a => a.trim())
            .filter(a => SKILL_NAME_RE.test(a) && a !== name),
        ),
      ]
    : [];

  return {
    name,
    loadWhen,
    entities,
    suppressed: data.suppressed === true,
    pinned: data.pinned === true,
    ...(aliases.length > 0 ? { aliases } : {}),
    body,
  };
}
