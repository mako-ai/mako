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
import { ZERO_OID, assertSafeRelPath, runGitBuffer } from "./git";
import {
  BlobPreconditionError,
  DEFAULT_BRANCH,
  blobOid,
  blobOidAt,
  commitBlobsOnBranch,
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

describe("commitBlobsOnBranch expectBlobs (compare-and-swap on content)", () => {
  it("refuses a mutation whose read-side file changed or whose new path appeared, and commits otherwise", async () => {
    const { commitOid: c1 } = await initRepo(repoDir, {
      "flows/a.yml": "name: A\n",
    });
    const aOid = blobOid("name: A\n");
    expect(await blobOidAt(repoDir, c1, "flows/a.yml")).toBe(aOid);
    expect(await blobOidAt(repoDir, c1, "flows/b.yml")).toBeNull();

    // Someone else edits a.yml first.
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes: { "flows/a.yml": "name: A edited\n" } },
      { message: "edit" },
    );
    const headBefore = await resolveCommit(
      repoDir,
      `refs/heads/${DEFAULT_BRANCH}`,
    );
    // A move decided from the ORIGINAL a.yml must not re-apply on top.
    await expect(
      commitBlobsOnBranch(
        repoDir,
        DEFAULT_BRANCH,
        { writes: { "flows/b.yml": "name: B\n" }, deletes: ["flows/a.yml"] },
        {
          message: "mv",
          expectBlobs: { "flows/a.yml": aOid, "flows/b.yml": null },
        },
      ),
    ).rejects.toBeInstanceOf(BlobPreconditionError);
    expect(await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`)).toBe(
      headBefore,
    );

    // Decided from the current a.yml: applies.
    const edited = blobOid("name: A edited\n");
    const moved = await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes: { "flows/b.yml": "name: B\n" }, deletes: ["flows/a.yml"] },
      {
        message: "mv",
        expectBlobs: { "flows/a.yml": edited, "flows/b.yml": null },
      },
    );
    expect(moved.unchanged).toBe(false);
    expect(await blobOidAt(repoDir, moved.commitOid, "flows/a.yml")).toBeNull();
    expect(await blobOidAt(repoDir, moved.commitOid, "flows/b.yml")).toBe(
      blobOid("name: B\n"),
    );

    // "Must be absent" fails once the path exists.
    await expect(
      commitBlobsOnBranch(
        repoDir,
        DEFAULT_BRANCH,
        { writes: { "flows/b.yml": "name: B2\n" } },
        { message: "x", expectBlobs: { "flows/b.yml": null } },
      ),
    ).rejects.toMatchObject({ path: "flows/b.yml", expected: null });
  });
});

describe("commitBlobsOnBranch writes many blobs in one go, byte for byte", () => {
  it("CRLF, binary, non-UTF-8, empty, spaces and unicode in names, a symlink entry and an executable: exact bytes, oids, modes", async () => {
    await initRepo(repoDir, { "README.md": "x\n" });
    const files: Record<string, string | Buffer> = {
      "a/crlf.sql": "select 1\r\nfrom t\r\n",
      "a/binary.png": Buffer.from([0x89, 0x50, 0x00, 0xff, 0x00, 0x0a, 0x0d]),
      "a/latin1.sql": Buffer.from("-- caf\xe9\n", "latin1"),
      "a/empty.txt": "",
      "a/with space.md": "spaces\n",
      "a/café ☕.md": "unicode name\n",
      "a/run.sh": "#!/bin/sh\necho hi\n",
      "a/no-final-newline": "last line",
    };
    for (let i = 0; i < 40; i++) files[`bulk/f${i}.txt`] = `file ${i}\n`;
    const link = blobOid("crlf.sql");
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes: { "a/target.txt": "crlf.sql" } },
      { message: "a blob the symlink entry can point at" },
    );
    const { commitOid } = await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      {
        writes: files,
        modes: { "a/run.sh": "100755" },
        entries: [{ path: "a/link.sql", oid: link, mode: "120000" }],
      },
      { message: "many" },
    );
    const tree = new Map(
      (await listTree(repoDir, commitOid)).map(e => [e.path, e]),
    );
    for (const [p, contents] of Object.entries(files)) {
      const entry = tree.get(p);
      expect([p, entry?.oid]).toEqual([p, blobOid(contents)]);
      expect(entry?.mode).toBe(p === "a/run.sh" ? "100755" : "100644");
      const bytes = await runGitBuffer([
        "-C",
        repoDir,
        "cat-file",
        "blob",
        blobOid(contents),
      ]);
      const want = Buffer.isBuffer(contents)
        ? contents
        : Buffer.from(contents, "utf8");
      expect([p, bytes.equals(want)]).toEqual([p, true]);
    }
    expect(tree.get("a/link.sql")).toMatchObject({ oid: link, mode: "120000" });
  });

  it("one written file and none: same commit semantics", async () => {
    await initRepo(repoDir, { "README.md": "x\n" });
    const one = await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes: { "one.txt": "1\r\n" } },
      { message: "one" },
    );
    expect(await blobOidAt(repoDir, one.commitOid, "one.txt")).toBe(
      blobOid("1\r\n"),
    );
    const none = await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { deletes: ["one.txt"] },
      { message: "none" },
    );
    expect(await blobOidAt(repoDir, none.commitOid, "one.txt")).toBeNull();
  });

  it("refuses a mode or an entry it does not know, and leaves the branch where it was", async () => {
    const { commitOid } = await initRepo(repoDir, { "README.md": "x\n" });
    await expect(
      commitBlobsOnBranch(
        repoDir,
        DEFAULT_BRANCH,
        {
          writes: { "a.sh": "echo\n" },
          modes: { "a.sh": "160000" as "100755" },
        },
        { message: "submodule mode" },
      ),
    ).rejects.toThrow();
    await expect(
      commitBlobsOnBranch(
        repoDir,
        DEFAULT_BRANCH,
        { entries: [{ path: "b.txt", oid: "not-an-oid", mode: "100644" }] },
        { message: "bad oid" },
      ),
    ).rejects.toThrow();
    expect(await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`)).toBe(
      commitOid,
    );
  });

  it("path conflicts are refused, the first one named, across a large batch", async () => {
    await initRepo(repoDir, { "m/a.sql": "a\n", "d/x/y.txt": "y\n" });
    const writes: Record<string, string> = {};
    for (let i = 0; i < 60; i++) writes[`m/ok${i}.sql`] = `${i}\n`;
    await expect(
      commitBlobsOnBranch(
        repoDir,
        DEFAULT_BRANCH,
        { writes: { ...writes, "m/a.sql/b.sql": "b\n" } },
        { message: "file as folder" },
      ),
    ).rejects.toMatchObject({
      name: "PathConflictError",
      path: "m/a.sql/b.sql",
      conflict: "m/a.sql",
      kind: "file",
    });
    await expect(
      commitBlobsOnBranch(
        repoDir,
        DEFAULT_BRANCH,
        { writes: { ...writes, "d/x": "now a file\n" } },
        { message: "folder as file" },
      ),
    ).rejects.toMatchObject({ name: "PathConflictError", kind: "directory" });
    // …unless the mutation removes what is in the way.
    const ok = await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      {
        writes: { ...writes, "d/x": "now a file\n", "m/a.sql/b.sql": "b\n" },
        deletes: ["d/x/y.txt", "m/a.sql"],
      },
      { message: "replace" },
    );
    expect(ok.unchanged).toBe(false);
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
