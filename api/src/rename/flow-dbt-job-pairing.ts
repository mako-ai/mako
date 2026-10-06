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
import {
  TreeNotVerifiedError,
  assertTreeAtMirrorMain,
} from "../apps/cloud-repo.service";

/** A slug whose file is gone from the tree but whose row still exists. */
export interface RemovedSlug {
  slug: string;
  /** The row's own aliases (informational; see the module note on rule 1). */
  aliases?: string[];
  /**
   * What the object points AT, as a comparable key — for a flow its source
   * connection and destination (connection, database, schema, table), for a
   * job its environment and commands (`flowRenameTarget` / `jobRenameTarget`).
   * Rules 2 and 3 pair only two files with the SAME target: a file that
   * resembles another but reads from a different connection or writes to a
   * different table is a different stream, and handing it the other's
   * checkpoints would skip its backfill and strand the other's teardown.
   * `null`/absent means unknown, which pairs with nothing under those rules.
   */
  target?: string | null;
  /**
   * The file's contents as last synced (read back from git by
   * {@link pairingBaseBlob}, or the row's own projection when the blob is
   * gone).
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
  /** See {@link RemovedSlug.target}. */
  target?: string | null;
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
  /**
   * Alias pairs whose two sides point at different targets. An explicit
   * `aliases:` is the author's statement and is honoured, but it is worth a
   * line in the log: the renamed stream now reads from / writes to
   * something else than its checkpoints were taken against.
   */
  targetMismatch: Array<{ from: string; to: string }>;
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
  const result: SlugPairing = { pairs: [], ambiguous: [], targetMismatch: [] };
  if (removed.length === 0 || added.length === 0) return result;

  const addedBySlug = new Map(added.map(a => [a.slug, a] as const));
  const identityOfAdded = new Map<string, string | null>();
  for (const a of added) {
    identityOfAdded.set(a.slug, definitionIdentity(a.contents));
  }
  // Rules 2 and 3 only ever pair two files that point at the same thing.
  const sameTarget = (r: RemovedSlug, a: AddedSlug): boolean =>
    typeof r.target === "string" &&
    typeof a.target === "string" &&
    r.target === a.target;

  const candidatePairs: SlugRenamePair[] = [];
  for (const r of removed) {
    const rules: Array<[PairingRule, string[]]> = [
      // Only the FORWARD direction: the new file names the old slug. The
      // reverse ("the removed row lists the added slug as an alias") is
      // exactly what a tree read before a rename commit looks like, and
      // pairing on it would undo a rename that just happened. A genuine
      // rename back through the service writes the alias forward anyway;
      // a laptop one falls to rules 2 and 3.
      [
        "alias",
        added
          .filter(
            a =>
              a.aliases.includes(r.slug) ||
              // Both say they used to be the same name (two renames of one
              // flow racing on two instances: a→b won the mirror, a→c wrote
              // the row): the same stream, when the targets agree.
              (a.aliases.some(x => (r.aliases ?? []).includes(x)) &&
                sameTarget(r, a)),
          )
          .map(a => a.slug),
      ],
      [
        "git",
        (() => {
          const to = gitRenames.get(r.slug);
          const a = to !== undefined ? addedBySlug.get(to) : undefined;
          return a && sameTarget(r, a) ? [a.slug] : [];
        })(),
      ],
      [
        "identical",
        (() => {
          if (r.contents === undefined) return [];
          const identity = definitionIdentity(r.contents);
          if (identity === null) return [];
          return added
            .filter(
              a => identityOfAdded.get(a.slug) === identity && sameTarget(r, a),
            )
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
  const removedBySlug = new Map(removed.map(r => [r.slug, r] as const));
  for (const [to, pairs] of claims) {
    if (pairs.length === 1) {
      result.pairs.push(pairs[0]);
      const r = removedBySlug.get(pairs[0].from);
      const a = addedBySlug.get(to);
      if (pairs[0].via === "alias" && r && a && !sameTarget(r, a)) {
        result.targetMismatch.push({ from: pairs[0].from, to });
      }
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

/**
 * The blob a removed row is paired against: what main last had for it —
 * normally its `sourceBlobSha`. But while a rename the row records is NOT
 * in `head`'s history, the tree being judged grew from the file as it was
 * BEFORE that rename (a laptop `git mv` that won the mirror moved that
 * file), and the rename re-stamped `sourceBlobSha` to a blob only the
 * renaming instance ever had. Then the pre-rename blob (`renameFromBlobSha`,
 * which was on the mirror's main, so on every instance) is the one git's
 * rename detection and the identical rule compare against. Falls back to
 * the other blob; null when neither is in this repo.
 */
export async function pairingBaseBlob(
  repoDir: string,
  head: string,
  row: {
    sourceBlobSha?: string;
    renameFromBlobSha?: string;
    lastRenameCommit?: string;
  },
): Promise<{ oid: string; contents: string } | null> {
  const candidates: string[] = [];
  if (
    row.renameFromBlobSha &&
    row.lastRenameCommit &&
    !(await isAncestorCommit(repoDir, row.lastRenameCommit, head))
  ) {
    candidates.push(row.renameFromBlobSha);
  }
  if (row.sourceBlobSha) candidates.push(row.sourceBlobSha);
  for (const oid of candidates) {
    const contents = await readBlobByOid(repoDir, oid);
    if (contents !== null) return { oid, contents };
  }
  return null;
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
 * candidate. The row's last-synced blob ({@link pairingBaseBlob}) IS that
 * content, and git keeps it, so the two trees can be built on the spot.
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
      // 90%, not git's default 50%: at 50% two flows that share the format's
      // boilerplate (same keys, same layout stanza, different connection and
      // schema) were reported as a rename. The target check above is the
      // real guard; the threshold keeps git's answer honest on its own.
      "-M90%",
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

/**
 * Whether `commit` is contained in the history of `tip` (or is `tip`). An
 * unknown commit answers false — the caller treats "not contained" as "this
 * tree predates it". Used to recognise a tree read BEFORE a rename commit
 * landed: the row already says the new slug, the tree still shows the old
 * file, and nothing must be undone or created from that view.
 */
export async function isAncestorCommit(
  repoDir: string,
  commit: string,
  tip: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(tip)) {
    return false;
  }
  try {
    await runGit(["-C", repoDir, "merge-base", "--is-ancestor", commit, tip]);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Is the tree I am judging the mirror's current main?" — answered at most
 * once per sync, and only when something actually needs it (it is an
 * `ls-remote`). The renaming instance's local main is AHEAD of the mirror
 * until its push lands (`fetchFromCloud` keeps a local-ahead main), so a
 * commit being in `head`'s history proves nothing about what other
 * instances see; the mirror's main is the only tree every instance agrees
 * on. A workspace with no mirror answers yes (the local repo is the store).
 * Anything that cannot be verified answers no — and "no" never tears
 * anything down, it only keeps rows as they are.
 */
export function currentTreeCheck(
  workspaceId: string,
  head: string,
  onUnverified?: (reason: string) => void,
): () => Promise<boolean> {
  let memo: Promise<boolean> | undefined;
  return () => {
    memo ??= (async () => {
      try {
        await assertTreeAtMirrorMain(workspaceId, head);
        return true;
      } catch (error) {
        onUnverified?.(
          error instanceof TreeNotVerifiedError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
        );
        return false;
      }
    })();
    return memo;
  };
}
