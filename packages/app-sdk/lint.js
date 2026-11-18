#!/usr/bin/env node
// mako-app-lint (2.21): the 2 app rules a reviewer kept repeating.
//
//   utc-display   getUTC*, timeZone: "UTC" or toISOString().slice in display
//                 code. Instants show in the viewer's zone (formatTime), day
//                 buckets unshifted (formatDate), keys come from toDayKey.
//   local-shadcn  src/components/ui/<name>.tsx where @makoai/app-sdk ships
//                 that component (/components, /menu). Import it instead.
//
// Usage: npx mako-app-lint [app dir …] [--warn]. Exit 1 on findings unless
// --warn. A line ending in `// mako-lint-ignore utc-display` is skipped (a
// date key the helpers cannot build, with the reason on the line above).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SDK_COMPONENTS = [
  "badge", "button", "card", "checkbox", "dialog", "dropdown-menu",
  "input", "popover", "separator", "skeleton", "tabs", "tooltip",
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

/** Findings for one app folder: { file, line, rule, message }. */
export function lintApp(appDir) {
  const findings = [];
  const src = path.join(appDir, "src");
  for (const file of walk(src)) {
    const rel = path.relative(appDir, file);
    const ui = /^src[\\/]components[\\/]ui[\\/]([a-z-]+)\.tsx$/.exec(rel);
    if (ui && SDK_COMPONENTS.includes(ui[1])) {
      const from = ["dropdown-menu", "checkbox"].includes(ui[1]) ? "@makoai/app-sdk/menu" : "@makoai/app-sdk/components";
      findings.push({ file: rel, line: 1, rule: "local-shadcn", message: `the SDK ships ${ui[1]}: import it from "${from}" and delete this copy` });
    }
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, i) => {
        if (!UTC_DISPLAY.test(text) || /mako-lint-ignore utc-display/.test(text)) return;
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
  const dirs = argv.filter(a => !a.startsWith("--"));
  let total = 0;
  for (const dir of dirs.length ? dirs : ["."]) {
    for (const f of lintApp(path.resolve(dir))) {
      total++;
      console.log(`${path.join(dir, f.file)}:${f.line}  ${f.rule}  ${f.message}`);
    }
  }
  if (total) console.log(`\n${total} finding${total === 1 ? "" : "s"}`);
  return total && !warn ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
