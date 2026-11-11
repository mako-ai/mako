/**
 * Where an app lives in the workspace repo, and what its manifest says.
 *
 * An app is a folder holding a `mako.json` (apps.md §13.6). The folder may sit
 * at any depth under `apps/` (the workspace tree) or `users/<handle>/apps/`
 * (that person's tree, user-handles.ts) — real directories are the folders,
 * exactly as consoles do it. The parsers return the raw handle; who it names
 * is the workspace's OwnerDirectory's answer, never the folder name's. Nothing in this module touches git or Mongo: it is the grammar the
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
import {
  appNameProblem,
  isSafeAppSegment as isSafeSegment,
  looksLikeObjectId,
} from "@mako/schemas";
import { capAliases } from "../rename/alias-cap";
import { isHandle } from "./user-handles";

export const APPS_DIR = "apps";
/** Workflows live next to apps: `workflows/<name>/workflow.ts`. */
export const WORKFLOWS_DIR = "workflows";
export const USERS_DIR = "users";
export const APP_MANIFEST = "mako.json";
/** A committed marker that keeps an otherwise empty folder in git. */
export const FOLDER_KEEP_FILE = ".gitkeep";

export type AppScope = "workspace" | "private";

export interface AppRepoLocation {
  scope: AppScope;
  /**
   * For `private`: the `users/<handle>` segment, as written. NOT a userId —
   * resolve it with OwnerDirectory.ownerOf before deciding anything by it.
   */
  ownerHandle?: string;
  /** Folders between the tree root and the app, top-down. */
  folderSegments: string[];
  /** The app's own folder name — its URL handle. */
  slug: string;
}

// The naming rules live in @mako/schemas (app-names.ts), shared with the
// app's rename dialog so both refuse the same names in the same words.
// `isSafeSegment` is what DISCOVERY accepts (a folder pushed from a laptop
// keeps working); `appNameProblem` is the stricter rule for a name someone
// is choosing now.
export {
  appNameProblem,
  isSafeAppSegment as isSafeSegment,
  normalizeAppName,
} from "@mako/schemas";

/** Root folder of a tree: `apps` or `users/<handle>/apps`. */
export function appTreeRoot(scope: AppScope, ownerHandle?: string): string {
  if (scope === "workspace") return APPS_DIR;
  if (!ownerHandle || !isHandle(ownerHandle)) {
    throw new Error("A private app tree needs its owner's handle");
  }
  return `${USERS_DIR}/${ownerHandle}/${APPS_DIR}`;
}

/**
 * Parse a repo-relative app folder path. `null` when the path is not an app
 * location at all — a file elsewhere in the repo, or a path with a segment
 * git or a URL would choke on.
 */
export function parseAppRepoPath(path: string): AppRepoLocation | null {
  const segments = path.split("/");
  let scope: AppScope;
  let ownerHandle: string | undefined;
  let rest: string[];
  if (segments[0] === APPS_DIR) {
    scope = "workspace";
    rest = segments.slice(1);
  } else if (
    segments[0] === USERS_DIR &&
    segments.length >= 4 &&
    segments[2] === APPS_DIR &&
    isHandle(segments[1] ?? "")
  ) {
    scope = "private";
    ownerHandle = segments[1];
    rest = segments.slice(3);
  } else {
    return null;
  }
  if (rest.length === 0 || rest.some(s => !isSafeSegment(s))) return null;
  const slug = rest[rest.length - 1];
  return { scope, ownerHandle, folderSegments: rest.slice(0, -1), slug };
}

/** Inverse of {@link parseAppRepoPath}. */
export function appRepoPath(location: AppRepoLocation): string {
  for (const seg of [...location.folderSegments, location.slug]) {
    if (!isSafeSegment(seg)) {
      throw new Error(
        appNameProblem(seg, "folder") ?? `"${seg}" can't be a folder name.`,
      );
    }
  }
  return [
    appTreeRoot(location.scope, location.ownerHandle),
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
): { scope: AppScope; ownerHandle?: string; folderSegments: string[] } | null {
  if (path === APPS_DIR) {
    return { scope: "workspace", folderSegments: [] };
  }
  const root = path.split("/");
  if (
    root.length === 3 &&
    root[0] === USERS_DIR &&
    root[2] === APPS_DIR &&
    isHandle(root[1])
  ) {
    return { scope: "private", ownerHandle: root[1], folderSegments: [] };
  }
  const loc = parseAppRepoPath(path);
  if (!loc) return null;
  return {
    scope: loc.scope,
    ownerHandle: loc.ownerHandle,
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
  return looksLikeObjectId(value);
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
   * Previous links of this app — old slugs (`report`) or repo paths
   * (`apps/Sales/report`) — oldest first: an old link opens the app when
   * nothing current claims it. A rename appends to it.
   */
  aliases: string[];
  /** Raw parse, for callers that need the rest (entry, bindings, …). */
  raw: Record<string, unknown>;
}

/**
 * A manifest's `aliases`, cleaned: trimmed strings in NFC with no slash at
 * either end and no empty, `.` or `..` segment, each once. Anything else is
 * dropped — a bad alias must never hide the app.
 */
export function parseAppAliases(value: unknown): string[] {
  const aliases: string[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== "string") continue;
    const clean = entry
      .trim()
      .normalize("NFC")
      .replace(/^\/+|\/+$/g, "");
    const ok =
      clean.length > 0 &&
      clean.length <= 500 &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f]/.test(clean) &&
      clean.split("/").every(seg => seg !== "" && seg !== "." && seg !== "..");
    if (ok && !aliases.includes(clean)) aliases.push(clean);
  }
  return aliases;
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
  return { id, title, description, aliases: parseAppAliases(raw.aliases), raw };
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

/** The manifest as an object, or null when it cannot be parsed. */
function manifestObject(
  contents: string | null | undefined,
): Record<string, unknown> | null {
  try {
    const parsed = contents ? (JSON.parse(contents) as unknown) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A manifest after a rename: `title` set (when given) and `addAliases`
 * appended to its `aliases`, every other key where it was. `currentNames`
 * (the app's slug and path after the rename) are never listed — an app's
 * current name is not one of its old ones — and only the newest
 * `MAX_ALIASES` are kept. Null when the manifest cannot be parsed: a rename
 * must never write over a file it could not read.
 */
export function renameManifest(
  contents: string | null | undefined,
  change: {
    title?: string;
    addAliases?: readonly string[];
    currentNames?: readonly string[];
  },
): string | null {
  const raw = manifestObject(contents);
  if (!raw) return null;
  const { id, ...rest } = raw;
  // A manifest that never had a title gets it right after the id, where the
  // scaffold puts it; one that had it keeps its place.
  const next: Record<string, unknown> =
    change.title === undefined || "title" in raw
      ? { ...raw }
      : { ...(id === undefined ? {} : { id }), title: change.title, ...rest };
  if (change.title !== undefined) next.title = change.title;
  const aliases = capAliases(
    parseAppAliases([
      ...parseAppAliases(raw.aliases),
      ...(change.addAliases ?? []),
    ]).filter(alias => !(change.currentNames ?? []).includes(alias)),
  );
  if (aliases.length > 0) next.aliases = aliases;
  else delete next.aliases;
  return `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * A manifest without `aliases`: a COPY of an app that is given an id of its
 * own must not keep claiming the original's old links (a link two apps
 * claim opens neither). Unchanged when there are none; null when the
 * manifest cannot be parsed.
 */
export function stripManifestAliases(
  contents: string | null | undefined,
): string | null {
  const raw = manifestObject(contents);
  if (!raw) return null;
  if (!("aliases" in raw)) return contents ?? null;
  const { aliases: _gone, ...rest } = raw;
  void _gone;
  return `${JSON.stringify(rest, null, 2)}\n`;
}
