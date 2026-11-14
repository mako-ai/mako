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
 * What to say BEFORE a rename that takes a model or a seed to a path that
 * names no dbt node (`models/report`, with no `.sql`): the file stops being
 * that node, and nothing that names it is rewritten. Allowed, so it is a
 * warning and not a refusal; the server says the same after the rename.
 * `referencedBy`: files known here to refer to it (see `filesReferringTo`).
 * Null when there is nothing to warn of.
 */
export function leavesNodeWarning(
  fromPath: string,
  toPath: string,
  referencedBy: readonly string[] = [],
): string | null {
  const node = refNameForDbtPath(fromPath);
  if (!node || refNameForDbtPath(toPath) !== null) return null;
  const kind = fromPath.startsWith("seeds/") ? "seed" : "model";
  const known =
    referencedBy.length === 0
      ? ""
      : ` Among the files open here, ${referencedBy.join(", ")} ${referencedBy.length === 1 ? "refers" : "refer"} to it.`;
  return `${toPath} is not a ${kind} path, so the file stops being the ${kind} '${node}'. ref('${node}') calls, job selectors and its schema entry are left as they are and will not resolve.${known}`;
}

/**
 * The files, of those loaded in this window, that `ref()` the node a file
 * names. Only what is open here is known: an empty answer is not "nothing
 * refers to it".
 */
export function filesReferringTo(
  fromPath: string,
  files: Readonly<Record<string, { content: string; loaded?: boolean }>>,
): string[] {
  const node = refNameForDbtPath(fromPath);
  if (!node) return [];
  const refers = new RegExp(
    `\\bref\\(\\s*(?:['"][^'"]*['"]\\s*,\\s*)?['"]${node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`,
  );
  return Object.entries(files)
    .filter(([path, file]) => path !== fromPath && file.loaded !== false)
    .filter(([, file]) => refers.test(file.content))
    .map(([path]) => path)
    .sort();
}

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
