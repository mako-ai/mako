/**
 * A flow's automatic display name, and when a save may still write it.
 *
 * The create forms name a new flow "Source → Destination" from the selected
 * connections. Both edit forms used to send that derived string on EVERY
 * save, so a name someone had set — through the rename dialog, the file, or
 * the agent — was silently overwritten the next time the form was saved.
 *
 * The rule: the auto name follows the selections only while the user has
 * never set a name of their own. "Never set" is decided by comparing the
 * stored name with what the auto name WAS for the flow's previous
 * selections — equal (or empty) means nobody touched it, so it may keep
 * following; anything else is a person's choice and the save leaves `name`
 * out of the payload entirely.
 */
import {
  OBJECT_NAME_MAX_LENGTH,
  normalizeObjectName,
} from "./object-name-rules";
/**
 * A derived name the server accepts (lib/object-name-rules.ts): control
 * characters from a connection or table name become spaces, and a name past
 * the flow cap is shortened with "…" — it is the form's own suggestion, not
 * something a person typed, and a create must not fail on a long
 * connection name. Never cuts a surrogate pair.
 */
export function clampAutoName(name: string): string {
  const clean = normalizeObjectName(
    // eslint-disable-next-line no-control-regex
    name.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " "),
  );
  const max = OBJECT_NAME_MAX_LENGTH.flow;
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}\u2026`;
}

export function flowNameForSave(input: {
  /** The name on the stored flow, when editing; absent when creating. */
  existingName: string | null | undefined;
  /** The auto name the previous selections would have produced. */
  previousAutoName: string | null | undefined;
  /** The auto name the current selections produce. */
  nextAutoName: string;
}): string | undefined {
  const next = clampAutoName(input.nextAutoName);
  const existing = input.existingName?.trim() ?? "";
  if (!existing) return next;
  const previous =
    input.previousAutoName === null || input.previousAutoName === undefined
      ? undefined
      : clampAutoName(input.previousAutoName);
  // Only a CHANGED selection has anything to say about the name. When the
  // selections are what they were, the form has no new name — and must not
  // send the old auto name either: the store it compares against can be
  // stale (a rename made by the agent or another session), and "stored
  // name equals the auto name" would then overwrite the new title.
  if (existing === previous && next !== previous) {
    return next;
  }
  return undefined;
}
