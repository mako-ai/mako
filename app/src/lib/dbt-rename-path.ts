/**
 * The dbt Rename dialog edits a file's FULL project path
 * (`models/marts/orders.sql`), so a rename and a move to another folder are
 * the same edit and what is typed is exactly where the file goes. This says,
 * while it is typed, where that is or why it cannot be.
 *
 * Not a copy of the server's rules: they are `@mako/schemas`
 * (dbt-paths.ts), the module the rename service runs
 * (api/src/rename/dbt-file.ts), so the words are the server's. The server
 * checks again against the tree it commits on.
 */
import {
  dbtNewPathProblem,
  dbtPathClash,
  refNameForDbtPath,
  resolveDbtProjectPath,
} from "@mako/schemas";

export type DbtRenameTarget =
  { ok: true; path: string; unchanged: boolean } | { ok: false; error: string };

export function resolveDbtRenameTarget(
  typed: string,
  fromPath: string,
  /** Every file path of the project the app knows of. */
  existing: readonly string[],
): DbtRenameTarget {
  const at = resolveDbtProjectPath(typed);
  if (!at.ok) return at;
  if (at.path === fromPath) return { ok: true, path: at.path, unchanged: true };
  const error =
    dbtNewPathProblem(at.path) ?? dbtPathClash(at.path, fromPath, existing);
  return error
    ? { ok: false, error }
    : { ok: true, path: at.path, unchanged: false };
}

/**
 * The model or seed a file names (`models/x.sql` → `x`), or null: renaming
 * such a file renames a dbt node, so the dialog offers to update references.
 */
export const dbtNodeNameOf = refNameForDbtPath;

/**
 * A rename warning from the server is one plain sentence, optionally
 * followed by lines of exact detail (the config key, a file list).
 */
export function splitRenameWarning(warning: string): {
  message: string;
  detail?: string;
} {
  const [message, ...rest] = warning.split("\n");
  const detail = rest.join("\n").trim();
  return detail ? { message, detail } : { message };
}
