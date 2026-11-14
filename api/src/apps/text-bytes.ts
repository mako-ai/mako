/**
 * Bytes Mako may pass through a string without changing them.
 *
 * A rename that edits a file (a dbt model whose refs are rewritten, a
 * skill's SKILL.md) decodes it, edits the text and encodes it again. For
 * anything that is not valid UTF-8 that round trip replaces every invalid
 * byte with U+FFFD: a Latin-1 comment comes out corrupted. Such a file is
 * moved as it is or refused, never rewritten.
 */
export function isUtf8Text(content: Buffer): boolean {
  return Buffer.from(content.toString("utf8"), "utf8").equals(content);
}
