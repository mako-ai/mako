/**
 * Path policy for dbt project trees — which files the IDE/runner surface out
 * of a project's git tree, and repo-subdirectory mapping helpers.
 */
import type { IDbtProject } from "../database/workspace-schema";

/**
 * Text extensions surfaced from a project tree. dbt projects are
 * SQL/YAML/CSV/Markdown; .gitkeep is kept so empty model dirs survive.
 * Generated/vendored output and binary assets are skipped.
 */
const TEXT_EXTENSIONS = new Set([
  "sql",
  "yml",
  "yaml",
  "md",
  "csv",
  "json",
  "txt",
  "sh",
  "py",
]);

/** Directories that are generated, vendored, or irrelevant to a dbt build. */
const SKIP_DIR_PREFIXES = [
  "target/",
  "dbt_packages/",
  "dbt_internal_packages/",
  "logs/",
  ".git/",
];

export function normalizeSubdir(subdirectory?: string): string {
  if (!subdirectory) return "";
  return subdirectory.replace(/^\/+|\/+$/g, "");
}

function hasTextExtension(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (base === ".gitkeep") return true;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return TEXT_EXTENSIONS.has(ext);
}

export function isImportable(path: string): boolean {
  if (SKIP_DIR_PREFIXES.some(prefix => path.startsWith(prefix))) return false;
  // Mako renders profiles.yml itself; never surface a committed one.
  if (path === "profiles.yml" || path.endsWith("/profiles.yml")) return false;
  return hasTextExtension(path);
}

/** Repo subdirectory prefix ("" or "sub/dir/") for a project. */
export function subdirPrefix(project: IDbtProject): string {
  const subdir = normalizeSubdir(project.repo?.subdirectory);
  return subdir ? `${subdir}/` : "";
}

/** Project-relative path → full repo path (prefixing the subdirectory). */
export function toRepoPath(project: IDbtProject, path: string): string {
  return `${subdirPrefix(project)}${path}`;
}

/**
 * Full repo path → project-relative path, or null when the file lives
 * outside the project subdirectory or is not a surfaced dbt file.
 */
export function toProjectPath(
  project: IDbtProject,
  repoPath: string,
): string | null {
  const prefix = subdirPrefix(project);
  if (prefix && !repoPath.startsWith(prefix)) return null;
  const rel = prefix ? repoPath.slice(prefix.length) : repoPath;
  return isImportable(rel) ? rel : null;
}
