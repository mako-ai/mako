#!/usr/bin/env node
// mako-app-lint (2.21; react-version and --rules from 2.24, recharts check
// 2.25, distinct-sum 2.27): app rules a
// reviewer kept repeating.
//
//   utc-display   getUTC*, timeZone: "UTC" or toISOString().slice in display
//                 code. Instants show in the viewer's zone (formatTime), day
//                 buckets unshifted (formatDate), keys come from toDayKey.
//   local-shadcn  src/components/ui/<name>.tsx where @makoai/app-sdk ships
//                 that component (/components, /menu). Import it instead.
//   react-version an app on React below 19 that uses shadcn (src/components/ui,
//                 radix-ui, or the SDK's /components or /menu). shadcn's stock
//                 components pass refs as props, which React 18 drops: on
//                 18 Nov 2026 a Calendar's arrow keys stopped moving focus.
//                 Also React 19 with recharts 2 and no react-is 19 override:
//                 recharts 2 reads chart children with react-is 18, which
//                 drops anything in a <> fragment (19 Nov 2026: reference
//                 lines vanished from a chart).
//   distinct-sum  (warning) a binding column that is a distinct count
//                 (COUNT(DISTINCT), uniq, APPROX_COUNT_DISTINCT) summed in
//                 src/ (SQL SUM(col), or a JS reduce/sum/pivot next to it).
//                 One person in several groups counts once per group: on
//                 19 Nov 2026 visibility-dashboard showed ES unique users 13%
//                 high. Compute the total at the shown grain (GROUPING SETS)
//                 or ignore the line with the reason ("user-days").
//
// Usage: npx mako-app-lint [app dir …] [--warn] [--rules=a,b]. Exit 1 on
// findings unless --warn; warnings (distinct-sum) print and never fail. --rules runs only the named rules. A line ending in `// mako-lint-ignore utc-display` is skipped (a
// date key the helpers cannot build, with the reason on the line above).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Components on their own subpath: they need a peer most apps lack (react-day-picker, cmdk). */
export const SDK_SUBPATH_COMPONENTS = ["calendar", "command"];

export const SDK_COMPONENTS = [
  "alert", "avatar", "badge", "button", "card", "checkbox", "collapsible",
  "dialog", "dropdown-menu", "input", "label", "popover", "progress",
  "select", "separator", "sheet", "skeleton", "slider", "switch", "table",
  "tabs", "toggle", "toggle-group", "tooltip", ...SDK_SUBPATH_COMPONENTS,
];

const UTC_DISPLAY = /\.getUTC(?:FullYear|Month|Date|Day|Hours|Minutes|Seconds)\(|timeZone:\s*["']UTC["']|toISOString\(\)\s*\.\s*(?:slice|substring|substr)\(/;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?[jt]sx?)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const DISTINCT_SQL = /\b(?:count\s*\(\s*distinct\b|countDistinct\w*\s*\(|uniq(?:Exact|Combined|HLL12|Theta)?(?:If)?\s*\(|approx_count_distinct\s*\(|hll_count\.\w+\s*\(|approx_distinct\s*\()/gi;
const CAST_TYPES = /^(int64|string|float64|numeric|bigint|integer|double|int|int32|uint64|uint32)$/i;

/** Distinct-count output columns of the app's bindings: column → binding names. */
export function distinctColumns(appDir) {
  const dir = path.join(appDir, "bindings");
  const cols = new Map();
  if (!existsSync(dir)) return cols;
  for (const f of readdirSync(dir).filter(n => n.endsWith(".sql"))) {
    const sql = readFileSync(path.join(dir, f), "utf8").replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(DISTINCT_SQL)) {
      let i = m.index + m[0].length;
      for (let depth = 1; i < sql.length && depth > 0; i++) {
        if (sql[i] === "(") depth++;
        else if (sql[i] === ")") depth--;
      }
      // The alias: the last "AS name" before the next top-level comma (covers CAST(... AS INT64) AS x).
      const tail = sql.slice(i, i + 160);
      let end = tail.length;
      for (let j = 0, d = 0; j < tail.length; j++) {
        if (tail[j] === "(") d++;
        else if (tail[j] === ")") d = Math.max(0, d - 1);
        else if (tail[j] === "," && d === 0) { end = j; break; }
      }
      const as = [...tail.slice(0, end).matchAll(/\bAS\s+[`"]?(\w+)/gi)].pop();
      if (!as || CAST_TYPES.test(as[1])) continue;
      if (!cols.has(as[1])) cols.set(as[1], new Set());
      cols.get(as[1]).add(f.slice(0, -4));
    }
  }
  return cols;
}

const JS_SUM = /\.reduce\s*\(|\bsum(?:By|Of)?\s*\(|\bd3\.sum\b|\+=|\bpivot\s*\(/;

/** distinct-sum: a distinct-count column summed in this src file, which reads its binding. */
function distinctSumFindings(rel, text, cols) {
  const out = [];
  if (!cols.size) return out;
  const lines = text.split("\n");
  const reads = new Map();
  for (const [col, bindings] of cols) {
    const read = [...bindings].filter(b => new RegExp(`["'\`]${b}["'\`]|\\b(?:from|join)\\s+["]?${b}\\b`, "i").test(text));
    if (read.length) reads.set(col, read);
  }
  if (!reads.size) return out;
  lines.forEach((line, i) => {
    if (/mako-lint-ignore distinct-sum/.test(line) || /mako-lint-ignore distinct-sum/.test(lines[i - 1] ?? "")) return;
    for (const [col, bindings] of reads) {
      const sqlSum = new RegExp(`\\bsum\\s*\\(\\s*(?:\\w+\\.)?["\`]?${col}["\`]?\\s*\\)`, "i");
      const jsRef = new RegExp(`(?:[.?]\\.?${col}\\b|\\[\\s*["'\`]${col}["'\`]\\s*\\])`);
      const win = lines.slice(Math.max(0, i - 1), i + 2).join(" ");
      if (!sqlSum.test(line) && !(jsRef.test(line) && JS_SUM.test(win))) continue;
      out.push({
        file: rel,
        line: i + 1,
        rule: "distinct-sum",
        level: "warn",
        message: `${col} is a distinct count in ${bindings.join(", ")}: summed across groups it counts one entity once per group. Compute the total at the shown grain (GROUPING SETS), or add // mako-lint-ignore distinct-sum with the reason`,
      });
    }
  });
  return out;
}

/** The lowest major a package.json range allows: "^18.2.0" → 18, ">=19" → 19; null when unreadable. */
export function minMajor(range) {
  const m = /(\d+)/.exec(String(range ?? ""));
  return m ? Number(m[1]) : null;
}

/** The react-is range an override pins: pnpm.overrides, npm overrides or yarn resolutions. */
function reactIsOverride(pkg) {
  return pkg.pnpm?.overrides?.["react-is"] ?? pkg.overrides?.["react-is"] ?? pkg.resolutions?.["react-is"];
}

/** react-version: React below 19 with shadcn, or React 19 with recharts 2 on react-is 18. */
function reactVersionFindings(appDir) {
  const pj = path.join(appDir, "package.json");
  if (!existsSync(pj)) return [];
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pj, "utf8"));
  } catch {
    return [];
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const major = minMajor(deps.react);
  if (major == null) return [];
  if (major >= 19) {
    if (minMajor(deps.recharts) !== 2 || (minMajor(reactIsOverride(pkg)) ?? 0) >= 19) return [];
    return [{
      file: "package.json",
      line: 1,
      rule: "react-version",
      message: `React ${deps.react} with recharts ${deps.recharts}: recharts 2 reads chart children with react-is 18, which drops anything in a <> fragment. Add "pnpm": { "overrides": { "react-is": "^19.1.10" } }`,
    }];
  }
  const why = [];
  if (existsSync(path.join(appDir, "src", "components", "ui"))) why.push("src/components/ui");
  if (Object.keys(deps).some(d => d === "radix-ui" || d.startsWith("@radix-ui/"))) why.push("radix-ui");
  if (walk(path.join(appDir, "src")).some(f => /@makoai\/app-sdk\/(components|menu)/.test(readFileSync(f, "utf8")))) {
    why.push("@makoai/app-sdk/components or /menu");
  }
  if (!why.length) return [];
  return [{
    file: "package.json",
    line: 1,
    rule: "react-version",
    message: `React ${deps.react} with shadcn (${why.join(", ")}): shadcn passes refs as props, which React 18 drops. Move to react and react-dom ^19`,
  }];
}

/** Findings for one app folder: { file, line, rule, message }. `rules` limits them (default: all). */
export function lintApp(appDir, rules) {
  const on = name => !rules || rules.includes(name);
  const findings = on("react-version") ? reactVersionFindings(appDir) : [];
  const src = path.join(appDir, "src");
  const distinct = on("distinct-sum") ? distinctColumns(appDir) : new Map();
  for (const file of walk(src)) {
    const rel = path.relative(appDir, file);
    if (distinct.size) findings.push(...distinctSumFindings(rel, readFileSync(file, "utf8"), distinct));
    const ui = /^src[\\/]components[\\/]ui[\\/]([a-z-]+)\.tsx$/.exec(rel);
    if (on("local-shadcn") && ui && SDK_COMPONENTS.includes(ui[1])) {
      const from = ["dropdown-menu", "checkbox"].includes(ui[1])
        ? "@makoai/app-sdk/menu"
        : SDK_SUBPATH_COMPONENTS.includes(ui[1])
          ? `@makoai/app-sdk/components/${ui[1]}`
          : "@makoai/app-sdk/components";
      findings.push({ file: rel, line: 1, rule: "local-shadcn", message: `the SDK ships ${ui[1]}: import it from "${from}" and delete this copy` });
    }
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (!on("utc-display") || !UTC_DISPLAY.test(text) || /mako-lint-ignore utc-display/.test(text)) return;
        findings.push({
          file: rel,
          line: i + 1,
          rule: "utc-display",
          message: "UTC in display code: formatTime(instant) for times, formatDate(day) for day buckets, toDayKey(value) for keys",
        });
      });
  }
  return findings;
}

function main(argv) {
  const warn = argv.includes("--warn");
  const rulesArg = argv.find(a => a.startsWith("--rules="));
  const rules = rulesArg ? rulesArg.slice("--rules=".length).split(",").filter(Boolean) : undefined;
  const dirs = argv.filter(a => !a.startsWith("--"));
  let total = 0;
  let warnings = 0;
  for (const dir of dirs.length ? dirs : ["."]) {
    for (const f of lintApp(path.resolve(dir), rules)) {
      if (f.level === "warn") warnings++;
      else total++;
      console.log(`${path.join(dir, f.file)}:${f.line}  ${f.rule}${f.level === "warn" ? " (warning)" : ""}  ${f.message}`);
    }
  }
  if (total || warnings) console.log(`\n${total} finding${total === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
  return total && !warn ? 1 : 0;
}

// Installed bins run through a symlink (node_modules/.bin, pnpm's .pnpm
// store); import.meta.url is resolved and argv[1] is not, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
