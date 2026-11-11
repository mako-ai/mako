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
 *   aliases: [old_name]            # optional: previous names (a rename records them)
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
import * as yaml from "js-yaml";
import { SKILL_NAME_RE, SKILL_NAME_RULE } from "@mako/schemas";
import { setTopLevelScalar, yamlScalar } from "../rename/yaml-name-aliases";
import { loadYaml } from "../utils/yaml";

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

// The skill-name rule lives in `@mako/schemas` (skill-names.ts), where the
// Skills panel reads it too.
export { SKILL_NAME_RE, SKILL_NAME_RULE };

/**
 * `app-ui-conventions` and `app_ui_conventions` are one name to a person.
 * Lookups by a spelling that matches no folder exactly fall back to this form,
 * and a save refuses a new folder that collides with an existing one in it.
 */
export function canonicalSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_");
}

export interface WorkspaceSkillFile {
  name: string;
  /** When to load it — `description` in frontmatter. */
  loadWhen: string;
  entities: string[];
  suppressed: boolean;
  /** A budgeted body excerpt rides in every prompt. */
  pinned: boolean;
  /**
   * Previous names, written by a rename so `load_skill("old")` keeps
   * resolving (api/src/rename). They travel with the file, so a clone or a
   * laptop `git mv` that keeps the front matter behaves the same.
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

export function serializeSkillFile(skill: WorkspaceSkillFile): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.loadWhen,
  };
  if (skill.entities.length > 0) frontmatter.entities = skill.entities;
  if (skill.suppressed) frontmatter.suppressed = true;
  if (skill.pinned) frontmatter.pinned = true;
  if (skill.aliases?.length) frontmatter.aliases = skill.aliases;
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
    const parsed = loadYaml(match[1]);
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

  // An alias is a name too: one that could never have been a folder, or
  // that is this skill's own name, is dropped rather than carried along.
  const aliases = Array.isArray(data.aliases)
    ? [
        ...new Set(
          data.aliases
            .filter((alias): alias is string => typeof alias === "string")
            .map(alias => alias.trim())
            .filter(alias => SKILL_NAME_RE.test(alias) && alias !== name),
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

const FRONT_MATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

/** The front matter of a SKILL.md as a mapping, or null. */
function frontMatterOf(contents: string): Record<string, unknown> | null {
  const match = FRONT_MATTER.exec(contents.replace(/^\uFEFF/, ""));
  if (!match) return null;
  try {
    const data = loadYaml(match[1]);
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Set `name` and/or the `aliases` list in a SKILL.md's front matter IN
 * PLACE: every other line (comments, `license`, `allowed-tools`, keys this
 * code does not know) and the body stay byte for byte. Names are written
 * with `yamlScalar`, so `2026`, `true` or `no` stay strings; the list is
 * written in flow style, and an empty list removes the key.
 *
 * A line edit is never trusted: the result is parsed again, as front
 * matter and as a skill under `folderName`, and must say exactly what was
 * intended with every other key as it was. Anything else (no front matter,
 * a multi-line flow list, an anchor) answers with the fix to make by hand,
 * and the caller commits nothing.
 */
export function editSkillFrontMatter(
  folderName: string,
  contents: string,
  edit: { name?: string; aliases?: string[] },
): { ok: true; contents: string } | { ok: false; reason: string } {
  const refused = {
    ok: false as const,
    reason: `skills/${folderName}/SKILL.md could not be edited in place without breaking it. Edit its front matter by hand: set ${[
      ...(edit.name === undefined ? [] : [`\`name: ${edit.name}\``]),
      ...(edit.aliases === undefined
        ? []
        : [`\`aliases: [${edit.aliases.join(", ")}]\``]),
    ].join(" and ")}.`,
  };
  const original = contents.replace(/^\uFEFF/, "");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(eol);
  const close = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line));
  if (!/^---\s*$/.test(lines[0] ?? "") || close < 0) return refused;
  const head = lines.slice(1, close);

  if (edit.name !== undefined) {
    if (head.some(line => /^name\s*:/.test(line))) {
      // The line's own comment (`name: x  # shown in the index`) stays.
      const named = setTopLevelScalar(head.join("\n"), "name", edit.name);
      if (named === null) return refused;
      head.splice(0, head.length, ...named.replace(/\n$/, "").split("\n"));
    } else {
      const scalar = yamlScalar(edit.name);
      if (scalar === null) return refused;
      head.unshift(`name: ${scalar}`);
    }
  }
  if (edit.aliases !== undefined) {
    const at = head.findIndex(line => /^aliases\s*:/.test(line));
    if (at >= 0) {
      let end = at + 1;
      // A block list's items, at ANY indent: `- old` directly under the key
      // with no indent is valid YAML, and what people type by hand.
      if (!/^aliases\s*:\s*\[/.test(head[at])) {
        while (end < head.length && /^\s*-\s/.test(head[end])) end++;
      }
      head.splice(at, end - at);
    }
    const scalars = edit.aliases.map(alias => yamlScalar(alias));
    if (scalars.includes(null)) return refused;
    if (scalars.length > 0) head.push(`aliases: [${scalars.join(", ")}]`);
  }
  const edited = ["---", ...head, ...lines.slice(close)].join(eol);

  const before = frontMatterOf(original);
  const after = frontMatterOf(edited);
  const parsed = parseSkillFile(folderName, edited);
  if (!before || !after || !parsed) return refused;
  if (edit.name !== undefined && after.name !== edit.name) return refused;
  if (edit.aliases !== undefined) {
    const want = [...new Set(edit.aliases)].sort();
    const raw = after.aliases === undefined ? [] : after.aliases;
    if (
      !Array.isArray(raw) ||
      JSON.stringify([...raw].sort()) !== JSON.stringify(want) ||
      JSON.stringify([...(parsed.aliases ?? [])].sort()) !==
        JSON.stringify(want.filter(alias => alias !== folderName))
    ) {
      return refused;
    }
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "name" || key === "aliases") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      return refused;
    }
  }
  return { ok: true, contents: edited };
}
