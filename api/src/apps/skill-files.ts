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
import { loadYaml } from "../utils/yaml";

export const SKILLS_DIR = "skills";
export const SKILL_FILE_GLOB = `${SKILLS_DIR}/*/SKILL.md`;
/** Matches the agent/API save contract; larger authored files are invalid. */
export const MAX_SKILL_BODY_CHARS = 20_000;
/** Bounds one git blob before it is retained in the in-memory catalog. */
export const MAX_SKILL_FILE_BYTES = 64_000;
/** Bounds both API saves and catalogs authored directly in git. */
export const MAX_WORKSPACE_SKILLS = 200;
/**
 * Extra files a skill folder may carry, served read-only by
 * `read_skill_resource`: `skills/<name>/references/**`, `scripts/**` and
 * `resources/**`. Text only, by extension. Mako never runs them.
 */
export const SKILL_RESOURCE_DIRS = ["references", "scripts", "resources"];
export const SKILL_RESOURCE_EXTENSIONS = [
  ".md",
  ".txt",
  ".sql",
  ".py",
  ".js",
  ".mjs",
  ".ts",
  ".sh",
  ".json",
  ".yml",
  ".yaml",
  ".csv",
];
/** One resource file. Same bound as one SKILL.md: a read lands in a prompt. */
export const MAX_SKILL_RESOURCE_BYTES = 64_000;
/** Resource files served per skill; the rest are listed as refused. */
export const MAX_SKILL_RESOURCES_PER_SKILL = 40;
/** Total resource bytes served per skill. */
export const MAX_SKILL_RESOURCES_TOTAL_BYTES = 512_000;
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

A skill folder can also hold files the agent reads on demand with
\`read_skill_resource\`: \`references/\`, \`scripts/\` and \`resources/\`
(text files only, 64,000 bytes each, 40 files and 512,000 bytes per skill).
Mako serves them and never runs them.

A file that breaks a limit or does not parse is hidden from the agent. The
commit gets a failed \`mako/skills\` status that names it, and
\`list_skills\` returns it under \`invalid\`.
`;

/**
 * A skill name is its folder: lowercase letters, digits, `-` and `_`, starting
 * with a letter or digit. That keeps it one safe path segment (no `/`, no `.`,
 * so no `..`; no leading `-` that a shell could read as a flag) and accepts the
 * hyphenated names Claude Code skills and Mako's system skills use
 * (`app-ui-conventions`, `dialect-postgresql`). Until 2026-11 only snake_case
 * passed, and hyphenated folders committed from a clone never reached the
 * agent.
 */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** The rule above in words, for error messages. */
export const SKILL_NAME_RULE =
  "lowercase a-z, 0-9, '-' and '_', starting with a letter or digit";

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

/** `24713` → `24,713`, the same in every locale. */
export function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export type SkillFileParse =
  { ok: true; skill: WorkspaceSkillFile } | { ok: false; reason: string };

/** A YAML error as "front matter line 7: <what js-yaml said>". */
function describeYamlError(error: unknown): string {
  const yamlError = error as {
    reason?: unknown;
    message?: unknown;
    mark?: { line?: unknown };
  };
  const what =
    typeof yamlError.reason === "string"
      ? yamlError.reason
      : typeof yamlError.message === "string"
        ? yamlError.message.split("\n")[0]
        : "invalid YAML";
  // js-yaml counts from 0 inside the block; the file's line 1 is `---`.
  const line =
    typeof yamlError.mark?.line === "number" ? yamlError.mark.line + 2 : null;
  return line === null
    ? `front matter: ${what}`
    : `front matter line ${line}: ${what}`;
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
  const parsed = parseSkillFileDetailed(name, content);
  return parsed.ok ? parsed.skill : null;
}

/** {@link parseSkillFile}, with the reason a file does not parse. */
export function parseSkillFileDetailed(
  name: string,
  content: string,
): SkillFileParse {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(
    normalized,
  );
  if (!match) {
    return {
      ok: false,
      reason:
        "no front matter: the file must start with a `---` block that holds `description`",
    };
  }

  let data: Record<string, unknown>;
  try {
    const parsed = loadYaml(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        reason: "front matter must be YAML keys (`name`, `description`)",
      };
    }
    data = parsed as Record<string, unknown>;
  } catch (error) {
    return { ok: false, reason: describeYamlError(error) };
  }

  const loadWhen =
    typeof data.description === "string"
      ? data.description.trim()
      : typeof data.loadWhen === "string"
        ? data.loadWhen.trim()
        : "";
  if (!loadWhen) {
    return {
      ok: false,
      reason:
        data.description === undefined && data.loadWhen === undefined
          ? "front matter has no `description`"
          : "front matter `description` must be a line of text",
    };
  }

  const entities = Array.isArray(data.entities)
    ? data.entities
        .filter((e): e is string => typeof e === "string")
        .map(e => e.toLowerCase().trim())
        .filter(e => e.length > 0)
    : [];

  const body = (match[2] ?? "").trim();
  if (!body) {
    return { ok: false, reason: "the body under the front matter is empty" };
  }

  return {
    ok: true,
    skill: {
      name,
      loadWhen,
      entities,
      suppressed: data.suppressed === true,
      pinned: data.pinned === true,
      body,
    },
  };
}

// ---------------------------------------------------------------------------
// Resources: extra files in the skill folder
// ---------------------------------------------------------------------------

/** A file the skill folder ships next to SKILL.md, relative to the folder. */
export interface SkillResource {
  path: string;
  /** Bytes. */
  size: number;
}

/** A file under a resource folder that is not served, with why. */
export interface RefusedSkillResource {
  path: string;
  reason: string;
}

const RESOURCE_DIRS_TEXT = SKILL_RESOURCE_DIRS.map(dir => `${dir}/`).join(", ");

function extensionOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * A caller's resource path as the exact repo-relative form, or why it is
 * refused. Only forward-slash paths made of plain segments under one of the
 * resource folders pass: no absolute path, no `.` or `..` segment, no
 * backslash, no NUL. The caller still has to find the result in the skill's
 * own resource list; this keeps the error message honest.
 */
export function normalizeSkillResourcePath(
  input: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "path is required" };
  if (raw.includes("\0") || raw.includes("\\")) {
    return { ok: false, error: "resource path must stay within the skill" };
  }
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    return { ok: false, error: "resource path must stay within the skill" };
  }
  const segments = raw.split("/");
  if (segments.some(segment => segment === "" || /^\.+$/.test(segment))) {
    return { ok: false, error: "resource path must stay within the skill" };
  }
  if (segments.length < 2 || !SKILL_RESOURCE_DIRS.includes(segments[0])) {
    return {
      ok: false,
      error: `skill resources live under ${RESOURCE_DIRS_TEXT}`,
    };
  }
  return { ok: true, path: segments.join("/") };
}

/**
 * Sort a skill folder's files (paths relative to the folder) into what is
 * served and what is refused. Files outside the resource folders are not
 * resources and are ignored. Order is by path, so the caps cut the same
 * files on every instance.
 */
export function classifySkillResources(
  files: ReadonlyArray<{ path: string; size: number; mode: string }>,
): { resources: SkillResource[]; refused: RefusedSkillResource[] } {
  const resources: SkillResource[] = [];
  const refused: RefusedSkillResource[] = [];
  let totalBytes = 0;
  const candidates = files
    .filter(file => SKILL_RESOURCE_DIRS.includes(file.path.split("/")[0]))
    .filter(file => file.path.includes("/"))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of candidates) {
    const extension = extensionOf(file.path);
    let reason: string | null = null;
    if (file.mode === "120000") {
      reason = "symbolic links are not served";
    } else if (file.mode === "160000") {
      reason = "submodules are not served";
    } else if (!SKILL_RESOURCE_EXTENSIONS.includes(extension)) {
      reason = `${extension ? `"${extension}" files are` : "files with no extension are"} not served (text only: ${SKILL_RESOURCE_EXTENSIONS.join(" ")})`;
    } else if (file.size > MAX_SKILL_RESOURCE_BYTES) {
      reason = `file ${formatCount(file.size)} bytes over the ${formatCount(MAX_SKILL_RESOURCE_BYTES)} limit`;
    } else if (resources.length >= MAX_SKILL_RESOURCES_PER_SKILL) {
      reason = `over the ${MAX_SKILL_RESOURCES_PER_SKILL} resource files per skill limit`;
    } else if (totalBytes + file.size > MAX_SKILL_RESOURCES_TOTAL_BYTES) {
      reason = `over the ${formatCount(MAX_SKILL_RESOURCES_TOTAL_BYTES)} bytes of resources per skill limit`;
    }
    if (reason) {
      refused.push({ path: file.path, reason });
      continue;
    }
    totalBytes += file.size;
    resources.push({ path: file.path, size: file.size });
  }
  return { resources, refused };
}
