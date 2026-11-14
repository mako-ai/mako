/**
 * Old paths follow git's rename detection: a → b → c resolves to c, a chain
 * that ends in a deleted file resolves to nothing, a name taken again is
 * the newcomer's, and the scan stays inside the kind's directory. Real git
 * in a temp repo.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGit } from "../apps/git";
import {
  findRenamedFolder,
  findRenamedPath,
  followRenames,
  parseRenameLog,
} from "./git-renames";

let root: string;
let repo: string;

const git = (...args: string[]) =>
  runGit(["-C", repo, ...args], {
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
const BODY = "select 1 -- a body long enough for git to match\n";
async function write(rel: string, contents = BODY) {
  await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await fs.writeFile(path.join(repo, rel), contents);
}
async function commit(message: string) {
  await git("add", "-A");
  await git("commit", "-q", "-m", message);
}
const moved = (from: string, dir = "dbt") =>
  findRenamedPath(repo, "main", `dbt/models/${from}`, dir);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "git-renames-test-"));
  repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await git("init", "-q", "-b", "main");
});
afterAll(() => fs.rm(root, { recursive: true, force: true }));

describe("findRenamedPath", () => {
  it("follows a → b → c, an edit in the move included, inside the directory asked for", async () => {
    await write("dbt/models/a.sql");
    await commit("seed");
    await git("mv", "dbt/models/a.sql", "dbt/models/b.sql");
    await commit("a to b");
    await git("mv", "dbt/models/b.sql", "dbt/models/c.sql");
    await write("dbt/models/c.sql", `${BODY}-- edited in the move\n`);
    await commit("b to c, edited");

    expect(await moved("a.sql")).toBe("dbt/models/c.sql");
    expect(await moved("b.sql")).toBe("dbt/models/c.sql");
    expect(await moved("never.sql")).toBeNull();
    // The pathspec bounds the scan, and a bad ref is "not found".
    expect(await moved("a.sql", "skills")).toBeNull();
    expect(
      await findRenamedPath(repo, "refs/heads/nope", "dbt/models/a.sql", "dbt"),
    ).toBeNull();
    // A window too short to reach the first move: null, never a wrong path.
    expect(
      await findRenamedPath(repo, "main", "dbt/models/a.sql", "dbt", {
        limit: 1,
      }),
    ).toBeNull();
  });

  it("a chain that ends in a deletion is a dead link, also when the name is used again", async () => {
    await git("rm", "-q", "dbt/models/c.sql");
    await commit("delete c");
    expect(await moved("a.sql")).toBeNull();
    await write("dbt/models/c.sql", "select 'a brand new c'\n");
    await commit("new c");
    expect(await moved("a.sql")).toBeNull();
  });

  it("adds and deletes of other paths do not cut a chain", async () => {
    await write("dbt/models/p.sql", "select 'p' -- long enough to match\n");
    await commit("add p");
    await git("mv", "dbt/models/p.sql", "dbt/models/q.sql");
    await commit("p to q");
    await write("dbt/models/other.sql", "select 2\n");
    await commit("add other");
    await git("rm", "-q", "dbt/models/other.sql");
    await commit("delete other");
    expect(await moved("p.sql")).toBe("dbt/models/q.sql");
  });
});

describe("findRenamedFolder", () => {
  it("names the folder a marker file moved to, and nothing for a file that left the shape", async () => {
    const md = "---\ndescription: when asked\n---\n\nA body long enough.\n";
    await write("skills/alpha/SKILL.md", md);
    await write("skills/alpha/notes.md", "notes\n");
    await commit("a skill");
    await git("mv", "skills/alpha", "skills/beta");
    await commit("alpha to beta");
    const folder = (old: string) =>
      findRenamedFolder(repo, "main", "skills", old, "SKILL.md");
    expect(await folder("alpha")).toBe("beta");
    expect(await folder("nope")).toBeNull();
    // Moved out of `skills/<name>/SKILL.md`: not a skill folder any more.
    await fs.mkdir(path.join(repo, "skills/beta/deep"));
    await git("mv", "skills/beta/SKILL.md", "skills/beta/deep/SKILL.md");
    await commit("nested");
    expect(await folder("alpha")).toBeNull();
  });
});

describe("followRenames", () => {
  const R = (from: string, to: string) => ({ status: "R" as const, from, to });
  const A = (p: string) => ({ status: "A" as const, from: p, to: p });
  const D = (p: string) => ({ status: "D" as const, from: p, to: p });

  it("reads the log format: renames, adds and deletes, newest commit first", () => {
    const log =
      "\x01sha2\0\nD\0dbt/x.sql\0\x01sha1\0\nR100\0dbt/a.sql\0dbt/b.sql\0A\0dbt/x.sql\0";
    expect(parseRenameLog(log)).toEqual([
      [D("dbt/x.sql")],
      [R("dbt/a.sql", "dbt/b.sql"), A("dbt/x.sql")],
    ]);
  });

  it("cuts the chain at a delete of the new name and at a newcomer on the old one", () => {
    // Newest first.
    expect(followRenames("a", [[R("a", "b")]])).toBe("b");
    expect(followRenames("a", [[D("b")], [R("a", "b")]])).toBeNull();
    expect(followRenames("a", [[A("b")], [R("a", "b")]])).toBe("b");
    // The old name taken again belongs to the newcomer, for good.
    expect(followRenames("a", [[A("a")], [R("a", "b")]])).toBeNull();
    expect(followRenames("a", [[D("a")], [A("a")], [R("a", "b")]])).toBeNull();
    expect(followRenames("a", [[R("c", "a")], [R("a", "b")]])).toBeNull();
    // Renamed back to its own old name: it is where it was.
    expect(followRenames("a", [[R("b", "a")], [R("a", "b")]])).toBe("a");
  });
});
