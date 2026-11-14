/**
 * The rules flows and dbt jobs share (./slug-files.ts): which slug that
 * disappeared is which slug that appeared, what an old name resolves to,
 * and what git itself calls a rename.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import { runGit } from "../apps/git";
import { MAX_ALIASES } from "./alias-cap";
import {
  detectGitRenames,
  mergedAliases,
  pairRenamedSlugs,
  pickByRef,
  type AddedSlug,
  type RemovedSlug,
} from "./slug-files";

const file = (target: string, body = "x") =>
  `name: N\nsource: ${target}\nbody: ${body}\n`;
const removed = (
  slug: string,
  more: Partial<RemovedSlug> = {},
): RemovedSlug => ({
  slug,
  aliases: [],
  target: "T",
  contents: file("T"),
  ...more,
});
const added = (slug: string, more: Partial<AddedSlug> = {}): AddedSlug => ({
  slug,
  aliases: [],
  target: "T",
  contents: file("T", "changed"),
  ...more,
});
const pairsOf = (input: Parameters<typeof pairRenamedSlugs>[0]) =>
  pairRenamedSlugs(input).pairs.map(p => `${p.from}>${p.to}:${p.via}`);

describe("pairing a removed slug with an added one", () => {
  it("1. ALIAS: the added file names the removed slug — whatever else changed", () => {
    expect(
      pairsOf({
        removed: [removed("a")],
        added: [
          added("b", { aliases: ["a"], target: "elsewhere" }),
          added("c"),
        ],
      }),
    ).toEqual(["a>b:alias"]);
  });

  it("1. ALIAS, back to an old name: only onto the same target, and never on a read", () => {
    const back = {
      removed: [removed("b", { aliases: ["a"] })],
      added: [added("a")],
    };
    expect(pairsOf(back)).toEqual(["b>a:alias"]);
    expect(pairsOf({ ...back, aliasOnly: true })).toEqual([]);
    // A new flow pushed at the old name while the renamed one is deleted.
    expect(
      pairsOf({ ...back, added: [added("a", { target: "another" })] }),
    ).toEqual([]);
  });

  it("2. GIT: a rename git reports, for the same target only", () => {
    const gitRenames = new Map([["a", ["b"]]]);
    expect(
      pairsOf({ removed: [removed("a")], added: [added("b")], gitRenames }),
    ).toEqual(["a>b:git"]);
    expect(
      pairsOf({
        removed: [removed("a")],
        added: [added("b", { target: "another" })],
        gitRenames,
      }),
    ).toEqual([]);
    expect(
      pairsOf({
        removed: [removed("a", { target: null })],
        added: [added("b", { target: null })],
        gitRenames,
      }),
    ).toEqual([]);
  });

  it("3. IDENTICAL: the same definition apart from name: and aliases:", () => {
    const same = "name: Other\naliases: [z]\nbody: x\nsource: T\n";
    expect(
      pairsOf({
        removed: [removed("a")],
        added: [added("b", { contents: same })],
      }),
    ).toEqual(["a>b:identical"]);
  });

  it("nothing else pairs: the same target alone is a teardown and a create", () => {
    const result = pairRenamedSlugs({
      removed: [removed("a")],
      added: [added("b")],
    });
    expect(result).toEqual({ pairs: [], ambiguous: [] });
  });

  it("two candidates, either way, are never guessed", () => {
    const twoAdded = pairRenamedSlugs({
      removed: [removed("a")],
      added: [added("b"), added("c")],
      gitRenames: new Map([["a", ["b", "c"]]]),
    });
    expect(twoAdded.pairs).toEqual([]);
    expect(twoAdded.ambiguous).toEqual([
      { slug: "a", rule: "git", candidates: ["b", "c"] },
    ]);
    const twoRemoved = pairRenamedSlugs({
      removed: [removed("a"), removed("b")],
      added: [added("c", { aliases: ["a", "b"] })],
    });
    expect(twoRemoved.pairs).toEqual([]);
    expect(twoRemoved.ambiguous.map(entry => entry.slug)).toEqual(["a", "b"]);
  });
});

describe("old names", () => {
  it("are merged oldest first, without the current slug, the newest kept", () => {
    expect(mergedAliases(["a", "b"], ["b", "c", "now"], "now")).toEqual([
      "a",
      "b",
      "c",
    ]);
    const many = Array.from({ length: MAX_ALIASES + 3 }, (_, i) => `n${i}`);
    expect(mergedAliases(many, undefined, "x")).toEqual(many.slice(3));
  });

  it("resolve by id, then current slug, then an alias one row claims", () => {
    const row = (slug: string, aliases: string[] = []) => ({
      _id: new Types.ObjectId(),
      slug,
      aliases,
    });
    const rows = [
      row("a", ["old", "shared"]),
      row("old"),
      row("c", ["shared"]),
    ];
    expect(pickByRef(rows, String(rows[0]._id))).toEqual({
      row: rows[0],
      via: "current",
    });
    // A live name is never shadowed by another row's old name.
    expect(pickByRef(rows, "old")).toEqual({ row: rows[1], via: "current" });
    expect(pickByRef([rows[0]], "old")).toEqual({ row: rows[0], via: "alias" });
    expect(pickByRef(rows, "shared")).toBeNull();
    expect(pickByRef(rows, "nothing")).toBeNull();
  });
});

describe("what git calls a rename", () => {
  let repo: string;
  const blob = async (contents: string) =>
    (
      await runGit(["-C", repo, "hash-object", "-w", "--stdin"], {
        stdin: contents,
      })
    ).stdout.trim();
  const lines = (n: number, changed = 0) =>
    Array.from(
      { length: n },
      (_, i) => `key_${i}: ${i < changed ? "changed" : "value"}_${i}`,
    )
      .join("\n")
      .concat("\n");

  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "slug-files-git-"));
    await runGit(["init", "--bare", "-q", repo]);
  });
  afterAll(() => fs.rm(repo, { recursive: true, force: true }));

  it("a move with a small edit, not a rewrite; and both files when it could be either", async () => {
    const from = [{ path: "flows/a.yml", oid: await blob(lines(40)) }];
    const edited = { path: "flows/b.yml", oid: await blob(lines(40, 2)) };
    const rewritten = { path: "flows/c.yml", oid: await blob(lines(40, 20)) };
    const copy = { path: "flows/d.yml", oid: from[0].oid };
    expect(await detectGitRenames(repo, from, [edited, rewritten])).toEqual(
      new Map([["flows/a.yml", ["flows/b.yml"]]]),
    );
    expect(await detectGitRenames(repo, from, [rewritten])).toEqual(new Map());
    expect(
      (await detectGitRenames(repo, from, [edited, copy]))
        .get("flows/a.yml")
        ?.sort(),
    ).toEqual(["flows/b.yml", "flows/d.yml"]);
  });
});
