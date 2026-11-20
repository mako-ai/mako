/**
 * Nothing outside api/src/connectors/<family>/ may import that family, unless
 * the family is on the allowlist in connector-family-allowlist.ts. The list
 * only shrinks. Once a family has no outside importer, deleting its folder is
 * all it takes to remove it.
 *
 * Why deleting the folder removes the connector: the boot-time scans in
 * api/src/connectors/registry.ts and api/src/sync/connector-registry.ts import
 * every folder present under api/src/connectors with a computed path. Those
 * scans are invisible to this test, which counts only static imports, re-exports
 * (`export ... from`) and dynamic `import("literal")` calls.
 *
 * Imports inside a family folder, and imports of shared modules (base/,
 * workspace/, top-level files), always pass.
 *
 * Run: tsx src/connectors/connector-family-boundary.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  ALLOWED_FAMILIES_IMPORTED_FROM_OUTSIDE,
  SHARED_DIRECTORIES,
} from "./connector-family-allowlist";

/** Ceiling for the allowlist. Lower it as families are removed. Never raise it. */
const MAX_ALLOWED_FAMILIES = 7;

const SRC_ROOT = path.resolve(__dirname, "..");
const CONNECTORS_ROOT = path.resolve(__dirname);

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'`])(\.{1,2}\/[^"'`]*|\.{1,2})\1/g;

export function importedSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(SPECIFIER)) out.push(m[2]);
  return out;
}

/** The family folder a specifier from `file` resolves into, or null. */
export function familyOf(file: string, specifier: string): string | null {
  const target = path.resolve(path.dirname(file), specifier);
  const rel = path.relative(CONNECTORS_ROOT, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const [first] = rel.split(path.sep);
  if (!first || SHARED_DIRECTORIES.includes(first)) return null;
  // A top-level file such as registry.ts or rate-gate is shared.
  const asDir = path.join(CONNECTORS_ROOT, first);
  try {
    if (!statSync(asDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return first;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(e.name)) out.push(full);
  }
  return out;
}

export function violations(files: string[]): string[] {
  const allowed = new Set(ALLOWED_FAMILIES_IMPORTED_FROM_OUTSIDE);
  const found: string[] = [];
  for (const file of files) {
    const inFamily = familyOf(file, ".") ?? null;
    for (const spec of importedSpecifiers(readFileSync(file, "utf8"))) {
      const family = familyOf(file, spec);
      if (!family || family === inFamily) continue;
      if (allowed.has(family)) continue;
      found.push(
        `${path.relative(SRC_ROOT, file)} imports "${spec}" (family ${family})`,
      );
    }
  }
  return found;
}

function main() {
  // Self-test of the matcher.
  assert.deepEqual(
    importedSpecifiers(
      `import a from "./x";\nexport { b } from "../y";\nconst c = await import("./z/w");\nimport "./side";\nimport p from "pkg";\n` +
        `const r = require("./req");\nexport * from "./star";\nimport type { T } from "./types";\n` +
        "const d = await import(`../connectors/stripe`);",
    ),
    [
      "./x",
      "../y",
      "./z/w",
      "./side",
      "./req",
      "./star",
      "./types",
      "../connectors/stripe",
    ],
  );

  const present = readdirSync(CONNECTORS_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && !SHARED_DIRECTORIES.includes(e.name))
    .map(e => e.name);
  assert.ok(
    ALLOWED_FAMILIES_IMPORTED_FROM_OUTSIDE.length <= MAX_ALLOWED_FAMILIES,
    `The allowlist has ${ALLOWED_FAMILIES_IMPORTED_FROM_OUTSIDE.length} families, ` +
      `above the ceiling of ${MAX_ALLOWED_FAMILIES}. It must only shrink.`,
  );
  const unlisted = present.filter(
    f => !ALLOWED_FAMILIES_IMPORTED_FROM_OUTSIDE.includes(f),
  );
  assert.deepEqual(
    unlisted,
    [],
    `New family folders under api/src/connectors are not allowed. A new ` +
      `connector is a workspace connector (connectors/<slug>/ in the repo):\n  ` +
      unlisted.join("\n  "),
  );
  const stale = ALLOWED_FAMILIES_IMPORTED_FROM_OUTSIDE.filter(
    f => !present.includes(f),
  );
  assert.deepEqual(
    stale,
    [],
    `connector-family-allowlist.ts lists families whose folder is gone. ` +
      `Delete these lines:\n  ${stale.join("\n  ")}`,
  );

  const bad = violations(walk(SRC_ROOT));
  assert.deepEqual(
    bad,
    [],
    `Code outside api/src/connectors/<family>/ imports a family that is not ` +
      `on the allowlist. Import through the connection gateway or a workspace ` +
      `connector instead. Never add a family to the allowlist:\n  ${bad.join("\n  ")}`,
  );

  console.log(
    `connector family boundary: ${present.length} families, ` +
      `${ALLOWED_FAMILIES_IMPORTED_FROM_OUTSIDE.length} allowlisted`,
  );
}

main();
