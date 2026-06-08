/**
 * System Skills registry — filesystem-backed Agent Skills (SKILL.md packages).
 *
 * These are git-versioned, always-available skills that live under
 * `api/src/agent-skills/<name>/SKILL.md`. They mirror the AI SDK cookbook
 * `discoverSkills`/`parseFrontmatter` pattern: each package has YAML
 * frontmatter (`name`, `description`, optional `entities`) and a markdown
 * body. Long-form material lives in `references/*.md` and is pulled on
 * demand via `read_skill_resource` (tier-3 progressive disclosure).
 *
 * Unlike workspace skills (Mongo-backed, learned memory), system skills are
 * static reference material extracted out of the base system prompt so the
 * prompt stays lean and the heavy content loads only when relevant.
 *
 * Discovery runs once at first access and is cached. The skills directory is
 * resolved relative to this module so it works under both `tsx` (src) and
 * `node` (dist) — `copyfiles` bundles the markdown into `dist/agent-skills`.
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { extractEntities } from "../entity-extraction";
import { loggers } from "../../logging";

const logger = loggers.app();

export interface SystemSkill {
  /** Stable snake_case-ish identifier (matches the directory name). */
  name: string;
  /** The retrieval trigger — "when to load this skill". Maps to loadWhen. */
  description: string;
  /** Rendered markdown body (template placeholders substituted). */
  body: string;
  /** Tokens for entity-overlap scoring (name + description + declared). */
  entities: string[];
  /** Absolute path to the skill package directory. */
  dir: string;
  /** Relative paths (from the package dir) of files under references/. */
  references: string[];
}

export interface SystemSkillIndexEntry {
  name: string;
  description: string;
  entities: string[];
  references: string[];
}

interface RawSystemSkill {
  name: string;
  description: string;
  declaredEntities: string[];
  rawBody: string;
  dir: string;
  references: string[];
}

/**
 * Optional per-skill template providers. A provider returns a map of
 * `{{KEY}}` -> replacement applied to the body at read time. Used by the
 * flow skill to inject auto-generated field docs from the unified schema
 * (kept dynamic so it never drifts from the schema).
 */
const templateProviders = new Map<string, () => Record<string, string>>();

let cache: Map<string, RawSystemSkill> | null = null;

/** Resolve candidate locations for the agent-skills directory. */
function candidateDirs(): string[] {
  return [
    // Relative to this module: src/agent-lib/skills -> src/agent-skills,
    // dist/agent-lib/skills -> dist/agent-skills.
    path.resolve(__dirname, "..", "..", "agent-skills"),
    path.resolve(process.cwd(), "src", "agent-skills"),
    path.resolve(process.cwd(), "dist", "agent-skills"),
    path.resolve(process.cwd(), "agent-skills"),
  ];
}

function resolveSkillsRoot(): string | null {
  for (const dir of candidateDirs()) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // ignore and try the next candidate
    }
  }
  return null;
}

/**
 * Minimal YAML frontmatter parser. Expects a leading `---` fenced block.
 * Mirrors the AI SDK cookbook `parseFrontmatter`, but uses `js-yaml` (already
 * a dependency) for robust value parsing.
 */
export function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const normalized = raw.replace(/^\uFEFF/, "");
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(
    normalized,
  );
  if (!match) {
    return { data: {}, body: normalized.trim() };
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
    }
  } catch (err) {
    logger.warn("System skill frontmatter parse failed", { error: err });
  }
  return { data, body: (match[2] ?? "").trim() };
}

function listReferenceFiles(skillDir: string): string[] {
  const refsDir = path.join(skillDir, "references");
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(refsDir)) return out;
    entries = fs.readdirSync(refsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(path.join("references", entry.name));
    }
  }
  return out.sort();
}

/**
 * Scan the agent-skills directory and parse every `<name>/SKILL.md` package.
 * Cached after the first call; pass `force` to rescan.
 */
export function discoverSystemSkills(
  force = false,
): Map<string, RawSystemSkill> {
  if (cache && !force) return cache;

  const result = new Map<string, RawSystemSkill>();
  const root = resolveSkillsRoot();
  if (!root) {
    logger.warn("System skills directory not found; no system skills loaded", {
      candidates: candidateDirs(),
    });
    cache = result;
    return result;
  }

  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    logger.warn("Failed to read system skills directory", { error: err, root });
    cache = result;
    return result;
  }

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(root, entry.name);
    const skillFile = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;

    let raw: string;
    try {
      raw = fs.readFileSync(skillFile, "utf8");
    } catch (err) {
      logger.warn("Failed to read SKILL.md", { error: err, skillFile });
      continue;
    }

    const { data, body } = parseFrontmatter(raw);
    const name =
      typeof data.name === "string" && data.name.trim().length > 0
        ? data.name.trim()
        : entry.name;
    const description =
      typeof data.description === "string" ? data.description.trim() : "";

    if (!description) {
      logger.warn("System skill missing description frontmatter; skipping", {
        skillFile,
      });
      continue;
    }

    if (result.has(name)) {
      logger.error("Duplicate system skill name; keeping first occurrence", {
        name,
        skillFile,
      });
      continue;
    }

    const declaredEntities = Array.isArray(data.entities)
      ? (data.entities as unknown[])
          .filter((e): e is string => typeof e === "string")
          .map(e => e.toLowerCase().trim())
          .filter(Boolean)
      : [];

    result.set(name, {
      name,
      description,
      declaredEntities,
      rawBody: body,
      dir: skillDir,
      references: listReferenceFiles(skillDir),
    });
  }

  cache = result;
  logger.info("Discovered system skills", {
    count: result.size,
    names: Array.from(result.keys()),
    root,
  });
  return result;
}

function computeEntities(raw: RawSystemSkill): string[] {
  const extracted = extractEntities(`${raw.name} ${raw.description}`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of [...raw.declaredEntities, ...extracted]) {
    const norm = e.toLowerCase().trim();
    if (norm.length < 2 || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

function renderBody(raw: RawSystemSkill): string {
  const provider = templateProviders.get(raw.name);
  if (!provider) return raw.rawBody;
  let body = raw.rawBody;
  try {
    const subs = provider();
    for (const [key, value] of Object.entries(subs)) {
      body = body.split(`{{${key}}}`).join(value);
    }
  } catch (err) {
    logger.warn("System skill template substitution failed", {
      error: err,
      name: raw.name,
    });
  }
  return body;
}

function toSystemSkill(raw: RawSystemSkill): SystemSkill {
  return {
    name: raw.name,
    description: raw.description,
    body: renderBody(raw),
    entities: computeEntities(raw),
    dir: raw.dir,
    references: raw.references,
  };
}

/**
 * Register a template provider for a skill body. Idempotent (last wins).
 * Call this at module load (side effect) before the skill is read, e.g. from
 * the flow prompt module which injects auto-generated form field docs.
 */
export function registerSystemSkillTemplate(
  name: string,
  provider: () => Record<string, string>,
): void {
  templateProviders.set(name, provider);
}

/** Compact catalog of every system skill (name + description + entities). */
export function getSystemSkillIndex(): SystemSkillIndexEntry[] {
  const skills = discoverSystemSkills();
  return Array.from(skills.values())
    .map(raw => ({
      name: raw.name,
      description: raw.description,
      entities: computeEntities(raw),
      references: raw.references,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a single system skill by name (body rendered). */
export function getSystemSkill(name: string): SystemSkill | undefined {
  const raw = discoverSystemSkills().get(name);
  return raw ? toSystemSkill(raw) : undefined;
}

/**
 * Full text of a system skill: the SKILL.md body followed by every
 * `references/*.md` file concatenated. Used by the standalone dashboard/flow
 * agents which need the complete guide inlined (no progressive disclosure).
 */
export function getSystemSkillFullText(name: string): string {
  const raw = discoverSystemSkills().get(name);
  if (!raw) return "";
  const parts: string[] = [renderBody(raw)];
  for (const rel of raw.references) {
    const content = readReference(raw, rel);
    if (content) {
      parts.push("");
      parts.push(`<!-- reference: ${rel} -->`);
      parts.push(content);
    }
  }
  return parts.join("\n");
}

export interface ReadSystemSkillResourceResult {
  content: string;
  /** Resolved, normalized relative path actually read. */
  path: string;
  /** Other reference files exposed by the same skill. */
  references: string[];
}

/**
 * Validate a caller-supplied reference path and return the safe absolute path,
 * or an error string. Tier-3 reads are confined to the skill's `references/`
 * directory, must be markdown, must not escape via `..`/absolute paths, and
 * must not traverse a symlink out of the package (checked via realpath).
 */
function resolveReferencePath(
  raw: RawSystemSkill,
  relPath: string,
): { ok: true; abs: string; rel: string } | { ok: false; error: string } {
  const normalized = path.normalize(relPath);
  if (
    path.isAbsolute(relPath) ||
    normalized.startsWith("..") ||
    normalized.includes(`..${path.sep}`)
  ) {
    return { ok: false, error: "resource path must stay within the skill dir" };
  }
  if (!normalized.startsWith(`references${path.sep}`)) {
    return {
      ok: false,
      error: "system skill resources must live under references/",
    };
  }
  if (path.extname(normalized) !== ".md") {
    return { ok: false, error: "only markdown (.md) resources are readable" };
  }

  const resolved = path.resolve(raw.dir, normalized);
  const root = path.resolve(raw.dir) + path.sep;
  if (!resolved.startsWith(root)) {
    return { ok: false, error: "resource path must stay within the skill dir" };
  }

  try {
    if (!fs.existsSync(resolved)) {
      return { ok: false, error: `resource "${relPath}" not found` };
    }
    // Reject symlinks and verify the real path stays inside the package, so a
    // symlinked reference can't be used to read outside the skill dir.
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      return { ok: false, error: "symbolic links are not readable" };
    }
    if (!stat.isFile()) {
      return { ok: false, error: `resource "${relPath}" not found` };
    }
    const realRoot = fs.realpathSync(raw.dir) + path.sep;
    const realResolved = fs.realpathSync(resolved);
    if (!realResolved.startsWith(realRoot)) {
      return {
        ok: false,
        error: "resource path must stay within the skill dir",
      };
    }
  } catch (err) {
    logger.warn("System skill resource validation failed", {
      error: err,
      name: raw.name,
      relPath,
    });
    return { ok: false, error: `resource "${relPath}" not readable` };
  }

  return { ok: true, abs: resolved, rel: normalized };
}

function readReference(raw: RawSystemSkill, relPath: string): string | null {
  const check = resolveReferencePath(raw, relPath);
  if (!check.ok) return null;
  try {
    return fs.readFileSync(check.abs, "utf8");
  } catch (err) {
    logger.warn("Failed to read system skill resource", {
      error: err,
      name: raw.name,
      relPath,
    });
    return null;
  }
}

/**
 * Read a tier-3 reference file for a skill. `relPath` is relative to the skill
 * package directory and must point at a markdown file under `references/`
 * (e.g. `references/cross-filtering.md`). Returns a discriminated union so the
 * agent gets a descriptive reason on failure.
 */
export function readSystemSkillResource(
  name: string,
  relPath: string,
):
  | { success: true; result: ReadSystemSkillResourceResult }
  | { success: false; error: string } {
  const raw = discoverSystemSkills().get(name);
  if (!raw) {
    return { success: false, error: `system skill "${name}" not found` };
  }
  const check = resolveReferencePath(raw, relPath);
  if (!check.ok) return { success: false, error: check.error };
  let content: string;
  try {
    content = fs.readFileSync(check.abs, "utf8");
  } catch (err) {
    logger.warn("Failed to read system skill resource", {
      error: err,
      name,
      relPath,
    });
    return { success: false, error: `resource "${relPath}" not readable` };
  }
  return {
    success: true,
    result: { content, path: check.rel, references: raw.references },
  };
}
