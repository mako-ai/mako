/**
 * Bytes Mako may pass through a string without changing them.
 *
 * A rename that edits one file in a folder (SKILL.md, connector.yaml, a
 * dbt model) decodes it, edits the text and re-encodes it. For anything
 * that is not valid UTF-8 that round trip replaces every invalid byte with
 * U+FFFD — a Latin-1 comment comes out corrupted. Such a file is refused
 * rather than rewritten; a bare `git mv` keeps its bytes.
 */
export function isUtf8Text(content: Buffer): boolean {
  return Buffer.from(content.toString("utf8"), "utf8").equals(content);
}
