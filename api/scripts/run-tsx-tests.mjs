#!/usr/bin/env node
// Runs every tsx-style test in api/src (bare node:assert scripts and
// node:test files) without a hand-maintained list.
//
//   node --import tsx scripts/run-tsx-tests.mjs [options] [filter...]
//
// Discovery: every src/**/*.test.ts, minus the files a vitest config owns
// (read from the configs' own include/exclude, so it cannot drift), minus
// the deliberate skips below. A leftover file that imports vitest is
// reported, not run: outside vitest it throws at import.
//
// Each file runs in its own `node --import tsx` process, with bounded
// concurrency. Every failure is collected and reported at the end; one red
// file no longer hides the rest the way the `&&` chain in `test` does.
//
// Options:
//   --concurrency N | -j N   parallel files (default: TSX_TEST_CONCURRENCY,
//                            else min(4, available CPUs))
//   --timeout S              per-file timeout in seconds (default 600)
//   --list                   print the files that would run, and exit
//   --compare                diff the discovered set against the `test`
//                            script's tsx chain, and exit
//   filter...                only files whose path contains one of these
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// Files no runner should pick up, each with its reason. Keep in step with
// DELIBERATELY_UNCOVERED in src/test-coverage.test.ts.
const SKIP = {
  "src/apps/sandbox/e2b-provider.integration.test.ts":
    "needs E2B credentials and a network; never part of an offline run",
};

const VITEST_CONFIGS = [
  "vitest.config.ts",
  "vitest.apps.config.ts",
  "vitest.destinations.config.ts",
];

// ── args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = {
  concurrency:
    Number(process.env.TSX_TEST_CONCURRENCY) ||
    Math.min(4, os.availableParallelism?.() ?? os.cpus().length),
  timeoutMs: 600_000,
  list: false,
  compare: false,
  filters: [],
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--concurrency" || a === "-j") opts.concurrency = Number(argv[++i]);
  else if (a === "--timeout") opts.timeoutMs = Number(argv[++i]) * 1000;
  else if (a === "--list") opts.list = true;
  else if (a === "--compare") opts.compare = true;
  else if (a.startsWith("-")) {
    console.error(`run-tsx-tests: unknown option ${a}`);
    process.exit(2);
  } else opts.filters.push(a);
}
if (!(opts.concurrency >= 1)) opts.concurrency = 1;

// ── discovery ───────────────────────────────────────────────────────
// Same small glob vocabulary as src/test-coverage.test.ts (`**/`, `**`,
// `*`, literals); anything richer fails loudly rather than mis-matching.
function globToRegExp(pattern) {
  if (/[[\]{}()!+@]|\?/.test(pattern)) {
    throw new Error(`run-tsx-tests: unsupported glob syntax in ${pattern}`);
  }
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if ("\\^$.|+".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (file, patterns) =>
  patterns.some(p => globToRegExp(p).test(file));

function allTestFiles(dir = "src", acc = []) {
  for (const e of readdirSync(path.join(API_ROOT, dir), {
    withFileTypes: true,
  })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist")
        allTestFiles(rel, acc);
    } else if (e.name.endsWith(".test.ts")) acc.push(rel);
  }
  return acc.sort();
}

async function vitestOwned() {
  // The destinations config only collects its *.integration.test.ts files
  // under RUN_DB_INTEGRATION; those are still vitest's, so read the gated
  // form. Restore the variable so it never leaks into the test processes.
  const saved = process.env.RUN_DB_INTEGRATION;
  process.env.RUN_DB_INTEGRATION = "1";
  const runners = [];
  try {
    for (const cfg of VITEST_CONFIGS) {
      const mod = await import(pathToFileURL(path.join(API_ROOT, cfg)).href);
      const test = (mod.default?.default ?? mod.default)?.test;
      if (!test?.include?.length) {
        throw new Error(
          `run-tsx-tests: could not read test.include from ${cfg}`,
        );
      }
      runners.push({
        include: test.include,
        exclude: (test.exclude ?? []).filter(
          p => p !== "**/node_modules/**" && p !== "**/dist/**",
        ),
      });
    }
  } finally {
    if (saved === undefined) delete process.env.RUN_DB_INTEGRATION;
    else process.env.RUN_DB_INTEGRATION = saved;
  }
  return file =>
    runners.some(
      r => matchesAny(file, r.include) && !matchesAny(file, r.exclude),
    );
}

function chainEntries() {
  const pkg = JSON.parse(
    readFileSync(path.join(API_ROOT, "package.json"), "utf8"),
  );
  return [
    ...(pkg.scripts.test ?? "").matchAll(/tsx\s+(src\/[^\s&|]+\.test\.ts)/g),
  ].map(m => m[1]);
}

const ownedByVitest = await vitestOwned();
const notVitestOwned = allTestFiles().filter(f => !ownedByVitest(f));
// A real import statement (single- or multi-line), not a mention in a comment.
const importsVitest = f =>
  /^(?:import\b|\}).*from\s+["']vitest["']/m.test(
    readFileSync(path.join(API_ROOT, f), "utf8"),
  );
const orphanedVitest = notVitestOwned.filter(
  f => !(f in SKIP) && importsVitest(f),
);
let files = notVitestOwned.filter(f => !(f in SKIP) && !importsVitest(f));
if (opts.filters.length) {
  files = files.filter(f => opts.filters.some(x => f.includes(x)));
}

if (opts.compare) {
  const chain = new Set(chainEntries());
  const found = new Set(files);
  const onlyHere = files.filter(f => !chain.has(f));
  const onlyChain = [...chain].filter(f => !found.has(f));
  console.log(`discovered ${files.length}, 'test' chain ${chain.size}`);
  console.log(`run here but not in the chain (${onlyHere.length}):`);
  for (const f of onlyHere) console.log(`  ${f}`);
  console.log(`in the chain but not discovered here (${onlyChain.length}):`);
  for (const f of onlyChain) console.log(`  ${f}`);
  process.exit(onlyChain.length ? 1 : 0);
}
if (opts.list) {
  for (const f of files) console.log(f);
  process.exit(0);
}

// ── run ─────────────────────────────────────────────────────────────
function runOne(file) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", "tsx", file], {
      cwd: API_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", c => chunks.push(c));
    child.stderr.on("data", c => chunks.push(c));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        file,
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        ms: Date.now() - started,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    });
  });
}

const results = [];
let next = 0;
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    const r = await runOne(file);
    results.push(r);
    const secs = (r.ms / 1000).toFixed(1);
    console.log(`${r.ok ? "ok  " : "FAIL"} ${file} (${secs}s)`);
  }
}

const t0 = Date.now();
console.log(
  `run-tsx-tests: ${files.length} files, concurrency ${opts.concurrency}` +
    (orphanedVitest.length
      ? `, ${orphanedVitest.length} vitest file(s) skipped`
      : ""),
);
await Promise.all(
  Array.from({ length: Math.min(opts.concurrency, files.length) }, worker),
);

const failed = results
  .filter(r => !r.ok)
  .sort((a, b) => a.file.localeCompare(b.file));
for (const r of failed) {
  const why = r.timedOut
    ? `timed out after ${opts.timeoutMs / 1000}s`
    : r.signal
      ? `killed by ${r.signal}`
      : `exit code ${r.code}`;
  console.log(`\n━━━ FAIL ${r.file} (${why}) ━━━\n${r.output.trimEnd()}`);
}
if (orphanedVitest.length) {
  console.log(
    `\nThese import vitest but no vitest config includes them, so nothing runs them` +
      ` (src/test-coverage.test.ts flags this too):\n  ${orphanedVitest.join("\n  ")}`,
  );
}
const total = ((Date.now() - t0) / 1000).toFixed(1);
console.log(
  `\nrun-tsx-tests: ${results.length - failed.length} passed, ${failed.length} failed` +
    ` in ${total}s` +
    (failed.length ? `\n  ${failed.map(r => r.file).join("\n  ")}` : ""),
);
process.exit(failed.length || orphanedVitest.length ? 1 : 0);
