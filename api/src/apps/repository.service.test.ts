/**
 * Apps repository service — git substrate unit tests.
 *
 * Pure git-on-disk: no Mongo, no network. Run with
 * `pnpm --filter api run test:apps`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZERO_OID, assertSafeRelPath } from "./git";
import {
  DEFAULT_BRANCH,
  commitTree,
  diffNameStatus,
  globTree,
  grepTree,
  initRepo,
  listTree,
  log,
  readBlob,
  resolveCommit,
  snapshotDirToTree,
  treeOfCommit,
  updateRefCas,
} from "./repository.service";
import { createAppsScaffold } from "./scaffold";

let tmpRoot: string;
let repoDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-repo-test-"));
  repoDir = path.join(tmpRoot, "repo.git");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("assertSafeRelPath", () => {
  it("accepts normal repo paths", () => {
    expect(assertSafeRelPath("src/App.tsx")).toBe("src/App.tsx");
    expect(assertSafeRelPath("a/b/c.txt")).toBe("a/b/c.txt");
  });

  it("rejects traversal, absolute, .git and NUL paths", () => {
    expect(() => assertSafeRelPath("../etc/passwd")).toThrow();
    expect(() => assertSafeRelPath("/etc/passwd")).toThrow();
    expect(() => assertSafeRelPath("a/../../b")).toThrow();
    expect(() => assertSafeRelPath(".git/config")).toThrow();
    expect(() => assertSafeRelPath("a/.git/config")).toThrow();
    expect(() => assertSafeRelPath("bad\0path")).toThrow();
    expect(() => assertSafeRelPath("")).toThrow();
  });
});

describe("initRepo + reads", () => {
  it("creates a bare repo seeded with the scaffold on main", async () => {
    const scaffold = createAppsScaffold({ title: "Test App" });
    const { commitOid } = await initRepo(repoDir, scaffold);

    const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
    expect(head).toBe(commitOid);

    const entries = await listTree(repoDir, DEFAULT_BRANCH);
    const paths = entries.map(e => e.path).sort();
    expect(paths).toContain("package.json");
    expect(paths).toContain("mako.json");
    expect(paths).toContain("src/App.tsx");
    expect(paths).toContain(".gitignore");

    const pkg = await readBlob(repoDir, DEFAULT_BRANCH, "package.json");
    expect(pkg.isBinary).toBe(false);
    const parsed = JSON.parse(pkg.contents) as {
      scripts: Record<string, string>;
    };
    expect(parsed.scripts.dev).toBe("vite");
  });

  it("hides refs/mako/* from transfer and allows any-sha fetches", async () => {
    await initRepo(repoDir, { "a.txt": "hello\n" });
    const cfg = (
      await fs.readFile(path.join(repoDir, "config"), "utf8")
    ).toLowerCase();
    expect(cfg).toContain("hiderefs = refs/mako/");
    expect(cfg).toContain("allowanysha1inwant = true");
  });
});

describe("snapshotDirToTree", () => {
  it("captures a work dir into a tree, respecting .gitignore", async () => {
    await initRepo(repoDir, {
      "a.txt": "one\n",
      ".gitignore": "node_modules\n",
    });

    const work = path.join(tmpRoot, "work");
    await fs.mkdir(path.join(work, "node_modules", "junk"), {
      recursive: true,
    });
    await fs.writeFile(path.join(work, ".gitignore"), "node_modules\n");
    await fs.writeFile(path.join(work, "a.txt"), "two\n");
    await fs.writeFile(
      path.join(work, "node_modules", "junk", "index.js"),
      "ignored",
    );

    const tree = await snapshotDirToTree(repoDir, work);
    const commit = await commitTree(repoDir, {
      treeOid: tree,
      parents: [],
      message: "snap",
    });
    const entries = await listTree(repoDir, commit);
    const paths = entries.map(e => e.path);
    expect(paths).toContain("a.txt");
    expect(paths.some(p => p.startsWith("node_modules/"))).toBe(false);

    const a = await readBlob(repoDir, commit, "a.txt");
    expect(a.contents).toBe("two\n");
  });
});

describe("updateRefCas", () => {
  it("applies only when the expected old value matches", async () => {
    const { commitOid: c1 } = await initRepo(repoDir, { "a.txt": "1\n" });

    const work = path.join(tmpRoot, "w2");
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(path.join(work, "a.txt"), "2\n");
    const t2 = await snapshotDirToTree(repoDir, work);
    const c2 = await commitTree(repoDir, {
      treeOid: t2,
      parents: [c1],
      message: "second",
    });

    const ref = "refs/mako/worktrees/test";
    // Create (must-not-exist CAS).
    expect(await updateRefCas(repoDir, ref, c1, ZERO_OID)).toBe(true);
    // Re-create must fail — the ref exists now.
    expect(await updateRefCas(repoDir, ref, c2, ZERO_OID)).toBe(false);
    // Advance with the right old value.
    expect(await updateRefCas(repoDir, ref, c2, c1)).toBe(true);
    // Stale writer (expects c1) must lose.
    expect(await updateRefCas(repoDir, ref, c1, c1)).toBe(false);
    expect(await resolveCommit(repoDir, ref)).toBe(c2);
  });
});

describe("grepTree + globTree (sandbox-free search)", () => {
  it("greps contents and globs paths straight from the object db", async () => {
    await initRepo(repoDir, {
      "src/App.tsx":
        "export default function App() {\n  return <h1>Hi</h1>;\n}\n",
      "src/util.ts": "export const answer = 42;\n",
      "src/nested/deep.tsx": "export const Deep = () => null;\n",
      "README.md": "# hello\n",
    });

    const grep = await grepTree(
      repoDir,
      DEFAULT_BRANCH,
      "export (default|const)",
    );
    const grepPaths = grep.map(m => m.path).sort();
    expect(grepPaths).toContain("src/App.tsx");
    expect(grepPaths).toContain("src/util.ts");
    expect(grepPaths).not.toContain("README.md");
    // Line numbers + text are captured.
    const answerHit = grep.find(m => m.text.includes("answer"));
    expect(answerHit?.line).toBe(1);

    // No matches -> empty (git grep exits 1, not an error).
    expect(await grepTree(repoDir, DEFAULT_BRANCH, "nonexistent_zzz")).toEqual(
      [],
    );

    // Glob: ** crosses directories, * does not.
    const tsx = await globTree(repoDir, DEFAULT_BRANCH, "src/**/*.tsx");
    expect(tsx.sort()).toEqual(["src/App.tsx", "src/nested/deep.tsx"]);
    const topTs = await globTree(repoDir, DEFAULT_BRANCH, "src/*.ts");
    expect(topTs).toEqual(["src/util.ts"]);
    const all = await globTree(repoDir, DEFAULT_BRANCH, "**/*.md");
    expect(all).toEqual(["README.md"]);
  });
});

describe("history + diff", () => {
  it("reports commits and name-status changes", async () => {
    const { commitOid: c1 } = await initRepo(repoDir, {
      "a.txt": "1\n",
      "b.txt": "b\n",
    });

    const work = path.join(tmpRoot, "w3");
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(path.join(work, "a.txt"), "changed\n");
    await fs.writeFile(path.join(work, "c.txt"), "new\n");
    // b.txt deleted (absent from the work dir).
    const t2 = await snapshotDirToTree(repoDir, work);
    const c2 = await commitTree(repoDir, {
      treeOid: t2,
      parents: [c1],
      message: "edit",
    });
    await updateRefCas(repoDir, `refs/heads/${DEFAULT_BRANCH}`, c2, c1);

    const commits = await log(repoDir, DEFAULT_BRANCH, 10);
    expect(commits.map(c => c.subject)).toEqual(["edit", "Initial scaffold"]);

    const changes = await diffNameStatus(repoDir, c1, c2);
    const byPath = Object.fromEntries(changes.map(ch => [ch.path, ch.status]));
    expect(byPath["a.txt"]).toBe("modified");
    expect(byPath["b.txt"]).toBe("deleted");
    expect(byPath["c.txt"]).toBe("added");

    expect(await treeOfCommit(repoDir, c2)).toBe(t2);
  });
});
