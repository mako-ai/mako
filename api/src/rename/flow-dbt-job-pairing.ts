/**
 * Pairing a slug that disappeared with a slug that appeared — the laptop
 * rename half of graceful rename for the two kinds whose FILE NAME is their
 * identity: flows (`flows/<slug>.yml`) and dbt jobs (`dbt/jobs/<slug>.yml`).
 *
 * The push reactors for both kinds match rows to files by slug, so a
 * `git mv flows/a.yml flows/b.yml` pushed from a checkout used to read as
 * "a was deleted, b is new": teardown (checkpoints, run history, webhook
 * events gone, a fresh id, a new inbound webhook URL) plus a create that
 * re-backfills. This module decides, BEFORE the reactor acts, which removed
 * slugs are really the same object under a new name, so the reactor can
 * re-key the row in place instead.
 *
 * Three rules, tried in this order for each removed slug:
 *
 *  1. ALIAS — the added file's `aliases:` names the removed slug (a rename
 *     made through the service writes exactly that), or the removed row's
 *     own aliases name the added slug (renaming back to an old name).
 *  2. GIT — `git diff -M` between the removed files' last-synced blobs and
 *     the added files' blobs reports a rename. Real git similarity, so an
 *     edit made in the same commit as the move does not defeat it.
 *  3. IDENTICAL — the definitions are the same apart from `name:` and
 *     `aliases:`. Covers a tree moved without git's help (a copy + delete).
 *
 * A rule that yields TWO candidates is ambiguous, and an ambiguous pairing
 * is never guessed: the removed slug is left to the reactor's existing
 * behaviour (teardown) and a warning says why. Guessing wrong would re-key a
 * live stream onto the wrong definition, which is worse than the teardown
 * this exists to avoid. Likewise an added slug claimed by two removed slugs
 * is given to neither.
 *
 * Pure except for the two git helpers at the bottom, which the reactors call
 * to feed it; the rules themselves take plain data so they can be tested
 * without a repo.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { runGit } from "../apps/git";

/** A slug whose file is gone from the tree but whose row still exists. */
export interface RemovedSlug {
  slug: string;
  /** The row's own aliases, for the "renamed back" direction of rule 1. */
  aliases?: string[];
  /**
   * The file's contents as last synced (read back from git by the row's
   * `sourceBlobSha`, or the row's own projection when the blob is gone).
   * Absent when neither is available; rule 3 then cannot match this slug.
   */
  contents?: string;
}

/** A slug whose file is in the tree but has no row yet. */
export interface AddedSlug {
  slug: string;
  contents: string;
  /** `aliases:` as parsed from the file (empty when none). */
  aliases: string[];
}

export type PairingRule = "alias" | "git" | "identical";

export interface SlugRenamePair {
  from: string;
  to: string;
  via: PairingRule;
}

export interface SlugPairing {
  pairs: SlugRenamePair[];
  /** Removed slugs left alone because more than one added slug fit. */
  ambiguous: Array<{ slug: string; rule: PairingRule; candidates: string[] }>;
}

/**
 * The definition with its two rename-mutable keys removed, in a form two
 * files can be compared by. A YAML that does not load compares equal to
 * nothing (`null`), so a broken file is never paired by content.
 */
export function definitionIdentity(contents: string): string | null {
  let raw: unknown;
  try {
    raw = yaml.load(contents);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const doc = { ...(raw as Record<string, unknown>) };
  delete doc.name;
  delete doc.aliases;
  return stableStringify(doc);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Union of a row's aliases and a file's, deduplicated, never containing the
 * current slug. Aliases only ever grow: the file's are unioned onto the
 * row's rather than replacing them, because a laptop rename the sync
 * re-keyed in place is recorded on the row alone (the file did not carry
 * it) and the next file edit must not forget it.
 */
export function mergedAliases(
  rowAliases: string[] | undefined,
  fileAliases: string[] | undefined,
  currentSlug: string | undefined,
): string[] {
  const out: string[] = [];
  for (const alias of [...(rowAliases ?? []), ...(fileAliases ?? [])]) {
    if (!alias || alias === currentSlug || out.includes(alias)) continue;
    out.push(alias);
  }
  return out;
}

/**
 * Decide which removed slugs are renamed added slugs. See the module note
 * for the rules; `gitRenames` is rule 2's input (removed slug → added slug),
 * supplied by {@link detectGitRenames} or left empty.
 */
export function pairRenamedSlugs(input: {
  removed: RemovedSlug[];
  added: AddedSlug[];
  gitRenames?: ReadonlyMap<string, string>;
}): SlugPairing {
  const { removed, added } = input;
  const gitRenames = input.gitRenames ?? new Map<string, string>();
  const result: SlugPairing = { pairs: [], ambiguous: [] };
  if (removed.length === 0 || added.length === 0) return result;

  const addedBySlug = new Map(added.map(a => [a.slug, a] as const));
  const identityOfAdded = new Map<string, string | null>();
  for (const a of added) {
    identityOfAdded.set(a.slug, definitionIdentity(a.contents));
  }

  const candidatePairs: SlugRenamePair[] = [];
  for (const r of removed) {
    const rules: Array<[PairingRule, string[]]> = [
      [
        "alias",
        added
          .filter(
            a =>
              a.aliases.includes(r.slug) || (r.aliases ?? []).includes(a.slug),
          )
          .map(a => a.slug),
      ],
      [
        "git",
        (() => {
          const to = gitRenames.get(r.slug);
          return to !== undefined && addedBySlug.has(to) ? [to] : [];
        })(),
      ],
      [
        "identical",
        (() => {
          if (r.contents === undefined) return [];
          const identity = definitionIdentity(r.contents);
          if (identity === null) return [];
          return added
            .filter(a => identityOfAdded.get(a.slug) === identity)
            .map(a => a.slug);
        })(),
      ],
    ];
    let decided = false;
    for (const [rule, candidates] of rules) {
      if (candidates.length === 0) continue;
      if (candidates.length === 1) {
        candidatePairs.push({ from: r.slug, to: candidates[0], via: rule });
      } else {
        result.ambiguous.push({
          slug: r.slug,
          rule,
          candidates: [...candidates].sort(),
        });
      }
      decided = true;
      break;
    }
    if (!decided) continue;
  }

  // An added slug two removed slugs both claim belongs to neither.
  const claims = new Map<string, SlugRenamePair[]>();
  for (const pair of candidatePairs) {
    claims.set(pair.to, [...(claims.get(pair.to) ?? []), pair]);
  }
  for (const [to, pairs] of claims) {
    if (pairs.length === 1) {
      result.pairs.push(pairs[0]);
      continue;
    }
    for (const pair of pairs) {
      result.ambiguous.push({
        slug: pair.from,
        rule: pair.via,
        candidates: [to],
      });
    }
  }
  result.pairs.sort((a, b) => a.from.localeCompare(b.from));
  return result;
}

// ---- git helpers -----------------------------------------------------------

/** The blob's contents, or null when the object is not in the repo. */
export async function readBlobByOid(
  repoDir: string,
  oid: string,
): Promise<string | null> {
  if (!/^[0-9a-f]{40}$/.test(oid)) return null;
  try {
    const { stdout } = await runGit(["-C", repoDir, "cat-file", "blob", oid]);
    return stdout;
  } catch {
    return null;
  }
}

async function blobExists(repoDir: string, oid: string): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/.test(oid)) return false;
  try {
    await runGit(["-C", repoDir, "cat-file", "-e", `${oid}^{blob}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A tree holding exactly `entries`, written with a throwaway index (the same
 * plumbing `commitBlobsOnBranch` uses — `git mktree` takes one directory
 * level at a time, and these paths are nested).
 */
async function writeTreeOf(
  repoDir: string,
  entries: Array<{ path: string; oid: string }>,
): Promise<string> {
  const indexFile = path.join(
    os.tmpdir(),
    `mako-rename-pairing-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const env = { GIT_DIR: repoDir, GIT_INDEX_FILE: indexFile };
  try {
    await runGit(["read-tree", "--empty"], { env, cwd: repoDir });
    await runGit(["update-index", "--index-info"], {
      env,
      cwd: repoDir,
      stdin: entries.map(e => `100644 ${e.oid}\t${e.path}`).join("\n") + "\n",
    });
    return (await runGit(["write-tree"], { env, cwd: repoDir })).stdout.trim();
  } finally {
    await fs.rm(indexFile, { force: true });
  }
}

/**
 * Git's own rename detection, confined to the files in question: a tree of
 * the removed files (at their last-synced blobs) diffed with `-M` against a
 * tree of the added files. Returns removed path → added path.
 *
 * Confining the diff is deliberate. A whole-tree diff between "the commit we
 * last reconciled" and main would need that commit remembered somewhere, and
 * would let an unrelated file that happens to resemble a flow count as a
 * candidate. The row's `sourceBlobSha` IS the last-synced content, and git
 * keeps the blob, so the two trees can be built on the spot.
 *
 * Entries whose blob is not in the repo are dropped (nothing to compare);
 * a git failure yields no renames rather than an error — this is an input
 * to a decision that fails safe, not the decision.
 */
export async function detectGitRenames(
  repoDir: string,
  removed: Array<{ path: string; oid: string | undefined }>,
  added: Array<{ path: string; oid: string }>,
): Promise<Map<string, string>> {
  const renames = new Map<string, string>();
  const before: Array<{ path: string; oid: string }> = [];
  for (const r of removed) {
    if (r.oid && (await blobExists(repoDir, r.oid))) {
      before.push({ path: r.path, oid: r.oid });
    }
  }
  const after: Array<{ path: string; oid: string }> = [];
  for (const a of added) {
    if (await blobExists(repoDir, a.oid)) after.push(a);
  }
  if (before.length === 0 || after.length === 0) return renames;
  try {
    const treeA = await writeTreeOf(repoDir, before);
    const treeB = await writeTreeOf(repoDir, after);
    const { stdout } = await runGit([
      "-C",
      repoDir,
      "diff",
      "-M",
      "--name-status",
      "--diff-filter=R",
      "-z",
      treeA,
      treeB,
    ]);
    const parts = stdout.split("\0").filter(Boolean);
    for (let i = 0; i + 2 < parts.length; i += 3) {
      // R<score>\0<from>\0<to>
      if (parts[i].startsWith("R")) renames.set(parts[i + 1], parts[i + 2]);
    }
  } catch {
    return new Map();
  }
  return renames;
}
