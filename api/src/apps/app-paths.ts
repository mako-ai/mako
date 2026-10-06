/**
 * Where an app lives in the workspace repo, and what its manifest says.
 *
 * An app is a folder holding a `mako.json` (apps.md §13.6). The folder may sit
 * at any depth under `apps/` (the workspace tree) or `users/<id>/apps/` (that
 * person's tree) — real directories are the folders, exactly as consoles do
 * it. Nothing in this module touches git or Mongo: it is the grammar the
 * index, the routes and the agent tools all parse paths with, so it stays
 * pure and unit-tested.
 *
 * Identity is NOT the path. It is `id` in the manifest, so an app keeps its
 * deployments, sharing and favourites when an editor files it somewhere else.
 * A manifest without an id falls back to an id derived from the path — which
 * is what every app had before ids existed, so nothing moves for them.
 */
import { createHash } from "node:crypto";
import { Types } from "mongoose";

export const APPS_DIR = "apps";
export const USERS_DIR = "users";
export const APP_MANIFEST = "mako.json";
/** A committed marker that keeps an otherwise empty folder in git. */
export const FOLDER_KEEP_FILE = ".gitkeep";

export type AppScope = "workspace" | "private";

export interface AppRepoLocation {
  scope: AppScope;
  /** The user whose tree this is, for `private`. */
  ownerId?: string;
  /** Folders between the tree root and the app, top-down. */
  folderSegments: string[];
  /** The app's own folder name — its URL handle. */
  slug: string;
}

// Unicode letters and digits: `apps/café` is a folder people already have,
// and dropping it from discovery left it published but unlisted. Slashes,
// control characters and leading dots stay out.
const SEGMENT_RE = /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u;
const USER_ID_RE = /^[A-Za-z0-9_-]+$/;

/** A folder or app name git and every URL are happy with. */
export function isSafeSegment(segment: string): boolean {
  return (
    SEGMENT_RE.test(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.endsWith(".") &&
    !segment.endsWith(" ") &&
    segment.length <= 100
  );
}

/** Root folder of a tree: `apps` or `users/<id>/apps`. */
export function appTreeRoot(scope: AppScope, ownerId?: string): string {
  if (scope === "workspace") return APPS_DIR;
  if (!ownerId || !USER_ID_RE.test(ownerId)) {
    throw new Error("A private app tree needs its owner");
  }
  return `${USERS_DIR}/${ownerId}/${APPS_DIR}`;
}

/**
 * Parse a repo-relative app folder path. `null` when the path is not an app
 * location at all — a file elsewhere in the repo, or a path with a segment
 * git or a URL would choke on.
 */
export function parseAppRepoPath(path: string): AppRepoLocation | null {
  const segments = path.split("/");
  let scope: AppScope;
  let ownerId: string | undefined;
  let rest: string[];
  if (segments[0] === APPS_DIR) {
    scope = "workspace";
    rest = segments.slice(1);
  } else if (
    segments[0] === USERS_DIR &&
    segments.length >= 4 &&
    segments[2] === APPS_DIR &&
    USER_ID_RE.test(segments[1] ?? "")
  ) {
    scope = "private";
    ownerId = segments[1];
    rest = segments.slice(3);
  } else {
    return null;
  }
  if (rest.length === 0 || rest.some(s => !isSafeSegment(s))) return null;
  const slug = rest[rest.length - 1];
  return { scope, ownerId, folderSegments: rest.slice(0, -1), slug };
}

/** Inverse of {@link parseAppRepoPath}. */
export function appRepoPath(location: AppRepoLocation): string {
  for (const seg of [...location.folderSegments, location.slug]) {
    if (!isSafeSegment(seg)) {
      throw new Error(`Invalid folder name: ${JSON.stringify(seg)}`);
    }
  }
  return [
    appTreeRoot(location.scope, location.ownerId),
    ...location.folderSegments,
    location.slug,
  ].join("/");
}

/**
 * Parse a folder path (a directory that holds apps, not an app itself):
 * the tree root alone, or any folder chain beneath it.
 */
export function parseAppFolderPath(
  path: string,
): { scope: AppScope; ownerId?: string; folderSegments: string[] } | null {
  if (path === APPS_DIR) {
    return { scope: "workspace", folderSegments: [] };
  }
  const root = path.match(/^users\/([A-Za-z0-9_-]+)\/apps$/);
  if (root) return { scope: "private", ownerId: root[1], folderSegments: [] };
  const loc = parseAppRepoPath(path);
  if (!loc) return null;
  return {
    scope: loc.scope,
    ownerId: loc.ownerId,
    folderSegments: [...loc.folderSegments, loc.slug],
  };
}

/**
 * The stable key an app's derived id is built from. Kept equal to the bare
 * slug for `apps/<slug>` so every pre-existing app keeps the id its
 * deployments, binding artifacts and sandbox sessions are already filed under.
 */
export function appKeyOf(path: string): string {
  return path.startsWith(`${APPS_DIR}/`)
    ? path.slice(APPS_DIR.length + 1)
    : path;
}

/**
 * Stable id for an app whose manifest declares none. A function of
 * (workspace, folder) so a folder-only app keys the same artifacts before and
 * after any row or manifest id is written for it.
 */
export function derivedAppId(workspaceId: string, key: string): Types.ObjectId {
  const digest = createHash("sha1")
    .update(`apps:${workspaceId}:${key}`)
    .digest("hex");
  return new Types.ObjectId(digest.slice(0, 24));
}

/** Ids are 24 hex chars so they can be Mongo `_id`s and stay URL-safe. */
export function isAppId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface AppManifest {
  /** Declared identity; absent on apps that predate ids. */
  id?: string;
  title: string;
  description?: string;
  /**
   * Previous slugs (`report`) or repo paths (`apps/Sales/report`) of this
   * app: old links resolve to it when nothing current claims them. Moves
   * append to it automatically. Normalized and deduplicated.
   */
  aliases: string[];
  /** `aliases` entries that were not usable (ignored, never fatal). */
  rejectedAliases: unknown[];
  /** Raw parse, for callers that need the rest (entry, bindings, …). */
  raw: Record<string, unknown>;
}

/**
 * Normalize a manifest's `aliases`: trimmed strings, no slash at either end,
 * no empty, `.` or `..` segment, each once. Anything else is returned in
 * `rejected` so the caller can warn — a bad alias must never hide the app.
 */
export function parseAppAliases(value: unknown): {
  aliases: string[];
  rejected: unknown[];
} {
  if (value === undefined || value === null) {
    return { aliases: [], rejected: [] };
  }
  if (!Array.isArray(value)) return { aliases: [], rejected: [value] };
  const aliases: string[] = [];
  const rejected: unknown[] = [];
  for (const entry of value) {
    const clean =
      typeof entry === "string"
        ? entry.trim().replace(/^\/+/, "").replace(/\/+$/, "")
        : "";
    const ok =
      clean.length > 0 &&
      clean.length <= 500 &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f]/.test(clean) &&
      clean.split("/").every(seg => seg !== "" && seg !== "." && seg !== "..");
    if (!ok) rejected.push(entry);
    else if (!aliases.includes(clean)) aliases.push(clean);
  }
  return { aliases, rejected };
}

/**
 * Tolerant parse: a malformed manifest must not hide the app — the folder is
 * the app, and a broken `mako.json` is something the user needs to SEE to
 * fix. The slug is the fallback title.
 */
export function parseAppManifest(
  contents: string | null | undefined,
  slug: string,
): AppManifest {
  let raw: Record<string, unknown> = {};
  if (contents) {
    try {
      const parsed = JSON.parse(contents) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed: fall through to the defaults.
    }
  }
  const title =
    typeof raw.title === "string" && raw.title.trim() ? raw.title : slug;
  const description =
    typeof raw.description === "string" ? raw.description : undefined;
  const id =
    typeof raw.id === "string" && isAppId(raw.id)
      ? raw.id.toLowerCase()
      : undefined;
  const { aliases, rejected } = parseAppAliases(raw.aliases);
  return { id, title, description, aliases, rejectedAliases: rejected, raw };
}

/**
 * Write `id` into a manifest, first, keeping everything else. A manifest that
 * cannot be parsed is left alone — writing a new one over it would lose
 * whatever the user was in the middle of.
 */
export function stampManifestId(
  contents: string | null | undefined,
  id: string,
): string | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = contents ? (JSON.parse(contents) as unknown) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw.id === id) return contents ?? null;
  const { id: _old, ...rest } = raw;
  void _old;
  return `${JSON.stringify({ id, ...rest }, null, 2)}\n`;
}

/**
 * Add `add` to a manifest's `aliases` (after the ones it has, each once) and
 * drop any equal to `drop` (the app's own current slug and path — an alias
 * naming the app's present location is noise). Unusable entries already in
 * the list are dropped too: the index ignores them anyway. Returns the
 * contents unchanged when nothing changes, and `null` when the manifest
 * cannot be parsed — writing a new one over it would lose the user's work.
 */
export function addManifestAliases(
  contents: string | null | undefined,
  add: readonly string[],
  drop: readonly string[] = [],
): string | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = contents ? (JSON.parse(contents) as unknown) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const current = parseAppAliases(raw.aliases);
  const next = parseAppAliases([...current.aliases, ...add]).aliases.filter(
    a => !drop.includes(a),
  );
  const unchanged =
    current.rejected.length === 0 &&
    next.length === current.aliases.length &&
    next.every((a, i) => a === current.aliases[i]);
  if (unchanged) return contents ?? null;
  if (next.length === 0) {
    const { aliases: _gone, ...rest } = raw;
    void _gone;
    return `${JSON.stringify(rest, null, 2)}\n`;
  }
  // An existing key keeps its place; a new one goes last.
  return `${JSON.stringify({ ...raw, aliases: next }, null, 2)}\n`;
}

/**
 * Remove a manifest's `aliases` altogether: a COPY of an app that gets an
 * id of its own must not keep claiming the original's old names (a name two
 * apps claim resolves to neither). `null` when the manifest cannot be
 * parsed; the contents unchanged when there is nothing to remove.
 */
export function stripManifestAliases(
  contents: string | null | undefined,
): string | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = contents ? (JSON.parse(contents) as unknown) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!("aliases" in raw)) return contents ?? null;
  const { aliases: _gone, ...rest } = raw;
  void _gone;
  return `${JSON.stringify(rest, null, 2)}\n`;
}

/**
 * Write `title` into a manifest, keeping everything else where it is. Same
 * contract as {@link stampManifestId}: unchanged contents when the title
 * already reads so, `null` when the manifest cannot be parsed — a rename
 * must never overwrite a file it could not read.
 */
export function setManifestTitle(
  contents: string | null | undefined,
  title: string,
): string | null {
  let raw: Record<string, unknown>;
  try {
    const parsed = contents ? (JSON.parse(contents) as unknown) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw.title === title) return contents ?? null;
  // A manifest that never had a title gets it right after the id, where the
  // scaffold puts it; one that had it keeps its place.
  if ("title" in raw) {
    return `${JSON.stringify({ ...raw, title }, null, 2)}\n`;
  }
  const { id, ...rest } = raw;
  return `${JSON.stringify(id === undefined ? { title, ...rest } : { id, title, ...rest }, null, 2)}\n`;
}
