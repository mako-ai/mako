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
 * The line under a name field: the reason it is refused, or the name it
 * will be saved under when that is not what was typed. Null when the name
 * is saved as typed (or nothing was typed yet). `"path"` is the Save
 * dialog's field (`consolePathPreview`).
 */
export function nameFieldHint(
  raw: string,
  kind: ConsoleNameKind | "path",
): { text: string; error: boolean } | null {
  if (!raw.trim()) return null;
  const preview =
    kind === "path" ? consolePathPreview(raw) : previewConsoleName(raw, kind);
  if (preview.error) return { text: preview.error, error: true };
  if (preview.changed) {
    return { text: `Will be saved as “${preview.name}”`, error: false };
  }
  return null;
}

/** After the fact, where no dialog could say it first (an inline rename). */
export function savedAsNotice(typed: string, saved: string): string | null {
  return saved === typed.trim() ? null : `Saved as “${saved}”`;
}
