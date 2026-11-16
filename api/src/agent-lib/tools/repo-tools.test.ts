/**
 * repo_glob / repo_grep / repo_read_file: the visibility rule and the
 * pathspec sandbox, then, against a real git repo, the four leaks review
 * found (a non-ASCII hidden path, an archived private app, a folder read, a
 * grep overflow), a parent-folder pathspec and the read error messages.
 *
 * Run: tsx src/agent-lib/tools/repo-tools.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRepoTools,
  globRepo,
  grepRepo,
  readRepoFile,
  repoPathVisibility,
  safePathspec,
  type RepoView,
} from "./repo-tools";

// --- the three tools exist and are read-only by shape -----------------------
{
  const tools = createRepoTools({ workspaceId: "000000000000000000000000" });
  assert.deepEqual(Object.keys(tools).sort(), [
    "repo_glob",
    "repo_grep",
    "repo_read_file",
  ]);
}

// --- another person's private app and personal tree are invisible ----------
{
  const isVisible = repoPathVisibility({
    hiddenAppRoots: ["users/bob/apps/secret", "apps/finance/payroll"],
    visibleAppRoots: ["users/bob/apps/shared", "apps/sales"],
    ownHandle: "alice",
  });
  assert.equal(isVisible("dbt/models/marts/fct_mrr.sql"), true);
  assert.equal(isVisible("dbt/ontology/terms.yml"), true);
  assert.equal(isVisible("apps/sales/bindings/mrr.sql"), true);
  assert.equal(isVisible("apps/finance/payroll/bindings/pay.sql"), false);
  assert.equal(isVisible("apps/finance/payroll"), false);
  assert.equal(isVisible("users/alice/apps/mine/src/App.tsx"), true);
  assert.equal(isVisible("users/alice/notes.md"), true);
  assert.equal(isVisible("users/bob/apps/secret/src/App.tsx"), false);
  assert.equal(isVisible("users/bob/notes.md"), false);
  assert.equal(isVisible("users/bob/apps/shared/src/App.tsx"), true);
  // A sibling whose name only starts like a hidden root stays visible.
  assert.equal(isVisible("apps/finance/payroll-v2/x.sql"), true);
}

// --- no user (a workspace key without one): everything --------------------
{
  const isVisible = repoPathVisibility({
    hiddenAppRoots: ["users/bob/apps/secret"],
    visibleAppRoots: [],
    everything: true,
  });
  assert.equal(isVisible("users/bob/apps/secret/src/App.tsx"), true);
}

// --- pathspec stays inside the repo -------------------------------------------
{
  assert.equal(safePathspec(undefined), undefined);
  assert.equal(safePathspec("."), undefined);
  assert.equal(safePathspec("dbt/models/"), "dbt/models");
  assert.throws(() => safePathspec("../etc"));
  assert.throws(() => safePathspec("/etc/passwd"));
  assert.throws(() => safePathspec(".git/config"));
  assert.throws(() => safePathspec(":(top)"));
}

// --- quoted paths and the archive are hidden by the rule itself --------------
{
  const isVisible = repoPathVisibility({
    hiddenAppRoots: [],
    visibleAppRoots: [],
    visibleArchivedRoots: ["archive/apps/old-sales"],
    ownHandle: "alice",
  });
  assert.equal(isVisible('"users/bob/apps/s\\303\\251cret/a.ts"'), false);
  assert.equal(isVisible("archive/users/bob/apps/x/a.ts"), false);
  assert.equal(isVisible("archive/apps/old-sales/bindings/a.sql"), true);
  assert.equal(isVisible("archive"), false);
}

// --- against a real repo: the four leaks the review found ---------------------
const SECRET = "secret_token_4f2a";

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-tools-test-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  const files: Record<string, string> = {
    "dbt/models/fct_mrr.sql": "select 1 as mrr\n",
    // Bob's private app, with a non-ASCII folder name.
    "users/bob/apps/sécret/a.ts": `${SECRET}\n`,
    // A private workspace app nobody shared with alice.
    "apps/payroll/bindings/pay.sql": `select '${SECRET}'\n`,
    "apps/sales/bindings/mrr.sql": "select mrr from fct_mrr\n",
    // Bob's private app, archived by the lifecycle job.
    "archive/users/bob/apps/old/a.ts": `${SECRET}\n`,
    // Vadim shared one app (non-ASCII name) and kept one private.
    "users/vadim/apps/radär/bindings/a.sql": "select * from dbt_vadim.x\n",
    "users/vadim/apps/privé/bindings/a.sql": `select '${SECRET}' from dbt_vadim.y\n`,
    // A folder whose only app is private: its own name passes the rule.
    "apps/hr/salaries/bindings/a.sql": `select '${SECRET}'\n`,
    // An archived app the actor may see, next to Bob's archived private one.
    "archive/apps/old-sales/bindings/a.sql": "select 'old_sales'\n",
    // A big hidden file: a broad grep overflows a small buffer on it.
    "apps/payroll/big.txt": `${SECRET} ${"x".repeat(200)}\n`.repeat(50),
  };
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), contents);
  }
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
}

async function againstARealRepo() {
  const repoDir = makeRepo();
  try {
    const view: RepoView = {
      repoDir,
      ref: "refs/heads/main",
      branch: "main",
      isVisible: repoPathVisibility({
        hiddenAppRoots: [
          "users/bob/apps/sécret",
          "apps/payroll",
          "users/vadim/apps/privé",
          "apps/hr/salaries",
        ],
        visibleAppRoots: ["apps/sales", "users/vadim/apps/radär"],
        visibleArchivedRoots: [],
        ownHandle: "alice",
      }),
    };
    const text = (result: unknown) => JSON.stringify(result);

    // 1. A non-ASCII hidden path: git used to quote it, which slipped past
    //    the visibility rule.
    const grep = (await grepRepo(view, { pattern: SECRET })) as {
      success: boolean;
      matches: Array<{ path: string }>;
    };
    assert.equal(grep.success, true);
    assert.deepEqual(grep.matches, [], "no hidden match, quoted or not");

    // 2. An archived private app.
    const glob = (await globRepo(view, "archive/**")) as { paths: string[] };
    assert.deepEqual(glob.paths, []);
    const archived = await readRepoFile(view, {
      path: "archive/users/bob/apps/old/a.ts",
    });
    assert.equal(archived.success, false);
    assert.ok(!text(archived).includes(SECRET));

    // 3. A folder read: `git show` on a tree lists hidden app names.
    const folder = await readRepoFile(view, { path: "apps" });
    assert.equal(folder.success, false, "a folder is not a file");
    assert.ok(!text(folder).includes("payroll"), "no hidden name leaks");
    assert.ok(!text(folder).includes("sales"), "no child name at all");
    const file = (await readRepoFile(view, {
      path: "apps/sales/bindings/mrr.sql",
    })) as { success: boolean; contents: string };
    assert.equal(file.success, true);
    assert.match(file.contents, /select mrr from fct_mrr/);

    // 4. A grep overflow: the git error carried unfiltered output.
    const overflow = await grepRepo(
      view,
      { pattern: SECRET },
      { maxBufferBytes: 1_000 },
    );
    assert.equal(overflow.success, false);
    assert.ok(!text(overflow).includes(SECRET), "no raw git output");
    assert.match(text(overflow), /too broad/);
    // A hidden pathspec is refused before git runs.
    const hiddenSpec = await grepRepo(view, {
      pattern: ".",
      pathspec: "apps/payroll",
    });
    assert.equal(hiddenSpec.success, false);
    assert.ok(!text(hiddenSpec).includes(SECRET));

    // 5. A parent folder of a visible app: allowed, filtered per path.
    const parent = (await grepRepo(view, {
      pattern: "dbt_vadim",
      pathspec: "users/vadim",
    })) as { success: boolean; matches: Array<{ path: string }> };
    assert.equal(parent.success, true, text(parent));
    assert.deepEqual(
      parent.matches.map(m => m.path),
      ["users/vadim/apps/radär/bindings/a.sql"],
      "only the shared app's match, its non-ASCII name raw",
    );
    assert.ok(!text(parent).includes(SECRET));
    assert.ok(!text(parent).includes("privé"));
    const trailing = (await grepRepo(view, {
      pattern: "dbt_vadim",
      pathspec: "users/vadim/",
    })) as { matches: unknown[] };
    assert.equal(trailing.matches.length, 1);
    // A pathspec inside the hidden app, or a file in it, is refused, and
    // reads as a missing path does.
    const notFound = (spec: string) => `${spec} not found on main.`;
    for (const spec of [
      "users/vadim/apps/privé",
      "users/vadim/apps/privé/bindings",
      "users/vadim/apps/privé/bindings/a.sql",
      // Bob's tree holds only his private app.
      "users/bob",
      // Its name passes the rule, its only app is private.
      "apps/hr",
      "archive",
    ]) {
      const refused = await grepRepo(view, { pattern: ".", pathspec: spec });
      assert.deepEqual(refused, { success: false, error: notFound(spec) });
    }
    for (const spec of ["users/nobody", "dbt/nothing"]) {
      assert.deepEqual(await grepRepo(view, { pattern: ".", pathspec: spec }), {
        success: false,
        error: notFound(spec),
      });
    }
    // A glob pathspec keeps working, filtered per path; one inside a hidden
    // app is refused.
    const globSpec = (await grepRepo(view, {
      pattern: ".",
      pathspec: "apps/*/bindings/*.sql",
    })) as { success: boolean; matches: Array<{ path: string }> };
    assert.equal(globSpec.success, true, text(globSpec));
    assert.deepEqual(
      globSpec.matches.map(m => m.path),
      ["apps/sales/bindings/mrr.sql"],
    );
    const dbtGlob = (await grepRepo(view, {
      pattern: "mrr",
      pathspec: "dbt/models/*.sql",
    })) as { success: boolean; count: number };
    assert.equal(dbtGlob.success, true);
    assert.equal(dbtGlob.count, 1);
    assert.deepEqual(
      await grepRepo(view, { pattern: ".", pathspec: "apps/payroll/*" }),
      { success: false, error: notFound("apps/payroll/*") },
    );
    // A visible file works as a pathspec.
    const oneFile = (await grepRepo(view, {
      pattern: "mrr",
      pathspec: "apps/sales/bindings/mrr.sql",
    })) as { success: boolean; count: number };
    assert.equal(oneFile.success, true);
    assert.equal(oneFile.count, 1);

    // 6. Read errors: a folder the actor can see into says so, a hidden or
    //    missing path reads as missing.
    const folderMessage = (p: string) =>
      `${p} is a folder, not a file. List it with repo_glob, e.g. "${p}/*" for its files or "${p}/**" for everything under it.`;
    const missingMessage = (p: string) =>
      `${p} not found on main. Use repo_glob to find the path.`;
    for (const p of ["apps", "dbt/models", "users/vadim", "users/vadim/apps"]) {
      assert.deepEqual(await readRepoFile(view, { path: p }), {
        success: false,
        error: folderMessage(p),
      });
    }
    for (const p of [
      "apps/payroll",
      "apps/hr",
      "users/bob",
      "users/vadim/apps/privé",
      "users/vadim/apps/privé/bindings/a.sql",
      "archive",
      "users/nobody",
      "dbt/models/missing.sql",
    ]) {
      assert.deepEqual(await readRepoFile(view, { path: p }), {
        success: false,
        error: missingMessage(p),
      });
    }

    // 7. The archive: only the archived apps the actor may see.
    const archiveView: RepoView = {
      ...view,
      isVisible: repoPathVisibility({
        hiddenAppRoots: ["users/bob/apps/sécret", "apps/payroll"],
        visibleAppRoots: ["apps/sales"],
        visibleArchivedRoots: ["archive/apps/old-sales"],
        ownHandle: "alice",
      }),
    };
    const archive = (await grepRepo(archiveView, {
      pattern: ".",
      pathspec: "archive",
    })) as { success: boolean; matches: Array<{ path: string }> };
    assert.equal(archive.success, true);
    assert.deepEqual(
      archive.matches.map(m => m.path),
      ["archive/apps/old-sales/bindings/a.sql"],
    );
    assert.deepEqual(await readRepoFile(archiveView, { path: "archive" }), {
      success: false,
      error: folderMessage("archive"),
    });
    assert.deepEqual(
      await readRepoFile(archiveView, { path: "archive/users/bob" }),
      { success: false, error: missingMessage("archive/users/bob") },
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

void againstARealRepo()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log("repo-tools.test.ts: all assertions passed");
    // The tool factories import the agent stack (loggers, mongoose schemas).
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  });
