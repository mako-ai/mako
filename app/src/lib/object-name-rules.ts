/**
 * The app's entry point to the server's name rules, so a name the server
 * would refuse is refused as it is typed — with the server's own words —
 * instead of after submit. The server keeps checking; this only saves the
 * round trip.
 *
 * Not a copy: the rules are `@mako/schemas` (object-names.ts), the module
 * the API's rename services run (api/src/rename/title-rules.ts).
 * api/src/rename/scenarios/name-rules-parity.test.ts holds the two entry
 * points to the same answers.
 */
import {
  SLUG_NAMED_KIND_NAME_MAX_LENGTH,
  displayNameError,
  normalizeDisplayName,
  renameSlugError,
  type SlugNamedKind,
} from "@mako/schemas";

export type { SlugNamedKind };

/** How long a flow's or a dbt job's name may be. */
export const OBJECT_NAME_MAX_LENGTH = SLUG_NAMED_KIND_NAME_MAX_LENGTH;

/** NFC, trimmed — the form the server compares and stores a name in. */
export const normalizeObjectName = normalizeDisplayName;

/** Why a display name, as typed, would be refused — or null. */
export function objectNameError(raw: string, maxLength: number): string | null {
  return displayNameError(normalizeDisplayName(raw), maxLength);
}

/**
 * Why a file name, as typed, would be refused — or null. Whether the name
 * is free is the server's question.
 */
export function objectSlugError(
  kind: SlugNamedKind,
  raw: string,
): string | null {
  return renameSlugError(kind, raw.trim());
}
