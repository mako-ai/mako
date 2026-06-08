import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { FIELD_PATHS, generateFieldDocs } from "@mako/schemas";
import { extractEntities } from "../entity-extraction";

export interface SystemSkillIndexEntry {
  id: string;
  name: string;
  description: string;
  dir: string;
  entities: string[];
  references: string[];
}

export interface SystemSkill extends SystemSkillIndexEntry {
  body: string;
}

interface ParsedFrontmatter {
  name?: unknown;
  description?: unknown;
  entities?: unknown;
}

export interface SystemSkillRegistry {
  skills: Map<string, SystemSkill>;
  discoveredAt: Date;
  skillsDir: string;
}

const SKILL_FILE_NAME = "SKILL.md";
const FLOW_FIELD_DOCS_PLACEHOLDER = "{{FLOW_FIELD_DOCS}}";
const FLOW_FIELD_PATHS_PLACEHOLDER = "{{FLOW_FIELD_PATHS}}";
const GENERIC_SYSTEM_ENTITY_TOKENS = new Set([
  "debug",
  "debugging",
  "load",
  "query",
  "queries",
  "sql",
  "syntax",
  "when",
  "write",
  "writing",
]);

let registry: SystemSkillRegistry | null = null;

function candidateSystemSkillsDirs(): string[] {
  return [
    path.resolve(__dirname, "../../agent-skills"),
    path.resolve(process.cwd(), "src/agent-skills"),
    path.resolve(process.cwd(), "dist/agent-skills"),
    path.resolve(process.cwd(), "agent-skills"),
  ];
}

function resolveSystemSkillsDir(): string {
  for (const dir of candidateSystemSkillsDirs()) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      return dir;
    }
  }
  return path.resolve(__dirname, "../../agent-skills");
}

function parseFrontmatter(content: string): {
  data: ParsedFrontmatter;
  body: string;
} {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(
    normalized,
  );
  if (!match) {
    return { data: {}, body: content.trim() };
  }

  const parsed = yaml.load(match[1]);

  return {
    data:
      parsed && typeof parsed === "object" ? (parsed as ParsedFrontmatter) : {},
    body: (match[2] ?? "").trim(),
  };
}

function renderGeneratedSections(name: string, body: string): string {
  if (name !== "flows") return body;

  return body
    .replace(FLOW_FIELD_DOCS_PLACEHOLDER, generateFieldDocs())
    .replace(FLOW_FIELD_PATHS_PLACEHOLDER, FIELD_PATHS.join("\n"));
}

function normalizeDeclaredEntities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entities: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const entity = item.toLowerCase().trim();
    if (!entity || seen.has(entity)) continue;
    seen.add(entity);
    entities.push(entity);
  }
  return entities;
}

function discoverSkillEntities(
  name: string,
  description: string,
  declared: unknown,
): string[] {
  const seen = new Set<string>();
  const entities: string[] = [];
  for (const raw of [
    ...normalizeDeclaredEntities(declared),
    ...extractEntities(`${name} ${description}`),
  ]) {
    const entity = raw.toLowerCase().trim();
    if (entity.length < 2 || seen.has(entity)) continue;
    if (GENERIC_SYSTEM_ENTITY_TOKENS.has(entity)) continue;
    seen.add(entity);
    entities.push(entity);
  }
  return entities;
}

function listReferenceFiles(skillDir: string): string[] {
  const referencesDir = path.join(skillDir, "references");
  if (!fs.existsSync(referencesDir)) return [];
  return fs
    .readdirSync(referencesDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(entry => path.join("references", entry.name))
    .sort((a, b) => a.localeCompare(b));
}

export function discoverSystemSkills(): SystemSkillRegistry {
  const skillsDir = resolveSystemSkillsDir();
  const skills = new Map<string, SystemSkill>();

  if (!fs.existsSync(skillsDir)) {
    registry = { skills, discoveredAt: new Date(), skillsDir };
    return registry;
  }

  const entries = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const dir = path.join(skillsDir, entry.name);
    const skillPath = path.join(dir, SKILL_FILE_NAME);
    if (!fs.existsSync(skillPath)) continue;

    const content = fs.readFileSync(skillPath, "utf8");
    const { data, body } = parseFrontmatter(content);
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const description =
      typeof data.description === "string" ? data.description.trim() : "";

    if (!name || !description) {
      throw new Error(
        `System skill ${skillPath} must declare frontmatter name and description`,
      );
    }
    if (skills.has(name)) {
      throw new Error(`Duplicate system skill name "${name}" in ${skillPath}`);
    }

    skills.set(name, {
      id: `system:${name}`,
      name,
      description,
      dir,
      body: renderGeneratedSections(name, body),
      entities: discoverSkillEntities(name, description, data.entities),
      references: listReferenceFiles(dir),
    });
  }

  registry = { skills, discoveredAt: new Date(), skillsDir };
  return registry;
}

function getRegistry(): SystemSkillRegistry {
  return registry ?? discoverSystemSkills();
}

export function getSystemSkillIndex(): SystemSkillIndexEntry[] {
  return [...getRegistry().skills.values()].map(skill => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    dir: skill.dir,
    entities: skill.entities,
    references: skill.references,
  }));
}

export function getSystemSkill(name: string): SystemSkill | null {
  const trimmedName = name.trim();
  return getRegistry().skills.get(trimmedName) ?? null;
}

export function getSystemSkillFullText(name: string): string {
  const skill = getSystemSkill(name);
  if (!skill) return "";

  const parts = [skill.body];
  for (const relPath of skill.references) {
    const resource = readSystemSkillResource(skill.name, relPath);
    if (!resource.success) continue;
    parts.push(`<!-- reference: ${relPath} -->`);
    parts.push(resource.content.trim());
  }
  return parts.join("\n\n");
}

export function readSystemSkillResource(
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
  const skill = getSystemSkill(name);
  if (!skill) {
    return { success: false, error: `system skill "${name}" not found` };
  }

  const normalizedRelPath = path.normalize(relPath);
  if (
    path.isAbsolute(relPath) ||
    normalizedRelPath.startsWith("..") ||
    normalizedRelPath.includes(`${path.sep}..${path.sep}`)
  ) {
    return {
      success: false,
      error: "resource path must stay within skill dir",
    };
  }
  if (!normalizedRelPath.startsWith(`references${path.sep}`)) {
    return {
      success: false,
      error: "system skill resources must live under references/",
    };
  }
  if (path.extname(normalizedRelPath) !== ".md") {
    return { success: false, error: "only markdown resources are readable" };
  }

  const resolved = path.resolve(skill.dir, normalizedRelPath);
  const root = path.resolve(skill.dir) + path.sep;
  if (!resolved.startsWith(root)) {
    return {
      success: false,
      error: "resource path must stay within skill dir",
    };
  }
  if (!fs.existsSync(resolved)) {
    return {
      success: false,
      error: `resource "${relPath}" not found for system skill "${name}"`,
    };
  }

  const resourceStat = fs.lstatSync(resolved);
  if (resourceStat.isSymbolicLink()) {
    return { success: false, error: "symbolic links are not readable" };
  }
  if (!resourceStat.isFile()) {
    return {
      success: false,
      error: `resource "${relPath}" not found for system skill "${name}"`,
    };
  }

  const realSkillDir = fs.realpathSync(skill.dir) + path.sep;
  const realResourcePath = fs.realpathSync(resolved);
  if (!realResourcePath.startsWith(realSkillDir)) {
    return {
      success: false,
      error: "resource path must stay within skill dir",
    };
  }

  return {
    success: true,
    skill: skill.name,
    path: normalizedRelPath,
    content: fs.readFileSync(resolved, "utf8"),
    references: skill.references,
  };
}
