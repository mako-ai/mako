/**
 * What a workspace object may be called — the rules a rename applies, in
 * one dependency-free module so the API (api/src/rename/title-rules.ts) and
 * the app (app/src/lib/object-name-rules.ts) run the same code and answer
 * with the same words. Neither holds a copy.
 *
 * A DISPLAY NAME is shown in lists, tabs, commit messages and
 * notifications, and it is written into a file a person reads in a
 * checkout. So it is one line of visible text:
 *
 *  - NFC-normalised: "é" typed as U+00E9 and as "e" + U+0301 is one name,
 *    not two that look identical (and renaming one to the other is a no-op,
 *    not an invisible commit);
 *  - trimmed, and not blank once invisible characters (zero-width spaces and
 *    joiners, the BOM, the soft hyphen) are discounted;
 *  - no control characters (NUL crashes the git commit carrying the name;
 *    a newline cannot be written as a one-line `name:`), and no line or
 *    paragraph separators;
 *  - no text-direction overrides, embeddings or isolates (U+202A–U+202E,
 *    U+2066–U+2069): they make one name render as another. Right-to-left
 *    TEXT is fine, and so is a zero-width joiner inside an emoji sequence.
 *
 * A FILE-NAME SLUG (a flow's `flows/<slug>.yml`, a dbt job's
 * `dbt/jobs/<slug>.yml`) is what creation would have minted: lowercase
 * letters, digits and single dashes, up to 64 characters — and never a
 * Windows device name or something that reads as an object id.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD\u180E\s]/gu;

/** NFC, trimmed — the form a name is compared and stored in. */
export function normalizeDisplayName(raw: string): string {
  return raw.normalize("NFC").trim();
}

/**
 * Why a (normalised) name's CHARACTERS may not be written, or null when
 * they may (`displayNameError` adds the length rule).
 */
export function displayNameProblem(name: string): string | null {
  if (!name || !name.replace(INVISIBLE, "")) {
    return "The name cannot be empty.";
  }
  if (CONTROL.test(name)) {
    return "The name cannot contain line breaks, tabs or other control characters.";
  }
  if (BIDI_CONTROL.test(name)) {
    return "The name cannot contain text-direction control characters (they make one name look like another).";
  }
  return null;
}

/** The message for a name past `maxLength`. */
export function displayNameTooLong(maxLength: number): string {
  return `The name is longer than ${maxLength} characters.`;
}

/**
 * Every rule at once — characters and length — for a (normalised) name:
 * the problem, or null. Nothing is ever cut short: a name too long is
 * refused.
 */
export function displayNameError(
  name: string,
  maxLength: number,
): string | null {
  return (
    displayNameProblem(name) ??
    (name.length > maxLength ? displayNameTooLong(maxLength) : null)
  );
}

/** The kinds whose file name is a slug a rename may change. */
export type SlugNamedKind = "flow" | "dbt_job";

export const RENAME_SLUG_MAX_LENGTH = 64;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Whether `slug` is one creation could have minted from a name: the same
 * characters, no leading, doubled or trailing dashes, within the cap.
 */
export function isRenameSlug(slug: string): boolean {
  return SLUG.test(slug) && slug.length <= RENAME_SLUG_MAX_LENGTH;
}

/**
 * Device names Windows reserves in every directory, with any extension:
 * `flows/con.yml` cannot be created by a Windows checkout at all (git
 * refuses or the clone breaks), so a file name a workspace repo hands out
 * must never be one.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export function isWindowsReservedName(slug: string): boolean {
  return WINDOWS_RESERVED.test(slug);
}

/**
 * A name that is also a valid object id (24 hex digits). Lookups take an id
 * before a name, so such a name can point at ANOTHER object than the one it
 * belongs to — never hand one out.
 */
export function looksLikeObjectId(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value);
}

/**
 * Why a slug that passes a kind's character rules is still not a name a
 * file may be given, or null when it may be.
 */
export function unsafeSlugReason(slug: string): string | null {
  if (isWindowsReservedName(slug)) {
    return `"${slug}" is a device name Windows reserves (a checkout could not create that file); choose another name.`;
  }
  if (looksLikeObjectId(slug)) {
    return `"${slug}" looks like an object id, and ids resolve before names; choose another name.`;
  }
  return null;
}

/** Where each kind's file lives — for the slug message. */
const FILE_DIR: Record<SlugNamedKind, string> = {
  flow: "flows/",
  dbt_job: "dbt/jobs/",
};

/**
 * Why `slug` (trimmed) cannot be a flow's or a dbt job's new file name, or
 * null when it can. Whether the name is free is the server's question, not
 * this one.
 */
export function renameSlugError(
  kind: SlugNamedKind,
  slug: string,
): string | null {
  if (!isRenameSlug(slug)) {
    return `"${slug}" is not a valid file name: lowercase letters, digits and single dashes, up to ${RENAME_SLUG_MAX_LENGTH} characters (it becomes ${FILE_DIR[kind]}${slug}.yml).`;
  }
  return unsafeSlugReason(slug);
}

export const CONNECTOR_SLUG_MAX_LENGTH = 64;

const CONNECTOR_SLUG = /^[a-z][a-z0-9-]*$/;

/**
 * Whether `slug` can name a workspace connector's folder
 * (`connectors/<slug>/`): lowercase letters, digits and dashes, starting
 * with a letter, up to 64 characters. The rule the index applies to a
 * pushed folder, so a rename hands out no name a push could not.
 */
export function isConnectorSlug(slug: string): boolean {
  return CONNECTOR_SLUG.test(slug) && slug.length <= CONNECTOR_SLUG_MAX_LENGTH;
}

/**
 * Why `slug` (trimmed) cannot be a workspace connector's new folder name,
 * or null when it can. Whether the name is free is the server's question.
 */
export function connectorSlugError(slug: string): string | null {
  // A name that reads as an object id is refused in the words every kind
  // uses for it, also when it could not be a connector slug anyway (an id
  // usually starts with a digit).
  if (looksLikeObjectId(slug)) return unsafeSlugReason(slug);
  if (!isConnectorSlug(slug)) {
    return `"${slug}" is not a valid connector slug: lowercase letters, digits and dashes, starting with a letter, up to ${CONNECTOR_SLUG_MAX_LENGTH} characters (it becomes connectors/${slug}/).`;
  }
  return unsafeSlugReason(slug);
}
