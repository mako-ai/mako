#!/usr/bin/env node
// mako-app-lint (2.21; react-version and --rules from 2.24): app rules a
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
//
// Usage: npx mako-app-lint [app dir …] [--warn] [--rules=a,b]. Exit 1 on
// findings unless --warn. --rules runs only the named rules. A line ending in `// mako-lint-ignore utc-display` is skipped (a
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

/** The lowest major a package.json range allows: "^18.2.0" → 18, ">=19" → 19; null when unreadable. */
export function minMajor(range) {
  const m = /(\d+)/.exec(String(range ?? ""));
  return m ? Number(m[1]) : null;
}

/** react-version: React below 19 with shadcn in the app. */
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
  if (major == null || major >= 19) return [];
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
  for (const file of walk(src)) {
    const rel = path.relative(appDir, file);
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
  for (const dir of dirs.length ? dirs : ["."]) {
    for (const f of lintApp(path.resolve(dir), rules)) {
      total++;
      console.log(`${path.join(dir, f.file)}:${f.line}  ${f.rule}  ${f.message}`);
    }
  }
  if (total) console.log(`\n${total} finding${total === 1 ? "" : "s"}`);
  return total && !warn ? 1 : 0;
}

// Installed bins run through a symlink (node_modules/.bin, pnpm's .pnpm
// store); import.meta.url is resolved and argv[1] is not, so compare real paths.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
