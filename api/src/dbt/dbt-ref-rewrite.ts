/**
 * Renaming a dbt model file renames the model: pure text rewrites.
 *
 * A model's name is its file name, so `models/orders.sql` → `models/fct_orders.sql`
 * silently breaks every `ref('orders')` downstream, every job whose
 * `--select orders` named it, and (after the next run) every console that
 * queried the old relation. The first two live in the project and can be
 * rewritten in the same commit as the move; this module is that rewrite,
 * kept pure (strings in, strings out) so it is testable without git.
 *
 * What is rewritten:
 *   - `ref('old')`, `ref("old")`, with any whitespace inside the parens,
 *     and the version kwarg forms `ref('old', v=2)` / `ref('old', version=2)`;
 *   - the two-argument package form `ref('<project>', 'old')` when the
 *     package IS this project (another package's `old` is another model);
 *   - node selectors in job commands after `--select`/`-s`/`--models`/`-m`/
 *     `--exclude`, including graph operators (`+old`, `old+`, `2+old+3`,
 *     `@old`) and comma/space-separated lists.
 *
 * What is deliberately left alone: `ref('old_suffix')` and `old2` (a
 * different model), `tag:old` / `fqn:old` / `path:old` (method selectors
 * name something else), `source('old', …)` (a source, not a model), and
 * plain SQL mentioning the relation (`from analytics.old`) — the warehouse
 * name depends on the target schema and is reported as a warning instead.
 * A `ref('old')` inside a comment IS rewritten: a comment naming a model
 * that no longer exists is the stale one.
 */

/** Model-like resources whose file name is a `ref()`-able node name. */
const REF_ABLE = [
  { dir: "models/", ext: ".sql" },
  { dir: "snapshots/", ext: ".sql" },
  { dir: "seeds/", ext: ".csv" },
];

/** `models/marts/orders.sql` → `orders`; null for anything not `ref()`-able. */
export function refNameForDbtPath(path: string): string | null {
  for (const { dir, ext } of REF_ABLE) {
    if (path.startsWith(dir) && path.endsWith(ext)) {
      const base = path.slice(path.lastIndexOf("/") + 1, -ext.length);
      return base || null;
    }
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RewriteResult {
  text: string;
  /** How many occurrences changed. */
  count: number;
}

/**
 * Rewrite `ref()` calls naming `oldName` to `newName`. `projectName` is the
 * dbt project's `name` (from dbt_project.yml); when given, the two-argument
 * form `ref('<projectName>', 'old')` is rewritten too.
 */
export function rewriteRefs(
  text: string,
  oldName: string,
  newName: string,
  projectName?: string,
): RewriteResult {
  if (oldName === newName) return { text, count: 0 };
  const old = escapeRegExp(oldName);
  let count = 0;
  // One-arg (plus version kwarg): ref( 'old' ) / ref('old', v=2)
  const oneArg = new RegExp(
    `(\\bref\\(\\s*)(['"])${old}\\2(?=\\s*(?:\\)|,\\s*(?:v|version)\\s*=))`,
    "g",
  );
  let out = text.replace(oneArg, (_m, head: string, quote: string) => {
    count++;
    return `${head}${quote}${newName}${quote}`;
  });
  if (projectName) {
    const pkg = escapeRegExp(projectName);
    // Two-arg: ref('project', 'old') — only when the package is this project.
    const twoArg = new RegExp(
      `(\\bref\\(\\s*(['"])${pkg}\\2\\s*,\\s*)(['"])${old}\\3(?=\\s*(?:\\)|,))`,
      "g",
    );
    out = out.replace(
      twoArg,
      (_m, head: string, _q1: string, quote: string) => {
        count++;
        return `${head}${quote}${newName}${quote}`;
      },
    );
  }
  return { text: out, count };
}

/** Flags whose following tokens are node selectors. */
const SELECTOR_FLAGS = new Set([
  "--select",
  "-s",
  "--models",
  "-m",
  "--exclude",
]);

/**
 * Rewrite a bare node name inside one selector token. The name must stand
 * alone between graph operators / separators: `+old+`, `2+old`, `@old`,
 * `a,old`, `"old tag:x"`. `tag:old` (a method selector) and `old_x` / `old2`
 * (other names) do not match.
 */
function rewriteSelectorToken(
  token: string,
  oldName: string,
  newName: string,
): RewriteResult {
  const old = escapeRegExp(oldName);
  const re = new RegExp(`(?<=^|[\\s,+@"'])${old}(?=$|[\\s,+"'])`, "g");
  let count = 0;
  const text = token.replace(re, () => {
    count++;
    return newName;
  });
  return { text, count };
}

/**
 * Rewrite node selectors in one dbt command line, e.g.
 * `dbt run --select old+ tag:daily -s other,old` → both `old`s renamed.
 * Tokens are split on whitespace; a quoted selector list stays one token
 * and is rewritten inside the quotes. Everything outside selector flags
 * (`--target old`, `--vars`) is untouched.
 */
export function rewriteSelectors(
  command: string,
  oldName: string,
  newName: string,
): RewriteResult {
  if (oldName === newName) return { text: command, count: 0 };
  // Split keeping quoted runs together, and keeping the separators so the
  // command is reassembled byte-for-byte where nothing changed.
  const parts = command.match(/"[^"]*"|'[^']*'|\S+|\s+/g) ?? [];
  let inSelector = false;
  let count = 0;
  const out = parts.map(part => {
    if (/^\s+$/.test(part)) return part;
    const eq = part.indexOf("=");
    const flag = eq > 0 ? part.slice(0, eq) : part;
    if (part.startsWith("-")) {
      inSelector = SELECTOR_FLAGS.has(flag);
      if (inSelector && eq > 0) {
        // `--select=old,other`
        const r = rewriteSelectorToken(part.slice(eq + 1), oldName, newName);
        count += r.count;
        return `${flag}=${r.text}`;
      }
      return part;
    }
    if (!inSelector) return part;
    const r = rewriteSelectorToken(part, oldName, newName);
    count += r.count;
    return r.text;
  });
  return { text: out.join(""), count };
}
