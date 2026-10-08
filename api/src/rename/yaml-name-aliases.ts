/**
 * Edit `name:` and `aliases:` in a YAML file TEXTUALLY — a rename must not
 * rewrite the rest of the file.
 *
 * The first version re-serialised the parsed document, which is what the
 * product's write-through does on every edit — and which drops everything
 * the parser does not model: comments, unknown keys (`description:`), a job's
 * commands beyond the tenth. For a rename that is unacceptable: someone who
 * asked for a new title would find their annotations gone.
 *
 * So the two keys a rename owns are edited in place, on the lines that carry
 * them, and nothing else is touched. The edit is deliberately narrow: a
 * top-level `name:` holding a plain scalar on one line, and a top-level
 * `aliases:` that is absent, an inline sequence (`[a, b]`) or a block
 * sequence of `- item` lines. Anything else (a block scalar, an anchor, a
 * quoted key, a tag) returns `null` and the caller refuses the rename with
 * a message rather than guessing — "could not edit" is recoverable; a file
 * silently rewritten is not. The result is verified by the caller's own
 * parser before it is committed.
 */
import yaml from "js-yaml";

const NEWLINE = /\r?\n/;

/**
 * One string as a one-line YAML scalar that every reader takes back as THE
 * SAME STRING. A valid slug such as `2026`, `2026-10-06`, `true`, `1e3`,
 * `0x1F`, `012` or `.5` written plain is a number, a timestamp or a boolean
 * to a YAML parser — the rename's own re-parse then refused its output
 * ("could not be edited in place", 409), and a laptop tool reading YAML 1.1
 * adds `yes`/`no`/`on`/`off` to the list. js-yaml quotes every one of
 * those (YAML 1.1 and 1.2 core: booleans incl. yes/no/on/off, null/~,
 * ints/floats/hex/octal/binary/exponents, dates and timestamps,
 * .inf/.nan, sexagesimals); the result is also loaded back and compared,
 * and a value that does not survive is written JSON-quoted (double-quoted
 * YAML). Null when the value cannot be one line (a block scalar).
 */
export function yamlScalar(value: string): string | null {
  const dumped = yaml.dump(value, { lineWidth: -1 }).trimEnd();
  if (dumped.includes("\n")) return null;
  let back: unknown;
  try {
    back = yaml.load(dumped);
  } catch {
    back = undefined;
  }
  return back === value ? dumped : JSON.stringify(value);
}

/** `name: <value>`, quoted when it must be (see yamlScalar). */
function scalarLine(key: string, value: string): string | null {
  const scalar = yamlScalar(value);
  return scalar === null ? null : `${key}: ${scalar}`;
}

/** Every alias as a scalar, or null when one cannot be written on a line. */
function aliasScalars(aliases: string[]): string[] | null {
  const out: string[] = [];
  for (const alias of aliases) {
    const scalar = yamlScalar(alias);
    if (scalar === null) return null;
    out.push(scalar);
  }
  return out;
}

/** Index of the single top-level `key:` line, or -1 (none) / -2 (several). */
function findTopLevelKey(lines: string[], key: string): number {
  const re = new RegExp(`^${key}\\s*:`);
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    // Only column-0 keys are top level; `---` and comments are not keys.
    if (!re.test(lines[i])) continue;
    if (found !== -1) return -2;
    found = i;
  }
  return found;
}

/**
 * Replace the value of a top-level scalar key. `null` when the key is
 * missing, appears twice, or holds something that is not a one-line plain
 * value (a block scalar `|`/`>`, an anchor, a tag, a flow collection).
 */
export function setTopLevelScalar(
  contents: string,
  key: string,
  value: string,
): string | null {
  const lines = contents.split(NEWLINE);
  const at = findTopLevelKey(lines, key);
  if (at < 0) return null;
  const rest = lines[at].slice(lines[at].indexOf(":") + 1).trim();
  if (/^[|>&*!{[]/.test(rest)) return null;
  const comment = trailingComment(rest);
  if (comment === null) return null;
  const line = scalarLine(key, value);
  if (line === null) return null;
  // The line's own comment (`name: Foo  # shown in the sidebar`) is the
  // author's, not the rename's: it stays.
  lines[at] = line + comment;
  return joinLike(contents, lines);
}

/**
 * The comment that follows a one-line scalar value (`  # …`, with the
 * whitespace before it), "" when there is none, or null when the value's
 * quoting cannot be followed (an unterminated quote) — refused, not
 * guessed. In a plain scalar a `#` starts a comment only after whitespace;
 * inside quotes it never does.
 */
function trailingComment(rest: string): string | null {
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    let i = 1;
    for (; i < rest.length; i++) {
      if (quote === '"' && rest[i] === "\\") {
        i++;
        continue;
      }
      if (rest[i] === quote) {
        if (quote === "'" && rest[i + 1] === "'") {
          i++;
          continue;
        }
        break;
      }
    }
    if (i >= rest.length) return null;
    const after = rest.slice(i + 1);
    const match = after.match(/^\s+#.*$/);
    if (match) return match[0];
    return after.trim() === "" ? "" : null;
  }
  const at = rest.search(/\s+#/);
  return at === -1 ? "" : rest.slice(at);
}

/**
 * The last line of the block sequence that follows `aliases:` at `start`
 * (`start` itself when the block is empty). `null` when what follows is
 * indented but not a sequence item — a mapping, a nested scalar — which this
 * editor does not model and must not cut in half.
 */
function blockSequenceEnd(lines: string[], start: number): number | null {
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) {
      // Blank/comment lines inside the block belong to it only if more
      // items follow; `end` advances on items alone, so trailing ones are
      // left where they are.
      continue;
    }
    if (/^\s+-\s/.test(line) || /^\s+-$/.test(line)) {
      end = i;
      continue;
    }
    if (/^\s+\S/.test(line)) return null;
    break;
  }
  return end;
}

/**
 * Set the top-level `aliases:` to `aliases` (removing the key when empty).
 * Handles: no key; `aliases: [a, b]`; `aliases: []`; and a block sequence.
 * `null` for anything else (an anchor, a tag, a mapping, a nested form).
 * Inserted after `name:` when absent, so the two rename-owned keys sit
 * together.
 *
 * The file's own shape and words stay: an inline list stays inline with
 * its trailing comment; a block list keeps its comment lines and the
 * comments on its items — an item no longer wanted loses its line, a new
 * one is appended in the list's own indentation. Only a list whose order
 * the new one cannot be reached from that way is written out whole (and
 * even then the comment on the `aliases:` line stays).
 */
export function setTopLevelAliases(
  contents: string,
  aliases: string[],
): string | null {
  const lines = contents.split(NEWLINE);
  const at = findTopLevelKey(lines, "aliases");
  if (at === -2) return null;
  // Each alias written as a string scalar (`- '2026'`, never `- 2026`).
  const scalars = aliasScalars(aliases);
  if (scalars === null) return null;
  const replacement =
    scalars.length === 0 ? [] : ["aliases:", ...scalars.map(a => `  - ${a}`)];
  if (at === -1) {
    if (replacement.length === 0) return contents;
    const nameAt = findTopLevelKey(lines, "name");
    if (nameAt < 0) return null;
    lines.splice(nameAt + 1, 0, ...replacement);
    return joinLike(contents, lines);
  }
  const rest = lines[at].slice(lines[at].indexOf(":") + 1).trim();
  if (rest === "" || /^#/.test(rest)) {
    const blockEnd = blockSequenceEnd(lines, at);
    if (blockEnd === null) return null;
    if (aliases.length === 0) {
      lines.splice(at, blockEnd - at + 1);
      return joinLike(contents, lines);
    }
    const edited = editBlockItems(lines.slice(at + 1, blockEnd + 1), aliases);
    if (edited !== null) {
      lines.splice(at + 1, blockEnd - at, ...edited);
      return joinLike(contents, lines);
    }
    lines.splice(
      at,
      blockEnd - at + 1,
      lines[at].replace(/\s*$/, ""),
      ...scalars.map(a => `  - ${a}`),
    );
    return joinLike(contents, lines);
  }
  const inline = rest.match(/^\[([^\]]*)\](\s*#.*)?$/);
  if (!inline) return null;
  if (aliases.length === 0) {
    lines.splice(at, 1);
    return joinLike(contents, lines);
  }
  // Inline stays inline, with its comment.
  lines[at] = `aliases: [${scalars.join(", ")}]${inline[2] ?? ""}`;
  return joinLike(contents, lines);
}

/**
 * A block list's lines (after the `aliases:` line) edited to hold
 * `aliases`, or null when that cannot be done by dropping items and
 * appending new ones (an item the editor cannot read, a reordering).
 */
function editBlockItems(block: string[], aliases: string[]): string[] | null {
  const items: Array<{ index: number; value: string }> = [];
  let indent = "  - ";
  for (let i = 0; i < block.length; i++) {
    const m = block[i].match(/^(\s+-\s+)(.*)$/);
    if (!m) {
      if (/^\s+-\s*$/.test(block[i])) return null; // an empty item
      continue; // a comment or blank line: kept as it is
    }
    if (items.length === 0) indent = m[1];
    const raw = m[2];
    const comment = trailingComment(raw);
    if (comment === null) return null;
    let value = raw.slice(0, raw.length - comment.length).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) return null;
    items.push({ index: i, value });
  }
  const keep = items.filter(item => aliases.includes(item.value));
  const kept = keep.map(item => item.value);
  const added = aliases.filter(alias => !kept.includes(alias));
  if ([...kept, ...added].join("\0") !== aliases.join("\0")) return null;
  const drop = new Set(
    items.filter(item => !aliases.includes(item.value)).map(i => i.index),
  );
  const out = block.filter((_, i) => !drop.has(i));
  // New items go after the last item still there (or where the list's
  // items were), never after trailing comments that belong to the next key.
  const lastKept = keep.length > 0 ? keep[keep.length - 1].index : -1;
  const insertAt =
    lastKept === -1
      ? out.length
      : block.slice(0, lastKept + 1).filter((_, i) => !drop.has(i)).length;
  const addedScalars = aliasScalars(added);
  if (addedScalars === null) return null;
  out.splice(insertAt, 0, ...addedScalars.map(alias => `${indent}${alias}`));
  return out;
}

/** Re-join with the file's own line ending, keeping a trailing newline. */
function joinLike(original: string, lines: string[]): string {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const out = lines.join(eol);
  return out.endsWith(eol) ? out : out + eol;
}

/**
 * Both edits at once, for the rename services. `null` when either cannot be
 * made textually; the caller refuses the rename in that case.
 */
export function editNameAndAliases(
  contents: string,
  name: string,
  aliases: string[],
): string | null {
  const withName = setTopLevelScalar(contents, "name", name);
  if (withName === null) return null;
  return setTopLevelAliases(withName, aliases);
}
