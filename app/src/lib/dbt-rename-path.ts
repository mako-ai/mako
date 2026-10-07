/**
 * The dbt Rename dialog edits a file's FULL project path
 * (`models/marts/orders.sql`), not a name relative to its folder: typing
 * `models/staging/orders.sql` into a folder-relative box used to create
 * `models/marts/models/staging/orders.sql`. This turns what was typed into
 * the path to send — or a plain reason it cannot be one — before anything
 * is submitted. The server validates again; this is what lets the dialog
 * say what is wrong while the person is still typing.
 *
 * Accepted and normalized: a leading `/`, a leading `dbt/` (the repo
 * path), `./` and `..` that stay inside the project, doubled slashes and
 * surrounding spaces. Never a path outside the project.
 */

export type DbtRenameTarget =
  | { ok: true; path: string; unchanged: boolean }
  | { ok: false; error: string };

/** Characters Windows does not allow in a file name. */
const WINDOWS_INVALID = /[<>:"|?*]/;
/** Windows device names, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function resolveDbtRenameTarget(
  typed: string,
  fromPath: string,
  /** Every file path in the project (project-relative). */
  existing: readonly string[],
): DbtRenameTarget {
  const raw = typed.trim();
  if (!raw) return { ok: false, error: "Give the file a path." };
  if (raw.includes("\\")) {
    return { ok: false, error: "Use / to separate folders, not \\." };
  }
  if ([...raw].some(ch => ch.charCodeAt(0) < 0x20 || ch === "\u007f")) {
    return {
      ok: false,
      error: "The path can't contain line breaks or other control characters.",
    };
  }
  if (raw.endsWith("/")) {
    return { ok: false, error: "End the path with a file name, not a folder." };
  }
  let rest = raw.replace(/^\/+/, "");
  if (rest.startsWith("dbt/")) rest = rest.slice("dbt/".length);
  const parts: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) {
        return {
          ok: false,
          error: "The path must stay inside the dbt project.",
        };
      }
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  if (parts.length === 0) return { ok: false, error: "Give the file a path." };
  for (const seg of parts) {
    if (seg !== seg.trim() || seg.endsWith(".")) {
      return {
        ok: false,
        error: `"${seg}" starts or ends with a space, or ends with a dot — Windows would change that name.`,
      };
    }
    if (WINDOWS_INVALID.test(seg)) {
      return {
        ok: false,
        error: `"${seg}" contains a character that is not allowed in a file name (< > : " | ? *).`,
      };
    }
    if (RESERVED.test(seg)) {
      return { ok: false, error: `"${seg}" is a reserved name on Windows.` };
    }
    if (seg === ".git") {
      return { ok: false, error: "The path can't go inside .git." };
    }
  }
  const path = parts.join("/");
  if (path === fromPath) return { ok: true, path, unchanged: true };

  const fold = (p: string) => p.normalize("NFC").toLowerCase();
  const others = existing.filter(p => p !== fromPath);
  if (others.includes(path)) {
    return { ok: false, error: "A file already exists there." };
  }
  if (others.some(p => p.startsWith(`${path}/`))) {
    return { ok: false, error: "A folder already exists there." };
  }
  for (let i = 1; i < parts.length; i++) {
    const folder = parts.slice(0, i).join("/");
    if (others.includes(folder)) {
      return { ok: false, error: `${folder} is a file, not a folder.` };
    }
  }
  // Same letters in another case (or another Unicode form): one file on a
  // Mac or Windows checkout. The file's own case change is fine.
  const twin = others.find(p => fold(p) === fold(path));
  if (twin) {
    return {
      ok: false,
      error: `${twin} already exists — a name that differs only in upper/lower case can't be told apart on macOS or Windows.`,
    };
  }
  return { ok: true, path, unchanged: false };
}

/**
 * A rename warning from the server is one plain sentence, optionally
 * followed by lines of precise detail (the config key, the file list).
 */
export function splitRenameWarning(warning: string): {
  message: string;
  detail?: string;
} {
  const [message, ...rest] = warning.split("\n");
  const detail = rest.join("\n").trim();
  return detail ? { message, detail } : { message };
}
