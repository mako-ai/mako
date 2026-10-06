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
 *     `@old`) and comma/space-separated lists — rewritten on the command
 *     LINES of `dbt/jobs/*.yml`, never by re-serializing the file;
 *   - the model's config key in `dbt_project.yml` (`models: <proj>: …
 *     old:`), textually;
 *   - the node's own entry in a properties YAML (`models:` / `seeds:` /
 *     `snapshots:` → `- name: old`), so its descriptions and tests stay
 *     attached; a `columns:` entry named `old` is a column and is kept.
 *
 * What is deliberately left alone: `ref('old_suffix')` and `old2` (a
 * different model), `tag:old` / `fqn:old` / `path:old` (method selectors
 * name something else), dotted path selectors (`marts.old`), `source('old',
 * …)` (a source, not a model), `selectors.yml`, and plain SQL mentioning
 * the relation (`from analytics.old`) — the warehouse name depends on the
 * target schema. Each of those is DETECTED and reported as a warning.
 * A `ref('old')` inside a comment IS rewritten: a comment naming a model
 * that no longer exists is the stale one.
 */

import yaml from "js-yaml";

/**
 * Resources whose FILE NAME is their `ref()`-able node name: SQL and Python
 * models, and seeds. Snapshots are deliberately absent — a snapshot is
 * named by its `{% snapshot <name> %}` block, so `snapshots/orders.sql`
 * may hold `orders_snapshot`, and treating the file name as the node would
 * rewrite the MODEL `orders` instead. Analyses, macros and tests are not
 * `ref()`-able at all.
 */
const REF_ABLE = [
  { dir: "models/", ext: ".sql" },
  { dir: "models/", ext: ".py" },
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

/**
 * Top-level properties-YAML keys whose list entries are nodes named by
 * their file (see REF_ABLE): a `snapshots:` entry is named by its block,
 * so a model rename never touches it.
 */
const NODE_LIST_KEYS = new Set(["models", "seeds"]);

/**
 * Rewrite `- name: old` → `- name: new` for the node's own entry in a dbt
 * properties file (`models/schema.yml`), and `model: old` → `model: new`
 * in `unit_tests:` items (a unit test names the model it tests). Line-based on purpose: a YAML
 * round trip would drop the author's comments and reflow their file, and
 * the entry we want is always a list item directly under a top-level
 * `models:` / `seeds:` / `snapshots:` key. The item indent is learned from
 * the first list item under that key, so a deeper `- name: old` (a column,
 * a test argument) is never touched.
 */
export function rewriteNodeProperties(
  text: string,
  oldName: string,
  newName: string,
): RewriteResult {
  if (oldName === newName) return { text, count: 0 };
  const lines = text.split("\n");
  let inNodeList = false;
  let itemIndent: number | null = null;
  let count = 0;
  const nameRe = new RegExp(
    `^(\\s*-\\s*name:\\s*)(['"]?)${escapeRegExp(oldName)}\\2(\\s*(?:#.*)?)$`,
  );
  // `unit_tests:` items name the model they test with `model: old` — a key
  // at the item's key column (`- name: t` puts keys at indent + 2).
  let inUnitTests = false;
  let keyIndent: number | null = null;
  const modelRe = new RegExp(
    `^(\\s+model:\\s*)(['"]?)${escapeRegExp(oldName)}\\2(\\s*(?:#.*)?)$`,
  );
  const out = lines.map(line => {
    const topLevel = /^([A-Za-z_][\w-]*):\s*(#.*)?$/.exec(line);
    if (topLevel) {
      inNodeList = NODE_LIST_KEYS.has(topLevel[1]);
      inUnitTests = topLevel[1] === "unit_tests";
      itemIndent = null;
      keyIndent = null;
      return line;
    }
    if (line.trim() === "") return line;
    if (inUnitTests) {
      const item = /^(\s*)(-\s+)/.exec(line);
      if (item && itemIndent === null) {
        itemIndent = item[1].length;
        keyIndent = item[1].length + item[2].length;
      }
      const m = modelRe.exec(line);
      if (!m || line.search(/\S/) !== keyIndent) return line;
      count++;
      return `${m[1]}${m[2]}${newName}${m[2]}${m[3]}`;
    }
    if (!inNodeList) return line;
    const item = /^(\s*)-\s/.exec(line);
    if (item && itemIndent === null) itemIndent = item[1].length;
    if (!item || item[1].length !== itemIndent) return line;
    const m = nameRe.exec(line);
    if (!m) return line;
    count++;
    return `${m[1]}${m[2]}${newName}${m[2]}${m[3]}`;
  });
  return { text: out.join("\n"), count };
}

export interface JobRewriteResult extends RewriteResult {
  /** Commands that name the model but could not be rewritten in place. */
  unrewritable: string[];
}

/** A YAML list item line: `<indent>- <scalar>`. */
const ITEM_RE = /^(\s*)-\s+(.*)$/;
/** A block-scalar header (`|`, `>`, `|-`, `>+`, `>2-`, …) with an optional comment. */
const BLOCK_HEADER_RE = /^[|>][0-9+-]*\s*(#.*)?$/;

/**
 * Rewrite selectors in the `commands:` list of a job file, LINE BY LINE.
 * A job file is the author's: parsing and re-serializing it would drop
 * comments, unknown keys and (via `parseJobFile`'s caps) commands past the
 * tenth. Handled in place:
 *   - a plain or single-line quoted list item directly under `commands:`;
 *   - a block scalar (`- >-` + indented lines — what `serializeJobFile`
 *     emits for a command over ~100 chars) is parsed as YAML, rewritten,
 *     and re-emitted as ONE double-quoted scalar when it changed;
 *   - a flow sequence on the key line (`commands: ["dbt run"]`).
 * A quoted scalar with escapes inside, or a block that does not parse,
 * is left alone and reported only when it actually names the model.
 */
export function rewriteJobCommands(
  text: string,
  oldName: string,
  newName: string,
): JobRewriteResult {
  if (oldName === newName) return { text, count: 0, unrewritable: [] };
  const lines = text.split("\n");
  const out: string[] = [];
  let inCommands = false;
  let itemIndent: number | null = null;
  let count = 0;
  const unrewritable: string[] = [];
  const mentions = new RegExp(`(?<![\\w.])${escapeRegExp(oldName)}(?![\\w])`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const topLevel = /^([A-Za-z_][\w-]*):\s*(#.*)?$/.exec(line);
    if (topLevel) {
      inCommands = topLevel[1] === "commands";
      itemIndent = null;
      out.push(line);
      continue;
    }
    const flow = /^commands:\s*(\[.*\])\s*(#.*)?$/.exec(line);
    if (flow) {
      inCommands = false;
      let items: unknown;
      try {
        items = yaml.load(flow[1]);
      } catch {
        items = null;
      }
      if (!Array.isArray(items) || !items.every(x => typeof x === "string")) {
        if (mentions.test(line)) unrewritable.push(line.trim());
        out.push(line);
        continue;
      }
      let changed = 0;
      const next = (items as string[]).map(cmd => {
        const r = rewriteSelectors(cmd, oldName, newName);
        changed += r.count;
        return r.text;
      });
      count += changed;
      out.push(
        changed > 0
          ? `commands: [${next.map(c => JSON.stringify(c)).join(", ")}]${flow[2] ? `  ${flow[2]}` : ""}`
          : line,
      );
      continue;
    }
    if (!inCommands || line.trim() === "") {
      out.push(line);
      continue;
    }
    const item = ITEM_RE.exec(line);
    if (item && itemIndent === null) itemIndent = item[1].length;
    if (!item || item[1].length !== itemIndent) {
      out.push(line);
      continue;
    }
    const head = line.slice(0, line.length - item[2].length);
    const scalar = item[2];

    const quoted = /^(['"])(.*)\1(\s*(?:#.*)?)$/.exec(scalar);
    if (quoted) {
      // Quoted single-line scalar: rewrite inside the quotes when it holds
      // no escapes (an escaped quote changes where the command's words end).
      if (quoted[2].includes("\\")) {
        if (mentions.test(quoted[2])) unrewritable.push(scalar);
        out.push(line);
        continue;
      }
      const r = rewriteSelectors(quoted[2], oldName, newName);
      count += r.count;
      out.push(`${head}${quoted[1]}${r.text}${quoted[1]}${quoted[3]}`);
      continue;
    }

    if (BLOCK_HEADER_RE.test(scalar)) {
      // Block scalar: the command continues on the following lines, more
      // indented than the item. Parse exactly those lines as YAML.
      const bodyLines: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (
          l.trim() === "" ||
          (/^\s/.test(l) && l.search(/\S/) > item[1].length)
        ) {
          bodyLines.push(l);
          continue;
        }
        break;
      }
      // Trailing blank lines belong to whatever follows, not the block.
      while (
        bodyLines.length > 0 &&
        bodyLines[bodyLines.length - 1].trim() === ""
      ) {
        bodyLines.pop();
        j--;
      }
      let command: unknown;
      try {
        const doc = yaml.load(
          [`- ${scalar}`, ...bodyLines.map(l => l.slice(item[1].length))].join(
            "\n",
          ),
        );
        command = Array.isArray(doc) ? doc[0] : null;
      } catch {
        command = null;
      }
      if (typeof command !== "string") {
        if (mentions.test(bodyLines.join("\n"))) {
          unrewritable.push(bodyLines.map(l => l.trim()).join(" "));
        }
        out.push(line);
        continue;
      }
      // A command is one shell line: a literal block's trailing newline
      // (or a folded block's inner whitespace) is YAML's, not the command's.
      const r = rewriteSelectors(command.trim(), oldName, newName);
      if (r.count === 0) {
        out.push(line);
        continue;
      }
      count += r.count;
      out.push(`${head}${JSON.stringify(r.text)}`);
      i = j - 1; // the block's lines are consumed
      continue;
    }

    // Plain scalar; a trailing ` #comment` is YAML's, not the command's.
    const comment = /\s+#.*$/.exec(scalar);
    const command = comment ? scalar.slice(0, comment.index) : scalar;
    const r = rewriteSelectors(command, oldName, newName);
    count += r.count;
    out.push(`${head}${r.text}${comment ? comment[0] : ""}`);
  }
  return { text: out.join("\n"), count, unrewritable };
}

/**
 * Selector tokens in a command that still name the model after a rewrite:
 * dotted path selectors (`marts.old`, `old.sub`) and method selectors
 * (`fqn:old`). Mako does not know whether `marts.old` is the model or a
 * folder of that name, so these are reported, not rewritten.
 */
export function selectorsStillNaming(command: string, name: string): string[] {
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  let inSelector = false;
  const hits: string[] = [];
  const re = new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`);
  for (const part of parts) {
    const eq = part.indexOf("=");
    const flag = eq > 0 ? part.slice(0, eq) : part;
    if (part.startsWith("-")) {
      inSelector = SELECTOR_FLAGS.has(flag);
      if (inSelector && eq > 0 && re.test(part.slice(eq + 1))) hits.push(part);
      continue;
    }
    if (inSelector && re.test(part)) hits.push(part);
  }
  return hits;
}

/**
 * Rewrite the model's config key in `dbt_project.yml`. Under top-level
 * `models:` (or `seeds:` for a seed) the keys mirror the resource's path:
 * `models: <project>: <dir>: …: <model>:`. The key is rewritten only when
 * its FULL key chain (project name excluded) equals the model's directory
 * segments plus its name — so `models/customers/customers.sql` renames
 * the inner `customers:` and keeps the folder key, and a key that merely
 * shares the name elsewhere is untouched. An inline mapping
 * (`old: {+materialized: table}`) is handled; a key whose value is on the
 * same line in any other form is not (and is left for the warning).
 *
 * `resourcePath` is project-relative (`models/marts/orders.sql`).
 */
export function rewriteProjectModelConfig(
  text: string,
  resourcePath: string,
  newName: string,
): RewriteResult {
  const oldName = refNameForDbtPath(resourcePath);
  if (!oldName || oldName === newName) return { text, count: 0 };
  const segments = resourcePath.split("/");
  const block = segments[0]; // `models` or `seeds`
  const wanted = [...segments.slice(1, -1), oldName];
  const lines = text.split("\n");
  let inBlock = false;
  // Key chain by indent inside the block, project level included at [0].
  const stack: Array<{ indent: number; key: string }> = [];
  let count = 0;
  const out = lines.map(line => {
    const topLevel = /^([A-Za-z_][\w-]*):\s*(#.*)?$/.exec(line);
    if (topLevel) {
      inBlock = topLevel[1] === block;
      stack.length = 0;
      return line;
    }
    if (!inBlock || line.trim() === "" || /^\s*#/.test(line)) return line;
    const key =
      /^(\s+)(['"]?)([^\s'"#:][^'":]*?)\2:(\s*(?:\{.*\})?\s*(?:#.*)?)$/.exec(
        line,
      );
    if (!key) return line;
    const indent = key[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    stack.push({ indent, key: key[3] });
    const chain = stack.slice(1).map(s => s.key); // drop the project level
    if (
      key[3] !== oldName ||
      chain.length !== wanted.length ||
      !chain.every((k, i) => k === wanted[i])
    ) {
      return line;
    }
    count++;
    stack[stack.length - 1].key = newName;
    return `${key[1]}${key[2]}${newName}${key[2]}:${key[4]}`;
  });
  return { text: out.join("\n"), count };
}

/** Does the text mention the name as a whole word (for "still mentions" warnings)? */
export function mentionsName(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w])${escapeRegExp(name)}(?![\\w])`).test(text);
}
