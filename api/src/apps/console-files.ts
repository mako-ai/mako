/**
 * Consoles as repo content (apps.md §16, Block D2).
 *
 * A saved console is one file in the workspace repo:
 *
 *   consoles/<folder path>/<name>.sql                  access = workspace
 *   users/<ownerId>/consoles/<folder path>/<name>.sql  access = private
 *
 * The extension carries the language (`.sql`, `.js`, `.mongodb.js`), the
 * filename is the console's name, and the directories are its folder chain.
 * Front-matter follows the bindings convention — leading `-- key: value`
 * (or `// key: value`) comment lines, closed by the first blank line — so the
 * file stays runnable by any SQL tool:
 *
 *   -- connection: 6846e6a01b05af0948070583
 *   -- database: analytics
 *   -- description: Monthly recurring revenue by plan
 *   -- schedule: 0 6 * * 1
 *   -- timezone: Europe/Zurich
 *
 *   SELECT ...
 *
 * A chart spec is a sidecar `<name>.chart.json` next to the file. Anything
 * server-derived (embeddings, execution telemetry, shares, run results)
 * never enters the file — Mongo keeps that as the derived index (§16.4).
 *
 * This module is pure format: paths, serialize, parse. Git and Mongo live in
 * workspace-consoles.service.ts.
 */

export const CONSOLES_DIR = "consoles";
export const USERS_DIR = "users";
/**
 * Adoption marker. While absent, Mongo may hold consoles git has never seen,
 * so the push-driven index sync must not read "not in git" as "deleted".
 */
export const CONSOLES_README_PATH = `${CONSOLES_DIR}/README.md`;

export const CONSOLES_README = `# Consoles

Saved SQL / JavaScript / MongoDB consoles of this workspace, one file each.
Managed by Mako: the app writes here on every explicit save, and anything
committed here (from a clone, a terminal, the agent) shows up in the app on
the next push.

- \`consoles/<folder>/<name>.sql\` is visible to the whole workspace;
  \`users/<userId>/consoles/…\` is that user's private console.
- Leading \`-- key: value\` comment lines are metadata (\`connection\`,
  \`database\`, \`description\`, \`schedule\`, \`timezone\`); the first blank
  line ends them. \`<name>.chart.json\` next to a file is its chart.
- Extension = language: \`.sql\`, \`.js\`, \`.mongodb.js\`.
`;

export type ConsoleLanguage = "sql" | "javascript" | "mongodb";

export interface ConsoleSchedule {
  cron: string;
  timezone: string;
}

export interface ConsoleMongoOptions {
  collection: string;
  operation: string;
}

/** Everything about a console that is authored, i.e. belongs in the file. */
export interface ConsoleFileState {
  name: string;
  language: ConsoleLanguage;
  code: string;
  connectionId?: string;
  databaseName?: string;
  databaseId?: string;
  /** An authored description — never the LLM-generated one (§16.4). */
  description?: string;
  schedule?: ConsoleSchedule;
  resultsViewMode?: "table" | "json" | "chart";
  mongoOptions?: ConsoleMongoOptions;
  chartSpec?: Record<string, unknown>;
}

export interface ConsoleRepoLocation {
  scope: "workspace" | "private";
  /** Set for private consoles: the `users/<ownerId>` segment. */
  ownerId?: string;
  folderSegments: string[];
  name: string;
  language: ConsoleLanguage;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const EXTENSIONS: Array<[ConsoleLanguage, string]> = [
  // Longest first so `.mongodb.js` wins over `.js`.
  ["mongodb", ".mongodb.js"],
  ["javascript", ".js"],
  ["sql", ".sql"],
];

export function consoleExtension(language: ConsoleLanguage): string {
  return EXTENSIONS.find(([l]) => l === language)?.[1] ?? ".sql";
}

/** Split `<name><ext>` into its parts, or null when the extension is foreign. */
export function splitConsoleFileName(
  fileName: string,
): { name: string; language: ConsoleLanguage } | null {
  for (const [language, ext] of EXTENSIONS) {
    if (fileName.length > ext.length && fileName.endsWith(ext)) {
      return { name: fileName.slice(0, -ext.length), language };
    }
  }
  return null;
}

/**
 * A console or folder name as one path segment. Names are user text — the
 * filename IS the display name, so this only removes what a path cannot
 * carry (separators, control characters, leading dots, edge whitespace) and
 * bounds the length. Never empty: an unnameable console is "untitled".
 */
export function safeSegment(name: string): string {
  const cleaned = name
    .normalize("NFC")
    .replace(/[\\/\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim();
  // Bounded in UTF-16 units, cut on a code point: half an emoji (a lone
  // surrogate) reaches git as U+FFFD, and the path Mako recorded would
  // never match the file again.
  let bounded = cleaned.slice(0, 120);
  if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
  const result = bounded.trim();
  if (!result || result === ".git") return "untitled";
  return result;
}

/** The longest console or folder name: one segment of its repo path. */
export const MAX_CONSOLE_NAME_LENGTH = 120;

/** Zero-width spaces/joiners, the word joiner and a BOM: invisible in a name. */
const INVISIBLE_IN_NAME = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * A console or folder name as a person typed it → as it is stored and
 * filed. Unicode NFC (an "é" typed as e + ◌́ IS "é" — two consoles whose
 * names look identical must not exist), invisible characters dropped,
 * control characters and runs of whitespace made one space, the edges
 * trimmed: exactly the cosmetic part of what `safeSegment` does to a file
 * name, so the stored name IS its file's name and a sync reading the name
 * back from the file never renames the console.
 */
export function normalizeConsoleName(name: string): string {
  return name
    .normalize("NFC")
    .replace(INVISIBLE_IN_NAME, "")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
}

/** Device names Windows reserves, with or without an extension (`NUL.txt`). */
const RESERVED_ON_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * Why a (normalized) name cannot be a console's or a folder's — its file or
 * directory name in the workspace repo, checked out on every OS — or null.
 * Only NEW names are judged (a rename, a create): a console a laptop pushed
 * under a name Mako would refuse keeps it until someone renames it.
 */
export function consoleNameProblem(
  name: string,
  kind: "console" | "folder",
  language?: ConsoleLanguage,
): string | null {
  const what = kind === "console" ? "A console" : "A folder";
  if (!name) return `${what} needs a name.`;
  if (name.length > MAX_CONSOLE_NAME_LENGTH) {
    return `${what} name can be at most ${MAX_CONSOLE_NAME_LENGTH} characters (this one has ${name.length}).`;
  }
  const bad = /[\\/:*?"<>|]/.exec(name)?.[0];
  if (bad) {
    return `${what} name cannot contain “${bad}”: / \\ : * ? " < > | are not allowed in file names on every computer.`;
  }
  if (name.startsWith(".")) return `${what} name cannot start with a dot.`;
  if (name.endsWith(".")) return `${what} name cannot end with a dot.`;
  if (RESERVED_ON_WINDOWS.test(name)) {
    return `“${name.split(".")[0]}” is a reserved file name on Windows; choose another ${kind} name.`;
  }
  if (
    kind === "console" &&
    language === "javascript" &&
    name.endsWith(".mongodb")
  ) {
    return "A JavaScript console's name cannot end in “.mongodb”: its file would read as a MongoDB console.";
  }
  // Anything else the file name would not carry as it is.
  if (safeSegment(name) !== name) {
    return `${what} name “${name}” cannot be used as a file name.`;
  }
  return null;
}

/**
 * A name a console or folder cannot take (see `consoleNameProblem`): a
 * clear 400 on every route, nothing changed.
 */
export class ConsoleNameError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "ConsoleNameError";
  }
}

/** `normalizeConsoleName`, refusing (`ConsoleNameError`) what cannot be one. */
export function cleanConsoleName(
  name: string,
  kind: "console" | "folder",
  language?: ConsoleLanguage,
): string {
  const clean = normalizeConsoleName(name);
  const problem = consoleNameProblem(clean, kind, language);
  if (problem) throw new ConsoleNameError(problem);
  return clean;
}

/**
 * A repo path as a case-insensitive, Unicode-normalizing file system sees
 * it (macOS, Windows): two paths with one fold are one file there.
 */
export function foldConsolePath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

const CHART_SUFFIX = ".chart.json";

export function consoleRepoPath(location: {
  scope: "workspace" | "private";
  ownerId?: string;
  folderSegments: string[];
  name: string;
  language: ConsoleLanguage;
}): string {
  const root =
    location.scope === "private"
      ? `${USERS_DIR}/${requireOwner(location.ownerId)}/${CONSOLES_DIR}`
      : CONSOLES_DIR;
  const folders = location.folderSegments.map(safeSegment);
  const file = `${safeSegment(location.name)}${consoleExtension(location.language)}`;
  return [root, ...folders, file].join("/");
}

function requireOwner(ownerId: string | undefined): string {
  const id = (ownerId ?? "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(
      `A private console needs an owner id (got ${JSON.stringify(ownerId)})`,
    );
  }
  return id;
}

/** The sidecar path carrying a console file's chart spec. */
export function chartSidecarPath(consolePath: string): string {
  const parsed = parseConsoleRepoPath(consolePath);
  if (!parsed) throw new Error(`Not a console path: ${consolePath}`);
  return `${consolePath.slice(0, -consoleExtension(parsed.language).length)}${CHART_SUFFIX}`;
}

export function isChartSidecarPath(path: string): boolean {
  return path.endsWith(CHART_SUFFIX);
}

/**
 * "A console named 'Ghost6' already exists in New Folder." — the refusal
 * of a save, rename, move or copy onto a taken file, in the words of the
 * explorer (its name and its folder, or the section's root), never the
 * repo path (`consoles/New Folder/Ghost6.sql` reached the e2e's modal). A
 * chart sidecar names its console. `actorUserId` decides whether a
 * private root is "My Consoles" or someone else's.
 */
export function consolePathTakenMessage(
  path: string,
  actorUserId?: string | null,
  /**
   * The path that was asked for, when it is not `path` itself: a name that
   * differs from the existing one only in letter case. The message names
   * the EXISTING console and says why it counts.
   */
  wantedPath?: string | null,
): string {
  const consolePath = isChartSidecarPath(path)
    ? `${path.slice(0, -CHART_SUFFIX.length)}.sql`
    : path;
  const location = parseConsoleRepoPath(consolePath);
  if (!location) return "A console with that name already exists there.";
  const where =
    location.folderSegments.length > 0
      ? location.folderSegments.join(" › ")
      : location.scope === "workspace"
        ? "Workspace"
        : !actorUserId || location.ownerId === actorUserId
          ? "My Consoles"
          : "its owner's consoles";
  const wanted = wantedPath ? parseConsoleRepoPath(wantedPath) : null;
  const caseOnly =
    wanted !== null &&
    wanted.name !== location.name &&
    wanted.name.toLowerCase() === location.name.toLowerCase();
  return caseOnly
    ? `A console named '${location.name}' already exists in ${where} — names that differ only in upper/lower case count as the same.`
    : `A console named '${location.name}' already exists in ${where}.`;
}

/**
 * `consoles/a/b/name.sql` → location, `users/<id>/consoles/name.js` →
 * private location, anything else (README, sidecars, foreign extensions,
 * files under other roots) → null.
 */
export function parseConsoleRepoPath(path: string): ConsoleRepoLocation | null {
  const segments = path.split("/");
  let scope: "workspace" | "private";
  let ownerId: string | undefined;
  let rest: string[];
  if (segments[0] === CONSOLES_DIR) {
    scope = "workspace";
    rest = segments.slice(1);
  } else if (
    segments[0] === USERS_DIR &&
    segments.length >= 4 &&
    segments[2] === CONSOLES_DIR &&
    /^[A-Za-z0-9_-]+$/.test(segments[1] ?? "")
  ) {
    scope = "private";
    ownerId = segments[1];
    rest = segments.slice(3);
  } else {
    return null;
  }
  if (rest.length === 0) return null;
  const fileName = rest[rest.length - 1];
  if (isChartSidecarPath(fileName)) return null;
  const split = splitConsoleFileName(fileName);
  if (!split) return null;
  const folderSegments = rest.slice(0, -1);
  if (folderSegments.some(s => s === "" || s === "." || s === "..")) {
    return null;
  }
  return { scope, ownerId, folderSegments, ...split };
}

// ---------------------------------------------------------------------------
// Front-matter
// ---------------------------------------------------------------------------

const KEY_CONNECTION = "connection";
const KEY_DATABASE = "database";
const KEY_DATABASE_ID = "database_id";
const KEY_DESCRIPTION = "description";
const KEY_SCHEDULE = "schedule";
const KEY_TIMEZONE = "timezone";
const KEY_RESULTS_VIEW = "results_view";
const KEY_COLLECTION = "collection";
const KEY_OPERATION = "operation";

const KNOWN_KEYS = new Set([
  KEY_CONNECTION,
  KEY_DATABASE,
  KEY_DATABASE_ID,
  KEY_DESCRIPTION,
  KEY_SCHEDULE,
  KEY_TIMEZONE,
  KEY_RESULTS_VIEW,
  KEY_COLLECTION,
  KEY_OPERATION,
]);

function commentPrefix(language: ConsoleLanguage): string {
  return language === "sql" ? "--" : "//";
}

/** One line of front-matter; values are single-line by construction. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Serialize the authored state into file contents. The front-matter block is
 * omitted entirely when there is nothing to say, so a bare query round-trips
 * as a bare query.
 */
export function serializeConsoleFile(state: ConsoleFileState): string {
  const prefix = commentPrefix(state.language);
  const lines: string[] = [];
  const put = (key: string, value: string | undefined) => {
    const v = value === undefined ? "" : oneLine(value);
    if (v) lines.push(`${prefix} ${key}: ${v}`);
  };
  put(KEY_CONNECTION, state.connectionId);
  put(KEY_DATABASE, state.databaseName);
  // databaseId is a legacy alias of the connection; keep it only when it
  // says something the connection id does not.
  if (state.databaseId && state.databaseId !== state.connectionId) {
    put(KEY_DATABASE_ID, state.databaseId);
  }
  put(KEY_DESCRIPTION, state.description);
  if (state.schedule?.cron) {
    put(KEY_SCHEDULE, state.schedule.cron);
    put(KEY_TIMEZONE, state.schedule.timezone);
  }
  if (state.resultsViewMode && state.resultsViewMode !== "table") {
    put(KEY_RESULTS_VIEW, state.resultsViewMode);
  }
  if (state.language === "mongodb" && state.mongoOptions) {
    put(KEY_COLLECTION, state.mongoOptions.collection);
    put(KEY_OPERATION, state.mongoOptions.operation);
  }
  const body = state.code.replace(/\r\n/g, "\n");
  const trimmedBody = body.endsWith("\n") ? body : `${body}\n`;
  if (lines.length === 0) return trimmedBody;
  return `${lines.join("\n")}\n\n${trimmedBody}`;
}

export interface ParsedConsoleFile {
  code: string;
  meta: Omit<ConsoleFileState, "name" | "language" | "code" | "chartSpec">;
}

/**
 * Parse file contents back into code + metadata. Only a leading block of
 * known keys is treated as front-matter (and stripped, together with the one
 * blank line that closes it); a query that merely starts with a comment is
 * left alone.
 */
export function parseConsoleFile(
  contents: string,
  language: ConsoleLanguage,
): ParsedConsoleFile {
  const text = contents.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const re = /^(?:--|\/\/)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/;
  const raw: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = re.exec(lines[i].trim());
    if (!m || !KNOWN_KEYS.has(m[1].toLowerCase())) break;
    raw[m[1].toLowerCase()] = m[2];
  }
  const hasFrontMatter = i > 0;
  let bodyStart = 0;
  if (hasFrontMatter) {
    bodyStart = i;
    if (lines[bodyStart] !== undefined && lines[bodyStart].trim() === "") {
      bodyStart += 1;
    }
  }
  let code = lines.slice(bodyStart).join("\n");
  if (code.endsWith("\n")) code = code.slice(0, -1);

  const meta: ParsedConsoleFile["meta"] = {};
  if (raw[KEY_CONNECTION]) meta.connectionId = raw[KEY_CONNECTION];
  if (raw[KEY_DATABASE]) meta.databaseName = raw[KEY_DATABASE];
  if (raw[KEY_DATABASE_ID]) meta.databaseId = raw[KEY_DATABASE_ID];
  else if (raw[KEY_CONNECTION]) meta.databaseId = raw[KEY_CONNECTION];
  if (raw[KEY_DESCRIPTION]) meta.description = raw[KEY_DESCRIPTION];
  if (raw[KEY_SCHEDULE]) {
    meta.schedule = {
      cron: raw[KEY_SCHEDULE],
      timezone: raw[KEY_TIMEZONE] || "UTC",
    };
  }
  const view = raw[KEY_RESULTS_VIEW];
  if (view === "table" || view === "json" || view === "chart") {
    meta.resultsViewMode = view;
  }
  if (language === "mongodb" && raw[KEY_COLLECTION]) {
    meta.mongoOptions = {
      collection: raw[KEY_COLLECTION],
      operation: raw[KEY_OPERATION] || "find",
    };
  }
  return { code, meta };
}

/** Sidecar contents: stable key order so an unchanged chart is an unchanged blob. */
export function serializeChartSpec(spec: Record<string, unknown>): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

export function parseChartSpec(
  contents: string,
): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(contents) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
