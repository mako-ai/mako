/**
 * What an app may be called — its LINK (the folder name `/apps/<link>` is
 * made of) and the FOLDERS it is filed in — in one dependency-free module,
 * imported by the API (api/src/apps/app-paths.ts) and by the app (the rename
 * and folder dialogs), so a dialog refuses as the person types exactly what
 * the server would refuse, in the same words. An app's NAME (the `title` in
 * mako.json) follows the display-name rules every object shares
 * (object-names.ts).
 *
 * Messages are for the person in the dialog: what is wrong and what to do,
 * never how Mako stores it.
 */
import { looksLikeObjectId } from "./object-names";

/**
 * Unicode letters and digits (`café` is a folder people have), then those,
 * spaces, dots, dashes and underscores. No slash, no leading dot.
 */
const SEGMENT_RE = /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u;

/** The longest link or folder name accepted. */
export const MAX_APP_SEGMENT_LENGTH = 100;

/** The longest app name (title) accepted. */
export const MAX_APP_TITLE_LENGTH = 1000;

/**
 * A link or folder name as it is stored: trimmed, and in NFC — `é` typed as
 * `e` + U+0301 (macOS input) is the same name as `é`, and git must never
 * hold two spellings a checkout cannot tell apart.
 */
export function normalizeAppName(name: string): string {
  return name.trim().normalize("NFC");
}

/**
 * A folder name git and every URL are happy with. This is what DISCOVERY
 * accepts, so a folder pushed from a laptop keeps working; a name someone
 * is choosing now is held to {@link appNameProblem}.
 */
export function isSafeAppSegment(segment: string): boolean {
  return (
    SEGMENT_RE.test(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.endsWith(".") &&
    !segment.endsWith(" ") &&
    segment.length <= MAX_APP_SEGMENT_LENGTH
  );
}

// A Windows device name, alone or with any extension (`con`, `NUL.json`):
// git for Windows cannot check out a path with one, so a single such folder
// makes the WHOLE workspace repo unusable there.
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export function isWindowsDeviceName(segment: string): boolean {
  return WINDOWS_DEVICE_RE.test(segment);
}

/**
 * The literal first path segments the apps API serves next to `/{app}`
 * (`GET /apps/search`, `DELETE /apps/folders`, …). Every route there also
 * takes an app's link, so an app named like one could not be reached by it.
 * Derived from the router by api/src/rename/handlers/app.test.ts, which
 * fails when the two drift.
 */
export const RESERVED_APP_LINKS: readonly string[] = [
  "archived",
  "discovery",
  "feed",
  "folders",
  "github-installations",
  "github-repos",
  "github-status",
  "github-sync-url",
  "lifecycle",
  "link",
  "recent",
  "search",
  "status-probe",
  "unlink",
  "usage",
];

/** What is being named: an app's link, or a folder of apps. */
export type AppNameKind = "link" | "folder";

/**
 * Why `name` (already {@link normalizeAppName}d) cannot be a NEW app link or
 * folder name, or null when it can.
 */
export function appNameProblem(
  name: string,
  kind: AppNameKind = "link",
): string | null {
  const what = kind === "link" ? "link" : "folder name";
  if (!name) {
    return kind === "link" ? "Give the app a link." : "Give the folder a name.";
  }
  if (name.length > MAX_APP_SEGMENT_LENGTH) {
    return `Keep the ${what} to ${MAX_APP_SEGMENT_LENGTH} characters or fewer.`;
  }
  if (name === "." || name === "..") return `"${name}" can't be a ${what}.`;
  if (/[. ]$/.test(name)) return `A ${what} can't end with a dot or a space.`;
  if (!SEGMENT_RE.test(name)) {
    return /^[\p{L}\p{N}]/u.test(name)
      ? `Use only letters, numbers, spaces, dots, dashes and underscores in a ${what}.`
      : `Start the ${what} with a letter or a number.`;
  }
  if (isWindowsDeviceName(name)) {
    return `"${name}" can't be used on Windows, so it can't be a ${what}. Pick another.`;
  }
  if (looksLikeObjectId(name)) {
    return `This looks like an app id, so it can't be a ${what}. Pick another.`;
  }
  if (kind === "link" && RESERVED_APP_LINKS.includes(name.toLowerCase())) {
    return `"${name}" is reserved by Mako. Pick another link.`;
  }
  return null;
}

/**
 * Why `link` cannot replace an app's `current` link beside what else is in
 * its folder, or null when it can. `siblings` are the names of the other
 * apps and folders there — all of them on the server, the ones this person
 * can see in the dialog (the server stays the authority for the rest).
 * `topLevel`: the app sits at the top of the workspace tree, where its
 * folder name IS its `/apps/<link>`.
 *
 * A name that differs only in upper and lower case — from the app's own
 * link or from a sibling — is refused: a checkout on macOS or Windows
 * cannot hold both, nor follow a rename between them.
 */
export function appLinkClash(
  link: string,
  current: string,
  siblings: readonly string[],
  topLevel: boolean,
): string | null {
  if (link === current) return null;
  const lower = link.toLowerCase();
  if (lower === current.toLowerCase()) {
    return `"${link}" differs from the current link only in upper and lower case, which macOS and Windows can't tell apart. Pick a different link.`;
  }
  if (siblings.includes(link)) {
    return topLevel
      ? `The link /apps/${link} is already taken. Pick another.`
      : `"${link}" is already taken in this folder. Pick another link.`;
  }
  const twin = siblings.find(name => name.toLowerCase() === lower);
  return twin
    ? `"${link}" differs from "${twin}" only in upper and lower case, which macOS and Windows can't tell apart. Pick another link.`
    : null;
}

/**
 * Why someone who may edit an app may still not change its LINK (the
 * server's refusal, and the reason the dialog shows beside a locked field).
 */
export const APP_LINK_OWNER_ONLY =
  "Only the owner of this personal folder can change the app's link.";
export const APP_LINK_EDITORS_ONLY =
  "Only workspace editors can change an app's link.";
