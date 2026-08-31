/**
 * Pure logic for the dbt file editor — diagnostics extraction, path → language
 * mapping, and model-name derivation. Kept out of the component so it can be
 * unit-tested without mounting Monaco.
 */
import type { DbtRunLogLine } from "../store/dbtStore";
import { DBT_JINJA_LANGUAGE_ID } from "./dbt-monaco";
import { basename } from "../utils/path";

export interface Problem {
  severity: "error" | "warn";
  message: string;
  filePath?: string;
}

const FILE_IN_PARENS = /\(([^()]+\.(?:sql|yml|yaml))\)/i;
const FILE_AFTER_PATH = /\bpath:\s*([^\s,)]+\.(?:sql|yml|yaml))/i;

export function extractFilePath(message: string): string | undefined {
  const m = message.match(FILE_IN_PARENS) ?? message.match(FILE_AFTER_PATH);
  return m?.[1];
}

/** Pull error/warn diagnostics out of a parse run's JSON log stream. */
export function logsToProblems(logs: DbtRunLogLine[]): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  for (const log of logs) {
    const severity =
      log.level === "error" ? "error" : log.level === "warn" ? "warn" : null;
    if (!severity) continue;
    const message = log.line.trim();
    if (!message || seen.has(message)) continue;
    seen.add(message);
    problems.push({ severity, message, filePath: extractFilePath(message) });
  }
  return problems;
}

export function languageForDbtPath(path: string): string {
  if (path.endsWith(".sql")) return DBT_JINJA_LANGUAGE_ID;
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  if (isMarkdownDbtPath(path)) return "markdown";
  return "plaintext";
}

/** True for dbt docs files that can be rendered as markdown (.md / .markdown). */
export function isMarkdownDbtPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** Model names (basename without .sql) under models/ for ref() completions. */
export function modelNamesFromPaths(paths: string[]): string[] {
  return paths
    .filter(p => p.startsWith("models/") && p.endsWith(".sql"))
    .map(p => basename(p).replace(/\.sql$/, ""))
    .filter(Boolean);
}

export function modelNameForPath(path: string): string | null {
  if (!path.startsWith("models/") || !path.endsWith(".sql")) return null;
  return basename(path).replace(/\.sql$/, "");
}
