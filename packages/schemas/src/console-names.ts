/**
 * What a console or a console folder may be called. The name IS the file
 * (or directory) name in the workspace repo — `consoles/<folder>/<name>.sql`
 * — and that repo is checked out on every OS, so on top of the rules every
 * display name follows (object-names.ts) a console name:
 *
 *  - carries none of `\ / : * ? " < > |`. Those are not refused: titles
 *    like "Q1: revenue" are what people and agents type, so each gets a
 *    visible stand-in ("Q1 - revenue") and the caller says what was saved;
 *  - has single spaces, no leading or trailing dot, is not a device name
 *    Windows reserves, and is at most 120 characters.
 *
 * One module for the API (apps/console-files.ts) and the app's dialogs
 * (app/src/lib/console-names.ts): a name the server would change or refuse
 * is shown changed, or refused, as it is typed.
 */
import { displayNameProblem, normalizeDisplayName } from "./object-names";

/** The longest console or folder name: one segment of its repo path. */
export const MAX_CONSOLE_NAME_LENGTH = 120;

export type ConsoleNameKind = "console" | "folder";

const FORBIDDEN = /[\\/:*?"<>|]/g;

const STAND_INS: Readonly<Record<string, string>> = {
  ":": " - ",
  "/": "-",
  "\\": "-",
  "|": "-",
  "*": "-",
  "?": "",
  '"': "'",
  "<": "(",
  ">": ")",
};

/**
 * A name as typed → as it is stored and filed: NFC, each character a file
 * name cannot carry replaced by its stand-in, runs of spaces (of any
 * width) made one space, the
 * edges trimmed. Says nothing about whether the result is allowed
 * (`consoleNameProblem`).
 */
export function cleanedConsoleName(raw: string): string {
  return normalizeDisplayName(raw)
    .replace(FORBIDDEN, ch => STAND_INS[ch] ?? "-")
    .replace(/\p{Zs}+/gu, " ")
    .trim();
}

/** Device names Windows reserves, with or without an extension. */
const RESERVED_ON_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * Why a cleaned name cannot be a console's or a folder's, or null. Only
 * NEW names are judged: a console a laptop pushed under a name Mako would
 * refuse keeps it until someone renames it.
 */
export function consoleNameProblem(
  name: string,
  kind: ConsoleNameKind,
  language?: string,
): string | null {
  const what = kind === "console" ? "A console" : "A folder";
  const basic = displayNameProblem(name);
  if (basic) return basic;
  if (name.length > MAX_CONSOLE_NAME_LENGTH) {
    return `${what} name can be at most ${MAX_CONSOLE_NAME_LENGTH} characters (this one has ${name.length}).`;
  }
  if (name === "." || name === "..") {
    return `“${name}” is not a name a ${kind} can have.`;
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
  return null;
}

export interface ConsoleNamePreview {
  /** The name as it would be saved. */
  name: string;
  /** Whether that differs from what was typed, beyond its edges. */
  changed: boolean;
  /** Why it cannot be saved at all, or null. */
  error: string | null;
}

/** What typing `raw` would save: for a dialog's "Will be saved as …". */
export function previewConsoleName(
  raw: string,
  kind: ConsoleNameKind,
  language?: string,
): ConsoleNamePreview {
  const name = cleanedConsoleName(raw);
  return {
    name,
    changed: name !== normalizeDisplayName(raw),
    error: consoleNameProblem(name, kind, language),
  };
}

/**
 * A name (or a repo path) as a case-insensitive, Unicode-normalizing file
 * system sees it (macOS, Windows): two with one fold are one file there.
 */
export function foldConsoleName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * `base` + `suffix` (" copy", " (2)") within the length limit: the base is
 * cut — on a code point, never through an emoji — so the suffix always
 * survives. Appended blindly, a name at the limit lost its suffix to the
 * file-name cut and every candidate was the taken name again.
 */
export function suffixedConsoleName(base: string, suffix: string): string {
  const room = Math.max(1, MAX_CONSOLE_NAME_LENGTH - suffix.length);
  let head = base.length > room ? base.slice(0, room) : base;
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  head = head.trimEnd().replace(/\.+$/, "");
  return `${head || "untitled"}${suffix}`;
}
