/**
 * What may be written as a name — the `title` half of a rename, and every
 * other path that writes a display name or hands out a file-name slug: one
 * rule everywhere, so a name no rename would accept cannot get in by
 * another door.
 *
 * The rules themselves live in `@mako/schemas` (object-names.ts), which the
 * app's rename dialog imports too (app/src/lib/object-name-rules.ts), so a
 * name the server refuses is refused as it is typed, with the same words.
 * This module is the API's entry point: the shared rules, plus the form the
 * rename services use — a 400 with the reason, never a 409 blaming the file
 * or a 500/502 from git.
 */
import {
  displayNameError,
  normalizeDisplayName,
  renameSlugError,
  type SlugNamedKind,
} from "@mako/schemas";
import { RenameError } from "./types";

export {
  displayNameError,
  displayNameProblem,
  displayNameTooLong,
  isRenameSlug,
  looksLikeObjectId,
  normalizeDisplayName,
  renameSlugError,
  unsafeSlugReason,
} from "@mako/schemas";

/** The rename services' rule: normalised, valid, within `maxLength` — or a 400. */
export function cleanRenameTitle(raw: string, maxLength: number): string {
  const title = normalizeDisplayName(raw);
  const problem = displayNameError(title, maxLength);
  if (problem) throw new RenameError(problem);
  return title;
}

/** A flow's or dbt job's new file name, trimmed and valid — or a 400. */
export function cleanRenameSlug(kind: SlugNamedKind, raw: string): string {
  const slug = raw.trim();
  const problem = renameSlugError(kind, slug);
  if (problem) throw new RenameError(problem);
  return slug;
}
