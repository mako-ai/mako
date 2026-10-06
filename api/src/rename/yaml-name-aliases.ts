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

/** `name: <value>` as js-yaml would write it (quoted when it must be). */
function scalarLine(key: string, value: string): string | null {
  const dumped = yaml.dump({ [key]: value }, { lineWidth: -1 }).trimEnd();
  // A value js-yaml must fold onto several lines (block scalar) is outside
  // what this edits.
  return dumped.includes("\n") ? null : dumped;
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
  const line = scalarLine(key, value);
  if (line === null) return null;
  lines[at] = line;
  return joinLike(contents, lines);
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
 */
export function setTopLevelAliases(
  contents: string,
  aliases: string[],
): string | null {
  const lines = contents.split(NEWLINE);
  const at = findTopLevelKey(lines, "aliases");
  if (at === -2) return null;
  const replacement =
    aliases.length === 0 ? [] : ["aliases:", ...aliases.map(a => `  - ${a}`)];
  if (at === -1) {
    if (replacement.length === 0) return contents;
    const nameAt = findTopLevelKey(lines, "name");
    if (nameAt < 0) return null;
    lines.splice(nameAt + 1, 0, ...replacement);
    return joinLike(contents, lines);
  }
  const rest = lines[at].slice(lines[at].indexOf(":") + 1).trim();
  let end: number;
  if (rest === "" || /^#/.test(rest)) {
    const blockEnd = blockSequenceEnd(lines, at);
    if (blockEnd === null) return null;
    end = blockEnd;
  } else if (/^\[.*\]\s*(#.*)?$/.test(rest)) {
    end = at;
  } else {
    return null;
  }
  lines.splice(at, end - at + 1, ...replacement);
  return joinLike(contents, lines);
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
