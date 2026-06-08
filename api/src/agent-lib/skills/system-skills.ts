import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { FIELD_PATHS, generateFieldDocs } from "@mako/schemas";

export interface SystemSkillIndexEntry {
  id: string;
  name: string;
  description: string;
  dir: string;
  entities: string[];
}

export interface SystemSkill extends SystemSkillIndexEntry {
  body: string;
}

interface ParsedFrontmatter {
  name?: unknown;
  description?: unknown;
}

export interface SystemSkillRegistry {
  skills: Map<string, SystemSkill>;
  discoveredAt: Date;
  skillsDir: string;
}

const SKILL_FILE_NAME = "SKILL.md";
const FLOW_FIELD_DOCS_PLACEHOLDER = "{{FLOW_FIELD_DOCS}}";
const FLOW_FIELD_PATHS_PLACEHOLDER = "{{FLOW_FIELD_PATHS}}";

let registry: SystemSkillRegistry | null = null;

function resolveSystemSkillsDir(): string {
  return path.resolve(__dirname, "../../agent-skills");
}

function parseFrontmatter(content: string): {
  data: ParsedFrontmatter;
  body: string;
} {
  if (!content.startsWith("---\n")) {
    return { data: {}, body: content.trim() };
  }

  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return { data: {}, body: content.trim() };
  }

  const frontmatter = content.slice(4, end);
  const bodyStart = content.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "" : content.slice(bodyStart + 1);
  const parsed = yaml.load(frontmatter);

  return {
    data:
      parsed && typeof parsed === "object"
        ? (parsed as ParsedFrontmatter)
        : {},
    body: body.trim(),
  };
}

function renderGeneratedSections(name: string, body: string): string {
  if (name !== "flows") return body;

  return body
    .replace(FLOW_FIELD_DOCS_PLACEHOLDER, generateFieldDocs())
    .replace(FLOW_FIELD_PATHS_PLACEHOLDER, FIELD_PATHS.join("\n"));
}

function discoverSkillEntities(name: string, description: string): string[] {
  const tokens = new Set<string>();
  for (const raw of `${name} ${description}`.split(/[^A-Za-z0-9_]+/)) {
    const token = raw.toLowerCase().trim();
    if (token.length >= 3) tokens.add(token);
  }
  return [...tokens];
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
      entities: discoverSkillEntities(name, description),
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
  }));
}

export function getSystemSkill(name: string): SystemSkill | null {
  const trimmedName = name.trim();
  return getRegistry().skills.get(trimmedName) ?? null;
}

export function readSystemSkillResource(
  name: string,
  relPath: string,
):
  | { success: true; skill: string; path: string; content: string }
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
    return { success: false, error: "resource path must stay within skill dir" };
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
    return { success: false, error: "resource path must stay within skill dir" };
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return {
      success: false,
      error: `resource "${relPath}" not found for system skill "${name}"`,
    };
  }

  return {
    success: true,
    skill: skill.name,
    path: normalizedRelPath,
    content: fs.readFileSync(resolved, "utf8"),
  };
}
