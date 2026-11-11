/**
 * What a workspace skill may be called. One module, so the skills service
 * (api/src/services/skills.service.ts) and the Skills panel's Rename dialog
 * refuse the same names with the same words.
 *
 * A skill name is its folder: lowercase letters, digits, `-` and `_`, starting
 * with a letter or digit. That keeps it one safe path segment (no `/`, no `.`,
 * so no `..`; no leading `-` that a shell could read as a flag) and accepts the
 * hyphenated names Claude Code skills and Mako's system skills use
 * (`app-ui-conventions`, `dialect-postgresql`). Until 2026-11 only snake_case
 * passed, and hyphenated folders committed from a clone never reached the
 * agent.
 */
import { unsafeSlugReason } from "./object-names";

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** The rule above in words, for error messages. */
export const SKILL_NAME_RULE =
  "lowercase a-z, 0-9, '-' and '_', starting with a letter or digit";

export const SKILL_NAME_MAX_LENGTH = 80;

/**
 * Why `name` (trimmed) cannot be a skill's NEW name, or null when it can:
 * the rule above, the length, and what no file name Mako hands out may be
 * (a Windows device name, something that reads as an object id). Whether
 * the name is free is the server's question.
 */
export function skillNameError(name: string): string | null {
  if (!name) return "The name cannot be empty.";
  if (name.length > SKILL_NAME_MAX_LENGTH) {
    return `The name is longer than ${SKILL_NAME_MAX_LENGTH} characters.`;
  }
  if (!SKILL_NAME_RE.test(name)) {
    return `A skill name is ${SKILL_NAME_RULE} (it is the skill's folder name).`;
  }
  return unsafeSlugReason(name);
}
