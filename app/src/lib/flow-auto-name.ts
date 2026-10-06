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
export function flowNameForSave(input: {
  /** The name on the stored flow, when editing; absent when creating. */
  existingName: string | null | undefined;
  /** The auto name the previous selections would have produced. */
  previousAutoName: string | null | undefined;
  /** The auto name the current selections produce. */
  nextAutoName: string;
}): string | undefined {
  const existing = input.existingName?.trim() ?? "";
  if (!existing) return input.nextAutoName;
  const previous = input.previousAutoName?.trim();
  // Only a CHANGED selection has anything to say about the name. When the
  // selections are what they were, the form has no new name — and must not
  // send the old auto name either: the store it compares against can be
  // stale (a rename made by the agent or another session), and "stored
  // name equals the auto name" would then overwrite the new title.
  if (existing === previous && input.nextAutoName !== previous) {
    return input.nextAutoName;
  }
  return undefined;
}
