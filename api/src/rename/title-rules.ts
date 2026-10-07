/**
 * What a rename may write as a display name — the `title` half of a rename,
 * for the kinds whose name lives in a YAML file (flows, dbt jobs).
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
 * 500 from git.
 */
import { RenameError } from "./types";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD\u180E\s]/gu;

export function cleanRenameTitle(raw: string, maxLength: number): string {
  const title = raw.normalize("NFC").trim();
  if (!title || !title.replace(INVISIBLE, "")) {
    throw new RenameError("The name cannot be empty.");
  }
  if (CONTROL.test(title)) {
    throw new RenameError(
      "The name cannot contain line breaks, tabs or other control characters.",
    );
  }
  if (BIDI_CONTROL.test(title)) {
    throw new RenameError(
      "The name cannot contain text-direction control characters (they make one name look like another).",
    );
  }
  if (title.length > maxLength) {
    throw new RenameError(`The name is longer than ${maxLength} characters.`);
  }
  return title;
}
