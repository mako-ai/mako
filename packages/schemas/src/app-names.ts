/**
 * What an app may be called — its LINK (the folder name `/apps/<link>` is
 * made of) and its NAME (the title in mako.json) — in ONE place, imported
 * by the API (api/src/apps/app-paths.ts: every rename, move, create) and by
 * the client (the rename and folder dialogs), so the dialog refuses as the
 * user types exactly what the server would refuse, in the same words.
 *
 * Messages are written for the person in the dialog: what is wrong and
 * what to do, never how Mako stores it.
 */

/**
 * Unicode letters and digits (`café` is a folder people have), then those,
 * spaces, dots, dashes and underscores. No slash, no leading dot.
 */
const SEGMENT_RE = /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u;

/** The longest folder name (link) accepted. */
export const MAX_APP_SEGMENT_LENGTH = 100;

/** The longest app name (title) accepted. */
export const MAX_APP_TITLE_LENGTH = 1000;

/**
 * A name as it will be stored: trimmed, and in NFC — `é` typed as `e` +
 * U+0301 (macOS input, some keyboards) is the same name as `é`, and git
 * must never hold two spellings a checkout cannot tell apart.
 */
export function normalizeAppName(name: string): string {
  return name.trim().normalize("NFC");
}

/** A folder name git and every URL are happy with (what discovery lists). */
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
// git for Windows refuses to check out a path with one, so a single such
// folder makes the WHOLE workspace repo unusable there.
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Is `segment` a Windows reserved device name (see above)? */
export function isWindowsDeviceName(segment: string): boolean {
  return WINDOWS_DEVICE_RE.test(segment);
}

/** 24 hex characters: what every resolver reads as an app id first. */
export function looksLikeAppId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value);
}

/**
 * The literal first segments the apps API serves under
 * `/api/workspaces/:ws/apps/` (`GET /apps/status-probe`, `DELETE
 * /apps/folders`, …). Every route there also takes an app ref, so an app
 * named like one could not be reached by its link on those routes. Kept
 * equal to the router by app-rename-routes.scenarios.test.ts, which
 * derives the list from it.
 */
export const RESERVED_APP_SLUGS: readonly string[] = [
  "folders",
  "github-installations",
  "github-repos",
  "github-status",
  "github-sync-url",
  "link",
  "status-probe",
  "unlink",
];

/** What is being named: an app's link, or a folder of apps. */
export type AppNameKind = "link" | "folder";

/**
 * Why `name` (already normalizeAppName'd) cannot be a NEW app link or
 * folder name, or null when it can. Stricter than isSafeAppSegment, which
 * is what discovery accepts — an existing folder pushed from a laptop keeps
 * working; only a name someone is choosing now is held to this.
 */
export function appNameProblem(
  name: string,
  kind: AppNameKind = "link",
): string | null {
  const what = kind === "link" ? "link" : "folder name";
  if (!name)
    return kind === "link" ? "Give the app a link." : "Give the folder a name.";
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
    return `Not allowed on Windows: ${name} — pick another ${what}.`;
  }
  if (looksLikeAppId(name)) {
    return `This looks like an app id, so it can't be a ${what} — pick another.`;
  }
  if (kind === "link" && RESERVED_APP_SLUGS.includes(name.toLowerCase())) {
    return "This link is reserved by Mako — pick another.";
  }
  return null;
}

/**
 * Why `title` (already normalizeAppName'd) cannot be an app's name, or null
 * when it can. Display text, so almost anything goes — not control
 * characters or line breaks (a name is one line, and a NUL cannot even be
 * committed), not a name that is empty once invisible characters are set
 * aside, and not an essay.
 */
export function appTitleProblem(title: string): string | null {
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)) {
    return "A name can't contain line breaks, tabs or other control characters.";
  }
  if (!title.replace(/[\s\p{Cf}]/gu, "")) return "An app needs a name.";
  if (title.length > MAX_APP_TITLE_LENGTH) {
    return `Keep the name to ${MAX_APP_TITLE_LENGTH} characters or fewer.`;
  }
  return null;
}
