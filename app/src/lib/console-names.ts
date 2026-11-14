/**
 * The app's entry point to the server's console and folder name rules, so
 * a dialog can say what a name will be SAVED AS — "Q1: revenue" is stored
 * as "Q1 - revenue", a file name cannot carry a colon — or refuse it as it
 * is typed, in the server's own words. The server keeps deciding; this
 * only shows its answer early.
 *
 * Not a copy: the rules are `@mako/schemas` (console-names.ts), the module
 * the API runs (api/src/apps/console-files.ts).
 */
import {
  previewConsoleName,
  type ConsoleNameKind,
  type ConsoleNamePreview,
} from "@mako/schemas";

export type { ConsoleNameKind, ConsoleNamePreview };

/** What typing `raw` would save, and why it cannot be saved when it can't. */
export const consoleNamePreview = previewConsoleName;

/**
 * The Save dialog's name field also takes a path — `Team/Q1/report` files
 * the console in those folders — so there each segment is a name of its
 * own: the folders', then the console's.
 */
export function consolePathPreview(raw: string): ConsoleNamePreview {
  const segments = raw.split("/");
  const previews = segments.map((segment, i) =>
    previewConsoleName(
      segment,
      i === segments.length - 1 ? "console" : "folder",
    ),
  );
  return {
    name: previews.map(p => p.name).join("/"),
    changed: previews.some(p => p.changed),
    error: previews.find(p => p.error)?.error ?? null,
  };
}

/**
 * A saved path in words: “B test” in the folder “A”. In the Save dialog a
 * slash is path syntax — `A/B test` files the console "B test" in a folder
 * "A", created if it is not there — and that is said, never done silently.
 * With a folder picked in the dialog's tree, that folder is where it goes
 * and the typed folders are not used; that is said too.
 */
export function savedPathWords(path: string, inSelectedFolder = false): string {
  const segments = path.split("/");
  const name = segments.pop() ?? "";
  if (segments.length === 0) return `“${name}”`;
  const typed = segments.join("/");
  return inSelectedFolder
    ? `“${name}” in the selected folder (“${typed}/” is not used)`
    : `“${name}” in the folder “${typed}”`;
}

/**
 * The line under a name field: the reason it is refused, or the name it
 * will be saved under when that is not what was typed. Null when the name
 * is saved as typed (or nothing was typed yet). `"path"` is the Save
 * dialog's field (`consolePathPreview`): a slash there names a folder, and
 * the line says which.
 */
export function nameFieldHint(
  raw: string,
  kind: ConsoleNameKind | "path",
  options: { inSelectedFolder?: boolean } = {},
): { text: string; error: boolean } | null {
  if (!raw.trim()) return null;
  const preview =
    kind === "path" ? consolePathPreview(raw) : previewConsoleName(raw, kind);
  if (preview.error) return { text: preview.error, error: true };
  if (kind === "path" && preview.name.includes("/")) {
    return {
      text: `Will be saved as ${savedPathWords(preview.name, options.inSelectedFolder)}`,
      error: false,
    };
  }
  if (preview.changed) {
    return { text: `Will be saved as “${preview.name}”`, error: false };
  }
  return null;
}

/** After the fact, where no dialog could say it first (an inline rename). */
export function savedAsNotice(typed: string, saved: string): string | null {
  return saved === typed.trim() ? null : `Saved as “${saved}”`;
}
