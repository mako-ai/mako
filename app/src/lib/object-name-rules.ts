/**
 * The rename dialog's copy of the server's name rules for flows and dbt
 * jobs (api/src/rename/title-rules.ts: `displayNameError`,
 * `renameSlugError`), so a name the server would refuse is refused as it is
 * typed — with the server's own words — instead of after submit. The server
 * keeps checking; this only saves the round trip.
 *
 * A copy, not an import (the app does not bundle api code), held equal by
 * api/src/rename/scenarios/name-rules-parity.test.ts, which runs both on the
 * same hostile corpus. Change one, change the other.
 *
 * Dependency-free on purpose: the parity test imports this file from api.
 * The one exception is apps (at the end): their rules are not copied at all
 * — they live in @mako/schemas (app-names.ts), which the API's app-paths.ts
 * uses too, so the "copy" is the same function; the parity test still pins
 * the answers, so a server change that stops using it is caught.
 */
import {
  appNameProblem,
  appTitleProblem,
  normalizeAppName,
} from "@mako/schemas";

export type NamedObjectKind = "flow" | "dbt_job";

/** api/src/rename/flow-rename.ts FLOW_NAME_MAX_LENGTH, dbt-job-rename.ts JOB_NAME_MAX_LENGTH. */
export const OBJECT_NAME_MAX_LENGTH: Record<NamedObjectKind, number> = {
  flow: 200,
  dbt_job: 128,
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD\u180E\s]/gu;

/** NFC, trimmed — the form the server compares and stores a name in. */
export function normalizeObjectName(raw: string): string {
  return raw.normalize("NFC").trim();
}

/** Why a display name would be refused, or null (server: displayNameError). */
export function objectNameError(
  kind: NamedObjectKind,
  raw: string,
): string | null {
  const name = normalizeObjectName(raw);
  if (!name || !name.replace(INVISIBLE, "")) {
    return "The name cannot be empty.";
  }
  if (CONTROL.test(name)) {
    return "The name cannot contain line breaks, tabs or other control characters.";
  }
  if (BIDI_CONTROL.test(name)) {
    return "The name cannot contain text-direction control characters (they make one name look like another).";
  }
  const max = OBJECT_NAME_MAX_LENGTH[kind];
  if (name.length > max) return `The name is longer than ${max} characters.`;
  return null;
}

const FILE_DIR: Record<NamedObjectKind, string> = {
  flow: "flows/",
  dbt_job: "dbt/jobs/",
};
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Why a (trimmed) file name would be refused, or null (server:
 * renameSlugError — the slug rule creation mints, plus Windows device names
 * and id lookalikes). Whether the name is free is the server's question.
 */
export function objectSlugError(
  kind: NamedObjectKind,
  slug: string,
): string | null {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 64) {
    return `"${slug}" is not a valid file name: lowercase letters, digits and single dashes, up to 64 characters (it becomes ${FILE_DIR[kind]}${slug}.yml).`;
  }
  if (WINDOWS_RESERVED.test(slug)) {
    return `"${slug}" is a device name Windows reserves (a checkout could not create that file); choose another name.`;
  }
  if (/^[0-9a-f]{24}$/i.test(slug)) {
    return `"${slug}" looks like an object id, and ids resolve before names; choose another name.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Apps: a link (the folder name `/apps/<link>` is made of) and a name
// ---------------------------------------------------------------------------

export { normalizeAppName };

/**
 * Why a NEW app link would be refused, or null (server:
 * app-paths.ts newAppSlugProblem). `raw` as typed; normalized here.
 */
export function appLinkError(raw: string): string | null {
  return appNameProblem(normalizeAppName(raw), "link");
}

/** Why a new folder-of-apps name would be refused (server: newSegmentProblem). */
export function appFolderNameError(raw: string): string | null {
  return appNameProblem(normalizeAppName(raw), "folder");
}

/** Why an app name (title) would be refused (server: appTitleProblem). */
export function appNameError(raw: string): string | null {
  return appTitleProblem(normalizeAppName(raw));
}
