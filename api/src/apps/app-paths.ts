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

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
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
  /** Raw parse, for callers that need the rest (entry, bindings, …). */
  raw: Record<string, unknown>;
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
  return { id, title, description, raw };
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
