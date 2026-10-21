/**
 * The text an app is embedded as, for semantic search (app-embeddings.service).
 * Pure: the caller reads the files, this decides what of them says what the
 * app is about.
 *
 * Titles and descriptions rarely say everything. "INTL Sales Dashboard"
 * never says "acquisition", but its filter is labelled "Acquisition
 * channel". So the document is the manifest and folder, the tables the
 * bindings read, the head of the README, and the human-facing strings of
 * the UI: headings, labels, tab names, placeholders. Code, class names and
 * SQL fragments are noise and stay out. Bounded so one embedding call
 * covers the whole workspace.
 */
import { createHash } from "node:crypto";
import { tokenize } from "./app-search";

export const EMBEDDING_DOC_MAX_CHARS = 4000;
const README_MAX_CHARS = 2000;
const UI_MAX_CHARS = 1500;
const TABLES_MAX = 30;
/** UI files read per app, and bytes per file: a bundle is not a source. */
export const UI_FILES_MAX = 40;
export const UI_FILE_MAX_BYTES = 200_000;

export interface AppEmbeddingInput {
  title: string;
  description?: string;
  /** Repo path of the app folder (`apps/Sales/CH/report`). */
  path: string;
  tables: string[];
  readme?: string;
  /** `src/**\/*.tsx` sources, by app-relative path. */
  sources?: Array<{ path: string; text: string }>;
}

/** `apps/Sales/CH/leads-by-canton` → `Sales / CH / leads by canton`. */
export function folderWords(path: string): string {
  const parts = path.split("/");
  const at = parts.lastIndexOf("apps");
  return parts
    .slice(at + 1)
    .map(p => p.replace(/[-_]+/g, " ").trim())
    .filter(Boolean)
    .join(" / ");
}

/** Markdown to plain prose: no code blocks, links as their text. */
export function readmeText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[#>*\-+\s|]+/gm, "")
    .replace(/[|*_]{1,3}/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const UI_ATTRS =
  "label|title|placeholder|aria-label|header|headerName|subtitle|caption|heading|tooltip|helperText|emptyText|name";
const ATTR_RE = new RegExp(
  String.raw`\b(?:${UI_ATTRS})\s*=\s*(?:\{\s*)?(["'\x60])([^"'\x60{}$\n]{3,80})\1`,
  "g",
);
const PROP_RE = new RegExp(
  String.raw`\b(?:${UI_ATTRS})\s*:\s*(["'\x60])([^"'\x60{}$\n]{3,80})\1`,
  "g",
);
// Text between tags: `<h2>Pipeline by stage</h2>`, `<Tab>Overview</Tab>`.
const JSX_TEXT_RE = />\s*([^<>{}=;]{3,80}?)\s*</g;

/** A string a person reads, as opposed to a class name or an identifier. */
function isProse(s: string): boolean {
  const t = s.trim();
  if (t.length < 3 || t.length > 80) return false;
  if (!/[A-Za-z]{2}/.test(t)) return false;
  // Identifiers, CSS, paths, URLs, format strings.
  if (/^[a-z0-9]+(?:[A-Z_-][a-zA-Z0-9]*)+$/.test(t)) return false;
  if (/^[\w-]+$/.test(t) && !/^[A-Z]/.test(t)) return false;
  if (/[\\/]|https?:|=>|&&|\|\||::|\(\)|^\.|\.\w+$/.test(t)) return false;
  if (/^(?:[a-z-]+:|#|var\(|calc\()/.test(t)) return false;
  // Fragments of expressions caught between two tags: `) : loading ? (`.
  if (/[{}[\]]|\)\s*[:?]|[:?]\s*\(|^[)(:?]|[:?]$/.test(t)) return false;
  // Tailwind / class lists: several lowercase-dash tokens.
  if (/^(?:[a-z0-9:[\].-]+-[a-z0-9:[\].-]+\s*){2,}$/.test(t)) return false;
  return true;
}

/**
 * The strings a person reads in an app's UI, deduplicated, in source order
 * (the entry file first, so the top-level headings and tabs lead).
 */
export function uiStrings(
  sources: Array<{ path: string; text: string }>,
  maxChars: number,
): string[] {
  const ordered = [...sources].sort((a, b) => {
    const rank = (p: string) =>
      /(^|\/)App\.tsx$/.test(p) ? 0 : /(^|\/)main\.tsx$/.test(p) ? 2 : 1;
    return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
  });
  const seen = new Set<string>();
  const out: string[] = [];
  let used = 0;
  for (const { text } of ordered) {
    const found: Array<{ at: number; s: string }> = [];
    for (const re of [ATTR_RE, PROP_RE, JSX_TEXT_RE]) {
      for (const m of text.matchAll(re)) {
        found.push({ at: m.index ?? 0, s: m[m.length - 1] });
      }
    }
    found.sort((a, b) => a.at - b.at);
    for (const { s } of found) {
      const t = s
        .replace(/\s+/g, " ")
        .replace(/&nbsp;|&amp;/g, " ")
        .trim();
      if (!isProse(t)) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      if (used + t.length + 2 > maxChars) return out;
      seen.add(key);
      out.push(t);
      used += t.length + 2;
    }
  }
  return out;
}

/** The document an app is embedded as. Deterministic for equal input. */
/**
 * `realadvisor-prod.{{dbt_schema}}.fct_intl_sales_demos` → `intl sales
 * demos`: the words of a table name, without the project, the dataset, the
 * templating or the dbt layer prefix (all of which every app shares).
 */
export function tableWords(tables: string[]): string[] {
  const out = new Set<string>();
  for (const t of tables) {
    const name = t
      .replace(/\{\{[^}]*\}\}/g, "")
      .split(".")
      .filter(Boolean)
      .pop();
    if (!name || name.startsWith("__")) continue;
    const words = name
      .replace(/^(?:fct|dim|int|stg|raw|src|mart|rpt|v|vw|tmp)_+/i, "")
      .replace(/_+/g, " ")
      .trim()
      .toLowerCase();
    if (words) out.add(words);
  }
  return [...out].slice(0, TABLES_MAX);
}

/** The document an app is embedded as. Deterministic for equal input. */
export function buildAppEmbeddingDocument(input: AppEmbeddingInput): string {
  const head: string[] = [input.title.trim()];
  if (input.description?.trim()) head.push(input.description.trim());
  const folder = folderWords(input.path);
  if (folder) head.push(`Folder: ${folder}`);
  const tables = tableWords(input.tables);
  if (tables.length > 0) head.push(`Data: ${tables.join(", ")}`);
  let doc = head.join("\n");
  // The UI's words before the README's: a label says what the app shows,
  // a README is as often a changelog.
  if (input.sources && input.sources.length > 0) {
    const strings = uiStrings(input.sources, UI_MAX_CHARS);
    if (strings.length > 0) doc += `\nUI: ${strings.join("; ")}`;
  }
  const readme = input.readme ? readmeText(input.readme) : "";
  if (readme) doc += `\n${readme.slice(0, README_MAX_CHARS)}`;
  return doc.slice(0, EMBEDDING_DOC_MAX_CHARS);
}

/** Content hash of a document under a model: equal ⇒ no re-embed. */
export function embeddingDocHash(doc: string, model: string): string {
  return createHash("sha256").update(`${model}\n${doc}`).digest("hex");
}

/** Which app files the document reads, by app-relative path. */
export function isEmbeddingSourceFile(rel: string): "readme" | "ui" | null {
  if (/^readme\.md$/i.test(rel)) return "readme";
  if (
    /^src\/.+\.tsx$/.test(rel) &&
    !/\.(test|spec|stories)\.tsx$/.test(rel) &&
    !/(^|\/)(__tests__|node_modules|dist)\//.test(rel)
  ) {
    return "ui";
  }
  return null;
}

/** Distinct words of a document, for matching query words against it. */
export function documentTerms(doc: string, max = 1000): string[] {
  return [...new Set(tokenize(doc))].slice(0, max);
}
