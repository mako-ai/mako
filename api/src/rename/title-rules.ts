/**
 * What may be written as a display name — the `title` half of a rename, and
 * every other path that writes the `name:` of a flow or dbt job (the
 * editor's own name field, create, the agent's job tools): one rule
 * everywhere, so a name no rename would accept cannot get in by another
 * door.
 *
 * A name is shown in lists, tabs, commit messages and notifications, and it
 * is written into a file a person reads in a checkout. So it is one line of
 * visible text:
 *
 *  - NFC-normalised: "é" typed as U+00E9 and as "e" + U+0301 is one name,
 *    not two that look identical (and renaming one to the other is a no-op,
 *    not an invisible commit);
 *  - trimmed, and not blank once invisible characters (zero-width spaces and
 *    joiners, the BOM, the soft hyphen) are discounted;
 *  - no control characters (NUL crashed the git commit carrying the name;
 *    a newline cannot be written as a one-line `name:`), and no line or
 *    paragraph separators;
 *  - no text-direction overrides, embeddings or isolates (U+202A–U+202E,
 *    U+2066–U+2069): they make one name render as another. Right-to-left
 *    TEXT is fine, and so is a zero-width joiner inside an emoji sequence.
 *
 * Anything else is a 400 with the reason, never a 409 blaming the file or a
 * 500/502 from git.
 */
import { RenameError } from "./types";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD\u180E\s]/gu;

/** NFC, trimmed — the form a name is compared and stored in. */
export function normalizeDisplayName(raw: string): string {
  return raw.normalize("NFC").trim();
}

/**
 * Why a (normalised) name may not be written, or null when it may. Length
 * is the caller's: some paths refuse a long name, others have always
 * truncated it.
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

/** At most `max` UTF-16 units, never cutting a surrogate pair in half. */
export function truncateDisplayName(name: string, max: number): string {
  if (name.length <= max) return name;
  const cut = name.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** The rename services' rule: normalised, valid, within `maxLength` — or a 400. */
export function cleanRenameTitle(raw: string, maxLength: number): string {
  const title = normalizeDisplayName(raw);
  const problem = displayNameProblem(title);
  if (problem) throw new RenameError(problem);
  if (title.length > maxLength) {
    throw new RenameError(`The name is longer than ${maxLength} characters.`);
  }
  return title;
}
