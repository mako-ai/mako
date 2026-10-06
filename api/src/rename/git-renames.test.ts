/**
 * Old links follow git's rename detection: a → b → c resolves to c, a
 * chain ending in a deleted file resolves to nothing, and the scan stays
 * inside the kind's directory. Real git in a temp repo, no Mongo.
 *
 * Run: tsx src/rename/git-renames.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../apps/git";
import {
  findRenamedFolder,
  findRenamedPath,
  followRenames,
  parseRenameLog,
} from "./git-renames";

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-renames-test-"));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  const git = (...args: string[]) =>
    runGit(["-C", repo, ...args], {
      env: {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  const write = async (rel: string, contents: string) => {
    await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await fs.writeFile(path.join(repo, rel), contents);
  };
  const commit = async (msg: string) => {
    await git("add", "-A");
    await git("commit", "-q", "-m", msg);
  };

  await git("init", "-q", "-b", "main");
  await write("dbt/models/a.sql", "select 1 -- a long enough body to match\n");
  await write("skills/alpha/SKILL.md", "---\ndescription: x\n---\n\nbody\n");
  await write("connectors/acme/connector.yaml", "runtime: node\n");
  await write("connectors/acme/connector.ts", "export default 1;\n");
  await commit("seed");

  // a → b (pure move)
  await git("mv", "dbt/models/a.sql", "dbt/models/b.sql");
  await commit("rename a to b");
  // b → c with a small edit in the same commit (still a rename to git)
  await git("mv", "dbt/models/b.sql", "dbt/models/c.sql");
  await write(
    "dbt/models/c.sql",
    "select 1 -- a long enough body to match\n-- x\n",
  );
  await commit("rename b to c and edit");
  // skill folder move; connector folder move
  await git("mv", "skills/alpha", "skills/beta");
  await git("mv", "connectors/acme", "connectors/acme-crm");
  await commit("move folders");

  // --- parser + chain ---------------------------------------------------
  const { stdout } = await git(
    "log",
    "--format=%x01%H",
    "-M",
    "--name-status",
    "--diff-filter=R",
    "-z",
    "main",
    "--",
    "dbt",
  );
  const commits = parseRenameLog(stdout);
  assert.equal(commits.length, 2, "two commits renamed something under dbt/");
  assert.deepEqual(commits[0], [
    { status: "R", from: "dbt/models/b.sql", to: "dbt/models/c.sql" },
  ]);
  assert.equal(followRenames("dbt/models/a.sql", commits), "dbt/models/c.sql");
  assert.equal(followRenames("dbt/models/b.sql", commits), "dbt/models/c.sql");
  assert.equal(followRenames("dbt/models/zzz.sql", commits), null);

  // --- end to end ------------------------------------------------------
  assert.equal(
    await findRenamedPath(repo, "main", "dbt/models/a.sql", "dbt"),
    "dbt/models/c.sql",
  );
  assert.equal(
    await findRenamedPath(repo, "main", "dbt/models/b.sql", "dbt"),
    "dbt/models/c.sql",
  );
  // The pathspec bounds the scan: asked under skills/, a dbt rename is unseen.
  assert.equal(
    await findRenamedPath(repo, "main", "dbt/models/a.sql", "skills"),
    null,
  );
  assert.equal(
    await findRenamedFolder(repo, "main", "skills", "alpha", "SKILL.md"),
    "beta",
  );
  assert.equal(
    await findRenamedFolder(
      repo,
      "main",
      "connectors",
      "acme",
      "connector.yaml",
    ),
    "acme-crm",
  );
  assert.equal(
    await findRenamedFolder(repo, "main", "skills", "nope", "SKILL.md"),
    null,
  );

  // A chain that ends in a deletion is a dead link, not a redirect.
  await git("rm", "-q", "dbt/models/c.sql");
  await commit("delete c");
  assert.equal(
    await findRenamedPath(repo, "main", "dbt/models/a.sql", "dbt"),
    null,
  );

  // a → b, b DELETED, an unrelated b created later: `a` is a dead link,
  // not a link to the new b.
  await write(
    "dbt/models/x.sql",
    "select 'x' -- a long enough body to match\n",
  );
  await commit("add x");
  await git("mv", "dbt/models/x.sql", "dbt/models/y.sql");
  await commit("rename x to y");
  await git("rm", "-q", "dbt/models/y.sql");
  await commit("delete y");
  await write("dbt/models/y.sql", "select 'brand new y'\n");
  await commit("new y");
  assert.equal(
    await findRenamedPath(repo, "main", "dbt/models/x.sql", "dbt"),
    null,
    "a delete of the renamed-to path cuts the chain",
  );
  // …while a chain whose end still exists keeps resolving with adds and
  // deletes of OTHER paths in the window.
  await write(
    "dbt/models/p.sql",
    "select 'p' -- a long enough body to match\n",
  );
  await commit("add p");
  await git("mv", "dbt/models/p.sql", "dbt/models/q.sql");
  await commit("rename p to q");
  await write("dbt/models/unrelated.sql", "select 1\n");
  await commit("add unrelated");
  await git("rm", "-q", "dbt/models/unrelated.sql");
  await commit("delete unrelated");
  assert.equal(
    await findRenamedPath(repo, "main", "dbt/models/p.sql", "dbt"),
    "dbt/models/q.sql",
  );
  // The parser carries adds and deletes alongside renames.
  const scan = await git(
    "log",
    "--format=%x01%H",
    "-M",
    "--name-status",
    "--diff-filter=ADR",
    "-z",
    "-n",
    "2",
    "main",
    "--",
    "dbt",
  );
  assert.deepEqual(parseRenameLog(scan.stdout)[0], [
    {
      status: "D",
      from: "dbt/models/unrelated.sql",
      to: "dbt/models/unrelated.sql",
    },
  ]);
  assert.equal(
    followRenames("a", [
      [{ status: "D", from: "b", to: "b" }],
      [{ status: "R", from: "a", to: "b" }],
    ]),
    null,
  );
  assert.equal(
    followRenames("a", [
      [{ status: "A", from: "b", to: "b" }],
      [{ status: "R", from: "a", to: "b" }],
    ]),
    "b",
  );

  // A bad ref is "not found", never a throw.
  assert.equal(
    await findRenamedPath(repo, "refs/heads/nope", "dbt/models/a.sql", "dbt"),
    null,
  );

  await fs.rm(root, { recursive: true, force: true });
  console.log("git-renames tests passed");
}

main().catch((error: unknown) => {
  throw error;
});
