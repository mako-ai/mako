/**
 * Shared helpers for the graceful-rename SCENARIO suites (flows, dbt jobs).
 *
 * Not a test file: the `*.scenarios.test.ts` files next to it own their
 * `vi.mock`s (vitest hoists them per file) and import these helpers, which
 * then see the mocked modules like any other import in the graph.
 *
 * What lives here is the part every scenario repeats: a laptop clone that
 * really runs `git mv` / `git push` against the workspace's bare repo, reads
 * of what main holds, what a commit touched, and a timer for the scale
 * checks.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runGit } from "../../apps/git";
import {
  DEFAULT_BRANCH,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";

export const MAIN_REF = `refs/heads/${DEFAULT_BRANCH}`;

export async function headOf(workspaceId: string): Promise<string> {
  return (await resolveCommit(repoDirFor(workspaceId), MAIN_REF)) as string;
}

/** The file at main, or null when it is not there. */
export async function fileAtMain(
  workspaceId: string,
  rel: string,
): Promise<string | null> {
  const head = await resolveCommit(repoDirFor(workspaceId), MAIN_REF);
  if (!head) return null;
  try {
    return (await readBlob(repoDirFor(workspaceId), head, rel)).contents;
  } catch {
    return null;
  }
}

/** Every path at main under `prefix` (recursive), sorted. */
export async function pathsAtMain(
  workspaceId: string,
  prefix: string,
): Promise<string[]> {
  const { stdout } = await runGit([
    "-C",
    repoDirFor(workspaceId),
    "ls-tree",
    "-r",
    "--name-only",
    DEFAULT_BRANCH,
    "--",
    prefix || ".",
  ]);
  return stdout.split("\n").filter(Boolean).sort();
}

export async function commitCountOf(workspaceId: string): Promise<number> {
  const { stdout } = await runGit([
    "-C",
    repoDirFor(workspaceId),
    "rev-list",
    "--count",
    DEFAULT_BRANCH,
  ]);
  return Number(stdout.trim());
}

/** The paths a commit touched (both sides of a rename), sorted. */
export async function pathsTouchedBy(
  workspaceId: string,
  commit: string,
): Promise<string[]> {
  const { stdout } = await runGit([
    "-C",
    repoDirFor(workspaceId),
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "--no-renames",
    "-r",
    `${commit}^`,
    commit,
  ]);
  return stdout.split("\n").filter(Boolean).sort();
}

/**
 * Instance B: its main is `commit` and the objects it never fetched are
 * gone — the "another instance" simulation of flow-sync.repo.test.ts.
 */
export async function becomeStaleInstance(
  workspaceId: string,
  commit: string,
): Promise<void> {
  const dir = repoDirFor(workspaceId);
  await runGit(["-C", dir, "update-ref", MAIN_REF, commit]);
  await runGit(["-C", dir, "reflog", "expire", "--expire=now", "--all"]);
  await runGit(["-C", dir, "gc", "--prune=now", "-q"]);
}

/** Wind main to `commit` without dropping any object (a lost mirror push). */
export async function resetMainTo(
  workspaceId: string,
  commit: string,
): Promise<void> {
  await runGit(["-C", repoDirFor(workspaceId), "update-ref", MAIN_REF, commit]);
}

const LAPTOP_IDENTITY = [
  "-c",
  "user.name=laptop",
  "-c",
  "user.email=laptop@example.com",
  "-c",
  "commit.gpgsign=false",
];

/**
 * A real working clone of the workspace repo, as a person's laptop has it:
 * `git mv`, edits, `git commit`, `git push` — the push lands in the bare
 * repo exactly as Mako's git endpoint would receive it (fast-forward only;
 * a stale push is rejected by git itself). The caller then runs the push
 * sync the endpoint triggers.
 */
export class Laptop {
  private constructor(
    readonly dir: string,
    private readonly workspaceId: string,
  ) {}

  static async clone(workspaceId: string, root: string): Promise<Laptop> {
    await fs.mkdir(root, { recursive: true });
    const dir = await fs.mkdtemp(path.join(root, "laptop-"));
    await runGit(["clone", "-q", repoDirFor(workspaceId), dir]);
    return new Laptop(dir, workspaceId);
  }

  async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return runGit([...LAPTOP_IDENTITY, "-C", this.dir, ...args]);
  }

  /** `git mv`; `{ force }` is `git mv -f` (overwrite an existing file). */
  async mv(from: string, to: string, options: { force?: boolean } = {}) {
    await fs.mkdir(path.dirname(path.join(this.dir, to)), { recursive: true });
    await this.git(["mv", ...(options.force ? ["-f"] : []), from, to]);
  }

  async write(rel: string, contents: string): Promise<void> {
    const abs = path.join(this.dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents, "utf8");
    await this.git(["add", "--", rel]);
  }

  async read(rel: string): Promise<string> {
    return fs.readFile(path.join(this.dir, rel), "utf8");
  }

  async rm(rel: string): Promise<void> {
    await this.git(["rm", "-q", "--", rel]);
  }

  async copy(from: string, to: string): Promise<void> {
    await this.write(to, await this.read(from));
  }

  async commit(message: string): Promise<void> {
    await this.git(["commit", "-q", "-m", message]);
  }

  /** Push main; `ok: false` with git's reason when it is refused. */
  async push(): Promise<{ ok: boolean; stderr: string }> {
    try {
      await this.git(["push", "-q", "origin", `HEAD:${DEFAULT_BRANCH}`]);
      return { ok: true, stderr: "" };
    } catch (error) {
      const stderr =
        (error as { stderr?: string }).stderr ??
        (error instanceof Error ? error.message : String(error));
      return { ok: false, stderr };
    }
  }

  /** `git pull --rebase` from the workspace repo. */
  async pull(): Promise<void> {
    await this.git(["pull", "-q", "--rebase", "origin", DEFAULT_BRANCH]);
  }

  get workspace(): string {
    return this.workspaceId;
  }
}

/**
 * A history of `count` commits on main, made with `git fast-import` (one
 * process, not `count` plumbing round-trips) — the scale checks need
 * thousands. Each commit rewrites `filler/<i % 50>.txt`; `files` are added
 * in the first commit.
 */
export async function fastImportHistory(
  workspaceId: string,
  args: { count: number; files?: Record<string, string> },
): Promise<void> {
  const dir = repoDirFor(workspaceId);
  const parent = await resolveCommit(dir, MAIN_REF);
  const chunks: string[] = [];
  const when = Math.floor(Date.now() / 1000) - args.count;
  for (let i = 0; i < args.count; i++) {
    const msg = `filler ${i}`;
    chunks.push(`commit ${MAIN_REF}`);
    chunks.push(`committer filler <filler@example.com> ${when + i} +0000`);
    chunks.push(`data ${Buffer.byteLength(msg)}`);
    chunks.push(msg);
    if (i === 0 && parent) chunks.push(`from ${parent}`);
    const files =
      i === 0 ? Object.entries(args.files ?? {}) : ([] as [string, string][]);
    files.push([`filler/${i % 50}.txt`, `${i}\n`]);
    for (const [rel, contents] of files) {
      chunks.push(`M 100644 inline ${rel}`);
      chunks.push(`data ${Buffer.byteLength(contents)}`);
      chunks.push(contents);
    }
    chunks.push("");
  }
  await runGit(["-C", dir, "fast-import", "--quiet", "--force"], {
    stdin: chunks.join("\n") + "\n",
    timeoutMs: 300_000,
    maxBufferBytes: 64 * 1024 * 1024,
  });
}

/** Wall-clock milliseconds of `fn`, with its result. */
export async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - start), value };
}

/** Recorded scale timings, printed once per suite (the report quotes them). */
export const scaleTimings: Array<{ label: string; ms: number }> = [];
export function recordTiming(label: string, ms: number): void {
  scaleTimings.push({ label, ms });
  // eslint-disable-next-line no-console
  console.log(`[scale] ${label}: ${ms} ms`);
}

export function tmpRootFor(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

/**
 * Hostile names the scenario suites feed to every rename entry point. A
 * kind's slug rule decides which ones are refused; the title rule is shared.
 */
export const HOSTILE_SLUGS: ReadonlyArray<[label: string, slug: string]> = [
  ["empty", ""],
  ["whitespace only", "   "],
  ["dot-dot", ".."],
  ["dot", "."],
  ["slash", "/"],
  ["backslash", "\\"],
  ["double slash", "//"],
  ["leading slash", "/abs"],
  ["nested path", "a/b"],
  ["backslash path", "a\\b"],
  ["parent escape", "../escape"],
  ["tilde", "~"],
  ["home path", "~/x"],
  ["encoded dot-dot", "%2e%2e"],
  ["encoded slash", "a%2Fb"],
  ["upper case", "Upper-Case"],
  ["unicode e-acute (NFC)", "caf\u00E9"],
  ["unicode e + combining acute (NFD)", "cafe\u0301"],
  ["emoji", "rocket-\u{1F680}"],
  ["zero-width", "a\u200Bb"],
  ["RTL override", "\u202Eabc"],
  ["NUL", "a\u0000b"],
  ["control char", "a\u0007b"],
  ["newline", "a\nb"],
  ["colon", "a:b"],
  ["asterisk", "a*b"],
  ["question mark", "a?b"],
  ["double quote", 'a"b'],
  ["angle brackets", "a<b>"],
  ["pipe", "a|b"],
  ["trailing dot", "abc."],
  ["double dash", "a--b"],
  ["leading dash", "-a"],
  ["trailing dash", "a-"],
  ["Windows reserved CON", "con"],
  ["Windows reserved AUX", "aux"],
  ["Windows reserved NUL", "nul"],
  ["Windows reserved PRN", "prn"],
  ["Windows reserved COM1", "com1"],
  ["Windows reserved LPT9", "lpt9"],
  ["24-hex id lookalike", "0123456789abcdef01234567"],
  ["ws: prefix", "ws:x"],
  ["binding: prefix", "binding:x"],
  ["65 chars", "a".repeat(65)],
  ["255 chars", "a".repeat(255)],
  ["1000 chars", "a".repeat(1000)],
];

/** Slugs that look odd but are legitimate file names: accepted. */
export const ODD_BUT_VALID_SLUGS: ReadonlyArray<string> = [
  "flows",
  "apps",
  "users",
  "consoles",
  "skills",
  "dbt",
  "connectors",
  "a".repeat(64),
  "con-1",
  "com10",
  "0123456789abcdef0123456", // 23 hex: not an id
];

export const HOSTILE_TITLES: ReadonlyArray<
  [label: string, title: string, expect: "refused" | string]
> = [
  ["empty", "", "refused"],
  ["whitespace only", "   \t ", "refused"],
  ["zero-width only", "\u200B\u200C\uFEFF", "refused"],
  ["NUL", "a\u0000b", "refused"],
  ["bell", "a\u0007b", "refused"],
  ["newline", "line one\nline two", "refused"],
  ["carriage return", "a\rb", "refused"],
  ["tab", "a\tb", "refused"],
  ["DEL", "a\u007Fb", "refused"],
  ["C1 control", "a\u0085b", "refused"],
  ["line separator", "a\u2028b", "refused"],
  ["RTL override", "\u202Egnp.exe", "refused"],
  ["bidi isolate", "a\u2066b\u2069", "refused"],
  ["1000 chars", "x".repeat(1000), "refused"],
  ["10000 chars", "x".repeat(10000), "refused"],
  ["padded", "  Padded name  ", "Padded name"],
  ["NFD e-acute", "Cafe\u0301 sync", "Caf\u00E9 sync"],
  [
    "emoji",
    "\u{1F4C8} Revenue \u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
    "\u{1F4C8} Revenue \u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
  ],
  ["RTL script", "תזרים مبيعات", "תזרים مبيعات"],
  ["path tricks", "../../etc/passwd", "../../etc/passwd"],
  ["Windows-invalid chars", 'a: * ? " < > | b', 'a: * ? " < > | b'],
  [
    "YAML-special",
    "- [x]: {y} # z & *a !b %c @d `e",
    "- [x]: {y} # z & *a !b %c @d `e",
  ],
  ["looks like an id", "0123456789abcdef01234567", "0123456789abcdef01234567"],
  ["quotes", `it's "quoted"`, `it's "quoted"`],
];
