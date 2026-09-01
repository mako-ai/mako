/**
 * Every test file must be run by SOMETHING.
 *
 * `api/` has four test runners and each keeps its own hand-maintained list:
 *
 *   test              — an `&&` chain of `tsx <file>` calls in package.json
 *   test:dbt          — vitest.config.ts
 *   test:apps         — vitest.apps.config.ts
 *   test:destinations — vitest.destinations.config.ts
 *
 * A new `*.test.ts` is therefore run only if a human remembers to add it to
 * the right one of four places, and nothing ever complained when they didn't.
 * `bigquery-abandoned-job.test.ts` is what that looks like: written, correct,
 * asserting real behaviour, and never executed once.
 *
 * This guard turns the next forgotten test into a failing build. It reads the
 * three vitest configs at runtime rather than restating their patterns, so it
 * cannot drift out of sync with them.
 *
 * Run: tsx src/test-coverage.test.ts          (fails on an uncovered file)
 *      tsx src/test-coverage.test.ts --report (prints the full census)
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const API_ROOT = path.resolve(__dirname, "..");

/**
 * Files deliberately run by no runner. Every entry needs a reason — an
 * unexplained entry here is indistinguishable from the bug this guard exists
 * to catch. Prefer wiring a test in over adding it here.
 */
const DELIBERATELY_UNCOVERED: Readonly<Record<string, string>> = {
  "src/apps/sandbox/e2b-provider.integration.test.ts":
    "Needs E2B credentials and a network, and self-skips without E2B_API_KEY. " +
    "Must never join an offline run — vitest.apps.config.ts documents the " +
    "same exclusion.",
};

// ── Glob matching ─────────────────────────────────────────────────
//
// The configs use a deliberately small vocabulary: `**/`, `**`, `*` and
// literals. Rather than depend on a glob engine (tinyglobby is vitest's, not
// api's), we translate that vocabulary directly — and REFUSE anything outside
// it, so an exotic pattern fails loudly here instead of being silently
// mis-resolved into a false "covered".
const UNSUPPORTED_GLOB_SYNTAX = /[[\]{}()!+@]|\?/;

export function globToRegExp(pattern: string): RegExp {
  assert.ok(
    !UNSUPPORTED_GLOB_SYNTAX.test(pattern),
    `test-coverage guard: pattern ${JSON.stringify(pattern)} uses glob syntax ` +
      `this guard cannot resolve. Extend globToRegExp (and its self-test) ` +
      `rather than leaving coverage unverified.`,
  );
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?"; // `**/` spans zero or more directories
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*"; // `*` never crosses a directory boundary
      }
    } else if ("\\^$.|+".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

const matchesAny = (file: string, patterns: string[]) =>
  patterns.some(p => globToRegExp(p).test(file));

// ── Where does an orphan actually belong? ─────────────────────────
//
// "Covered by no runner" reads as "add it to the `test` chain", and for a
// vitest-style suite that is the WRONG fix: `import { describe } from "vitest"`
// outside a vitest run throws at import, so wiring it as a tsx entry turns
// "never runs" into "always red" — at the top of an `&&` chain, taking every
// test after it down too. So the guard names the destination instead of
// leaving the reader to guess, and says so plainly when it cannot tell.

type Style = "vitest" | "tsx" | "unknown";

function styleOf(file: string): Style {
  const src = readFileSync(path.join(API_ROOT, file), "utf8");
  if (/from\s+["']vitest["']/.test(src)) return "vitest";
  if (/from\s+["']node:assert/.test(src)) return "tsx";
  return "unknown";
}

/**
 * Which vitest config already owns this file's area, judged by the directories
 * its include patterns actually reach. Returns null rather than guessing when
 * no config covers the path — picking one is then a deliberate choice.
 */
function suggestVitestConfig(
  file: string,
  runners: Array<{ name: string; include: string[] }>,
): string | null {
  const dir = path.posix.dirname(file);
  const configFile: Record<string, string> = {
    "test:dbt": "vitest.config.ts",
    "test:apps": "vitest.apps.config.ts",
    "test:destinations": "vitest.destinations.config.ts",
  };
  for (const r of runners) {
    const reaches = r.include.some(p => path.posix.dirname(p) === dir);
    if (reaches) return configFile[r.name] ?? r.name;
  }
  return null;
}

export function describeDestination(
  file: string,
  runners: Array<{ name: string; include: string[] }>,
): string {
  switch (styleOf(file)) {
    case "vitest": {
      const cfg = suggestVitestConfig(file, runners);
      return cfg
        ? `vitest-style → add to ${cfg} include`
        : `vitest-style → add to a vitest config's include (no existing ` +
            `config covers this directory; choose one deliberately). Do NOT ` +
            `add it to the 'test' chain — it throws at import outside vitest.`;
    }
    case "tsx":
      return "tsx-style → add `&& tsx <file>` to the 'test' script";
    default:
      return (
        "UNKNOWN style — imports neither vitest nor node:assert. Work out " +
        "how it is meant to run before wiring it anywhere."
      );
  }
}

// ── Inputs ────────────────────────────────────────────────────────

function allTestFiles(dir = "src", acc: string[] = []): string[] {
  for (const entry of readdirSync(path.join(API_ROOT, dir), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      allTestFiles(rel, acc);
    } else if (entry.name.endsWith(".test.ts")) {
      acc.push(rel);
    }
  }
  return acc.sort();
}

/** The `tsx a && tsx b && …` chain, as a list (duplicates preserved). */
function tsxChainEntries(): string[] {
  const pkg = JSON.parse(
    readFileSync(path.join(API_ROOT, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  return [...pkg.scripts.test.matchAll(/tsx\s+(src\/[^\s&|]+\.test\.ts)/g)].map(
    m => m[1],
  );
}

interface VitestConfig {
  default?: { test?: { include?: string[]; exclude?: string[] } };
}

async function vitestRunners(): Promise<
  Array<{ name: string; include: string[]; exclude: string[] }>
> {
  // Resolve the destinations config as its GATED form. Its integration specs
  // are excluded from the default offline run but are collected under
  // RUN_DB_INTEGRATION=1 — that is a supported invocation, so those files are
  // covered, not orphaned. Set before importing: the config reads env at
  // module scope and module results are cached.
  process.env.RUN_DB_INTEGRATION = "1";
  const files = [
    ["test:dbt", "../vitest.config"],
    ["test:apps", "../vitest.apps.config"],
    ["test:destinations", "../vitest.destinations.config"],
  ] as const;

  const runners = [];
  for (const [name, spec] of files) {
    const mod = (await import(spec)) as VitestConfig;
    const test = mod.default?.test;
    assert.ok(
      test?.include?.length,
      `${name}: could not read test.include from ${spec} — the guard would ` +
        `silently report its files as uncovered.`,
    );
    runners.push({
      name,
      include: test.include,
      exclude: (test.exclude ?? []).filter(
        // Hygiene excludes, not coverage decisions.
        p => p !== "**/node_modules/**" && p !== "**/dist/**",
      ),
    });
  }
  return runners;
}

// ── The guard ─────────────────────────────────────────────────────

function selfTest() {
  const cases: Array<[string, string, boolean]> = [
    ["src/dbt/**/*.test.ts", "src/dbt/a.test.ts", true],
    ["src/dbt/**/*.test.ts", "src/dbt/deep/nested/a.test.ts", true],
    ["src/dbt/**/*.test.ts", "src/other/a.test.ts", false],
    ["src/a/dbt-*.test.ts", "src/a/dbt-run.test.ts", true],
    ["src/a/dbt-*.test.ts", "src/a/dbt/run.test.ts", false],
    ["**/*.integration.test.ts", "src/x/y.integration.test.ts", true],
    ["**/*.integration.test.ts", "src/x/y.test.ts", false],
    ["**/node_modules/**", "a/node_modules/b/c.ts", true],
    ["src/exact.test.ts", "src/exact.test.ts", true],
    ["src/exact.test.ts", "src/exactXtest.ts", false],
  ];
  for (const [pattern, file, expected] of cases) {
    assert.equal(
      globToRegExp(pattern).test(file),
      expected,
      `glob ${pattern} vs ${file}`,
    );
  }
}

/**
 * The advice has to be right, not merely present: sending a vitest suite to
 * the tsx chain turns "never runs" into "always red". Pinned against two real
 * files of each style, so a refactor of styleOf cannot quietly invert it.
 */
async function selfTestDestinations(
  runners: Array<{ name: string; include: string[] }>,
) {
  const vitestStyle = "src/apps/repository.service.test.ts";
  const tsxStyle = "src/services/realtime.service.test.ts";

  const forVitest = describeDestination(vitestStyle, runners);
  assert.match(forVitest, /vitest-style/, `${vitestStyle} is a vitest suite`);
  assert.match(
    forVitest,
    /vitest\.apps\.config\.ts/,
    "and its directory is already owned by the apps config",
  );
  assert.doesNotMatch(
    forVitest,
    /'test' script/,
    "a vitest suite must never be sent to the tsx chain",
  );

  assert.match(
    describeDestination(tsxStyle, runners),
    /tsx-style/,
    `${tsxStyle} is a node:assert suite`,
  );
}

export async function computeCoverage() {
  const files = allTestFiles();
  const chain = tsxChainEntries();
  const runners = await vitestRunners();
  const chainSet = new Set(chain);

  const ownersOf = (file: string) => {
    const owners: string[] = [];
    if (chainSet.has(file)) owners.push("test");
    for (const r of runners) {
      if (matchesAny(file, r.include) && !matchesAny(file, r.exclude)) {
        owners.push(r.name);
      }
    }
    return owners;
  };

  return {
    files,
    chain,
    runners,
    ownersOf,
    uncovered: files.filter(f => ownersOf(f).length === 0),
    // A chain entry whose file no longer exists fails the whole `&&` chain.
    missingFromDisk: chain.filter(f => !files.includes(f)),
    duplicatedInChain: chain.filter((f, i) => chain.indexOf(f) !== i),
  };
}

async function main() {
  selfTest();
  const {
    files,
    uncovered,
    missingFromDisk,
    duplicatedInChain,
    ownersOf,
    runners,
  } = await computeCoverage();
  await selfTestDestinations(runners);

  if (process.argv.includes("--report")) {
    console.log(`${files.length} test files\n`);
    for (const f of files) {
      const owners = ownersOf(f);
      console.log(`${owners.length ? owners.join(",") : "NONE"}\t${f}`);
      if (!owners.length) {
        console.log(`\t\t${describeDestination(f, runners)}`);
      }
    }
    return;
  }

  assert.deepEqual(
    missingFromDisk,
    [],
    `The 'test' script runs files that do not exist. The chain is '&&'-joined, ` +
      `so this fails every test after it:\n  ${missingFromDisk.join("\n  ")}`,
  );
  assert.deepEqual(
    duplicatedInChain,
    [],
    `Duplicate entries in the 'test' script:\n  ${duplicatedInChain.join("\n  ")}`,
  );

  const unexplained = uncovered.filter(f => !(f in DELIBERATELY_UNCOVERED));
  assert.deepEqual(
    unexplained,
    [],
    `These test files are run by NO runner — they will never fail, however ` +
      `broken the code they cover. Each line names where it belongs:\n` +
      unexplained
        .map(f => `  ${f}\n      ${describeDestination(f, runners)}`)
        .join("\n") +
      `\nIf one is deliberately excluded, add it to DELIBERATELY_UNCOVERED ` +
      `with a reason instead.`,
  );

  const stale = Object.keys(DELIBERATELY_UNCOVERED).filter(
    f => !uncovered.includes(f),
  );
  assert.deepEqual(
    stale,
    [],
    `DELIBERATELY_UNCOVERED lists files that are now covered (or gone). ` +
      `Remove them so the list keeps meaning something:\n  ${stale.join("\n  ")}`,
  );

  console.log(
    `test coverage guard: ${files.length} test files, all run by a runner ` +
      `(${Object.keys(DELIBERATELY_UNCOVERED).length} deliberately excluded)`,
  );
}

void main();
