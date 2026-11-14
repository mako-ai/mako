/**
 * Where a file in the dbt project may be renamed or moved to: the rules the
 * rename service applies (api/src/rename/dbt-file.ts) and the Rename dialog
 * applies as the path is typed (app/src/lib/dbt-rename-path.ts). One module,
 * so both refuse the same paths with the same words.
 *
 * A path is PROJECT-RELATIVE (`models/marts/orders.sql`). What is typed may
 * also start with `/` or with the repo's `dbt/` folder, and may hold `.`,
 * `..` and doubled slashes: those are resolved, and a `..` that would leave
 * the project is refused, never followed.
 */

export type DbtPathResult =
  { ok: true; path: string } | { ok: false; error: string };

const refuse = (error: string): DbtPathResult => ({ ok: false, error });

/** The project-relative path that was typed, or why it cannot be one. */
export function resolveDbtProjectPath(typed: string): DbtPathResult {
  const raw = typed.trim();
  if (!raw) return refuse("Give the file a path.");
  if (raw.includes("\\")) return refuse("Use / to separate folders, not \\.");
  if ([...raw].some(ch => ch.charCodeAt(0) < 0x20 || ch === "\u007f")) {
    return refuse(
      "The path can't contain line breaks or other control characters.",
    );
  }
  if (raw.endsWith("/")) {
    return refuse("End the path with a file name, not a folder.");
  }
  let rest = raw.replace(/^\/+/, "");
  if (rest.startsWith("dbt/")) rest = rest.slice("dbt/".length);
  const parts: string[] = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) {
        return refuse("The path must stay inside the dbt project.");
      }
      parts.pop();
      continue;
    }
    if (segment === ".git") return refuse("The path can't go inside .git.");
    parts.push(segment);
  }
  if (parts.length === 0) return refuse("Give the file a path.");
  const path = parts.join("/");
  if (path.length >= 1024) return refuse("The path is too long.");
  return { ok: true, path };
}

/** Windows device names, with or without an extension (`CON`, `aux.sql`). */
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

/**
 * Why a NEW path would be a file some checkout cannot hold, or one that
 * looks like another, or null. Only a rename's target is checked: a file
 * that already has such a name must stay renamable, which is how it is fixed.
 */
export function dbtNewPathProblem(path: string): string | null {
  for (const segment of path.split("/")) {
    if (new TextEncoder().encode(segment).length > 255) {
      return `"${segment.slice(0, 40)}…" is longer than the 255 bytes a file name may have.`;
    }
    if (/[<>:"|?*]/.test(segment)) {
      return `"${segment}" contains a character that is not allowed in a file name (< > : " | ? *).`;
    }
    if (segment !== segment.trim() || segment.endsWith(".")) {
      return `"${segment}" starts or ends with a space, or ends with a dot. Windows would change that name.`;
    }
    if (RESERVED_SEGMENT.test(segment)) {
      return `"${segment}" is a reserved name on Windows.`;
    }
    if (INVISIBLE.test(segment)) {
      return `"${segment}" contains an invisible or text-direction character, so it would look like another name.`;
    }
  }
  return null;
}

/** The form two paths share when macOS or Windows cannot tell them apart. */
const fold = (path: string) => path.normalize("NFC").toLowerCase();

/**
 * Why `to` cannot be taken while the project holds `existing` (every file
 * path, `from` included), or null. A file, a folder, a file in the way of a
 * folder, or a name that differs from another only in upper/lower case or
 * Unicode form (one file on a macOS or Windows checkout). The file's own
 * case change is fine.
 */
export function dbtPathClash(
  to: string,
  from: string,
  existing: Iterable<string>,
): string | null {
  const files = new Set<string>();
  const folders = new Set<string>();
  const folded = new Map<string, string>();
  for (const path of existing) {
    if (path === from) continue;
    files.add(path);
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (i < parts.length) folders.add(prefix);
      if (!folded.has(fold(prefix))) folded.set(fold(prefix), prefix);
    }
  }
  if (files.has(to)) return "A file already exists there.";
  if (folders.has(to)) return "A folder already exists there.";
  const parts = to.split("/");
  for (let i = parts.length; i >= 1; i--) {
    const prefix = parts.slice(0, i).join("/");
    if (i < parts.length && files.has(prefix)) {
      return `${prefix} is a file, not a folder.`;
    }
    if (files.has(prefix) || folders.has(prefix)) continue;
    const twin = folded.get(fold(prefix));
    if (twin !== undefined) {
      return `${twin} already exists, and a name that differs from it only in upper/lower case (or Unicode form) can't be told apart on macOS or Windows.`;
    }
  }
  return null;
}

/**
 * Files whose NAME is their `ref()`-able node name: SQL and Python models,
 * and seeds. A snapshot is named by its `{% snapshot <name> %}` block, so
 * `snapshots/orders.sql` may hold `orders_snapshot`; analyses, macros and
 * tests cannot be `ref()`-ed at all.
 */
const REF_ABLE = [
  { dir: "models/", ext: ".sql" },
  { dir: "models/", ext: ".py" },
  { dir: "seeds/", ext: ".csv" },
];

/** `models/marts/orders.sql` → `orders`; null for a file that names no node. */
export function refNameForDbtPath(path: string): string | null {
  for (const { dir, ext } of REF_ABLE) {
    if (path.startsWith(dir) && path.endsWith(ext)) {
      return path.slice(path.lastIndexOf("/") + 1, -ext.length) || null;
    }
  }
  return null;
}
