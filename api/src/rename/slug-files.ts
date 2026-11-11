/**
 * Flows (`flows/<slug>.yml`) and dbt jobs (`dbt/jobs/<slug>.yml`): the two
 * kinds whose FILE NAME is their identity. What both need so that a file
 * that moves keeps its row — same id, checkpoints, run history, webhook and
 * schedule — instead of being torn down and created again:
 *
 *  - lookup: id, then current slug, then an alias exactly one row claims;
 *  - re-keying a row in place, the slug it left kept as an alias;
 *  - pairing a slug that disappeared from a tree with one that appeared,
 *    BEFORE the push sync treats the first as a removal;
 *  - the rename guard: a tree that predates a rename decides nothing about
 *    the renamed row;
 *  - ids of deleted objects, never handed to another file.
 *
 * PAIRING, in this order, for each row whose file is gone:
 *
 *  1. ALIAS — an added file's `aliases:` names the row's slug (the author
 *     said so; honoured as written), or the row's own aliases name the
 *     added slug and both point at the same target (a move back).
 *  2. GIT — `git diff -M90%` between the row's last-synced blob and the
 *     added blobs reports a rename, and both point at the same target.
 *  3. IDENTICAL — the same definition apart from `name:` and `aliases:`.
 *
 * Two candidates under a rule, or one added file claimed by two rows, is
 * ambiguous and never guessed. Nothing else pairs: a file removed and
 * another added with the same source and destination is a teardown plus a
 * create (new id, backfill), as it was before renames existed.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { Types, type Model } from "mongoose";

import { SLUG_NAMED_KIND_NAME_MAX_LENGTH } from "@mako/schemas";
import { runGit } from "../apps/git";
import { DbtJob, Flow, RetiredObjectId } from "../database/workspace-schema";
import {
  jobFilePath,
  jobRenameTarget,
  parseJobFile,
  slugFromJobFilePath,
} from "../dbt/dbt-config-files";
import { loggers } from "../logging";
import {
  flowFilePath,
  flowRenameTarget,
  parseFlowFileResult,
  slugFromFlowFilePath,
} from "../services/flow-config-files";
import { capAliases } from "./alias-cap";

const logger = loggers.api("rename-slug-files");

/**
 * How long a rename commit is trusted to be on its way to the mirror's
 * main. Within it, a tree without the commit is older than the rename.
 * After it, the commit never landed and the tree is the truth again.
 */
export const RENAME_GUARD_MS = 10 * 60 * 1000;

/** The fields of a flow or dbt job row this module reads and writes. */
export interface SlugRow {
  _id: Types.ObjectId;
  slug?: string;
  name?: string;
  aliases?: string[];
  sourceBlobSha?: string;
  lastRenameCommit?: string;
  lastRenameAt?: Date;
  renameFromBlobSha?: string;
}

export type SlugFileRead =
  | { ok: true; name: string; aliases: string[]; target: string | null }
  | { ok: false; reason: string };

export interface SlugKind {
  kind: "flow" | "dbt_job";
  /** As a person says it: "flow", "dbt job". */
  noun: string;
  /** The two models share the fields of SlugRow and nothing else. */
  model: Model<any>;
  nameMaxLength: number;
  filePath(slug: string): string;
  slugOf(path: string): string | null;
  /** The file's name, aliases and target, or why it cannot be read. */
  read(contents: string): SlugFileRead;
}

export const FLOW_FILES: SlugKind = {
  kind: "flow",
  noun: "flow",
  model: Flow,
  nameMaxLength: SLUG_NAMED_KIND_NAME_MAX_LENGTH.flow,
  filePath: flowFilePath,
  slugOf: slugFromFlowFilePath,
  read(contents) {
    const parsed = parseFlowFileResult(contents);
    if (!parsed.ok) return parsed;
    const { name, aliases = [] } = parsed.file;
    return { ok: true, name, aliases, target: flowRenameTarget(parsed.file) };
  },
};

export const DBT_JOB_FILES: SlugKind = {
  kind: "dbt_job",
  noun: "dbt job",
  model: DbtJob,
  nameMaxLength: SLUG_NAMED_KIND_NAME_MAX_LENGTH.dbt_job,
  filePath: jobFilePath,
  slugOf: slugFromJobFilePath,
  read(contents) {
    const file = parseJobFile(contents);
    if (!file) {
      return {
        ok: false,
        reason: "not a valid job file (name, environment, commands)",
      };
    }
    const { name, aliases = [] } = file;
    return { ok: true, name, aliases, target: jobRenameTarget(file) };
  },
};

/**
 * Two oldest-first alias lists as one: deduplicated, never the current
 * slug, at most the newest MAX_ALIASES.
 */
export function mergedAliases(
  first: string[] | undefined,
  then: string[] | undefined,
  currentSlug: string | undefined,
): string[] {
  const out: string[] = [];
  for (const alias of [...(first ?? []), ...(then ?? [])]) {
    if (alias && alias !== currentSlug && !out.includes(alias)) out.push(alias);
  }
  return capAliases(out);
}

/**
 * The lookup rule over rows that might answer to `ref`: its id, then its
 * current slug, then an alias — and an alias two rows claim is nobody's.
 */
export function pickByRef<T extends SlugRow>(
  rows: T[],
  ref: string,
): { row: T; via: "current" | "alias" } | null {
  const current =
    rows.find(row => String(row._id) === ref) ??
    rows.find(row => row.slug === ref);
  if (current) return { row: current, via: "current" };
  const byAlias = rows.filter(row => (row.aliases ?? []).includes(ref));
  return byAlias.length === 1 ? { row: byAlias[0], via: "alias" } : null;
}

/** `scope` is the rows' owner: `{ workspaceId }` for flows, `{ projectId }` for jobs. */
export async function findByRef(
  kind: SlugKind,
  scope: Record<string, unknown>,
  ref: string,
): Promise<{ row: SlugRow; via: "current" | "alias" } | null> {
  const or: Record<string, unknown>[] = [{ slug: ref }, { aliases: ref }];
  if (/^[0-9a-f]{24}$/i.test(ref)) or.push({ _id: new Types.ObjectId(ref) });
  const rows = (await kind.model
    .find({ ...scope, $or: or })
    .lean()) as SlugRow[];
  return pickByRef(rows, ref);
}

/**
 * Move a row from slug `from` to `to` IN PLACE: same `_id`, so everything
 * keyed by it is untouched; `from` becomes an alias and `to` stops being
 * one. A targeted update, never `save()`: a legacy row that no longer
 * passes its schema must still be re-keyable. False when the row is no
 * longer at `from` (someone else moved or deleted it).
 */
export async function rekeyRow(
  kind: SlugKind,
  id: Types.ObjectId,
  from: string,
  to: string,
  guard: { commit: string; fromBlob?: string },
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const row = (await kind.model
    .findOne({ _id: id, slug: from })
    .select("aliases")
    .lean()) as SlugRow | null;
  if (!row) return false;
  const aliases = mergedAliases(row.aliases, [from], to);
  const unset: Record<string, 1> = {};
  if (aliases.length === 0) unset.aliases = 1;
  if (!guard.fromBlob) unset.renameFromBlobSha = 1;
  const result = await kind.model.updateOne(
    { _id: id, slug: from },
    {
      $set: {
        ...extra,
        slug: to,
        ...(aliases.length > 0 ? { aliases } : {}),
        lastRenameCommit: guard.commit,
        lastRenameAt: new Date(),
        ...(guard.fromBlob ? { renameFromBlobSha: guard.fromBlob } : {}),
      },
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    },
  );
  return result.matchedCount === 1;
}

// ---- ids --------------------------------------------------------------------

/** Record that `objectId` no longer names anything. Never throws. */
export async function retireObjectId(
  workspaceId: Types.ObjectId | string,
  kind: SlugKind["kind"],
  objectId: Types.ObjectId | string,
): Promise<void> {
  try {
    await RetiredObjectId.updateOne(
      {
        workspaceId: new Types.ObjectId(String(workspaceId)),
        kind,
        objectId: new Types.ObjectId(String(objectId)),
      },
      { $setOnInsert: { retiredAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    logger.warn("Could not record a retired id", {
      workspaceId: String(workspaceId),
      kind,
      objectId: String(objectId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The id for a file that has no row: the first derivation (generation 1 is
 * the id such a file has always had) not held by a row of ANOTHER slug and
 * not retired. A renamed row keeps its id, so a new file at its old name
 * gets the next one; so does a file at a deleted object's name. Decided
 * from the same rows by GET/list (which hands the id out) and the push
 * sync (which creates the row under it), so the two agree.
 */
export async function freeDerivedId(
  kind: SlugKind["kind"],
  workspaceId: string,
  slug: string,
  derive: (generation: number) => Types.ObjectId,
  rows: ReadonlyArray<{ _id: Types.ObjectId; slug?: string }>,
): Promise<Types.ObjectId> {
  const candidates = Array.from({ length: 32 }, (_, i) => derive(i + 1));
  const retired = new Set(
    (
      await RetiredObjectId.find({
        workspaceId: new Types.ObjectId(workspaceId),
        kind,
        objectId: { $in: candidates },
      })
        .select("objectId")
        .lean()
    ).map(entry => String(entry.objectId)),
  );
  const heldElsewhere = new Set(
    rows.filter(row => row.slug !== slug).map(row => String(row._id)),
  );
  return (
    candidates.find(
      id => !retired.has(String(id)) && !heldElsewhere.has(String(id)),
    ) ?? new Types.ObjectId()
  );
}

// ---- pairing ----------------------------------------------------------------

export type PairingRule = "alias" | "git" | "identical";

export interface RemovedSlug {
  slug: string;
  aliases: string[];
  /** What it points at (`flowRenameTarget` / `jobRenameTarget`); null = unknown. */
  target: string | null;
  /** The file as last synced; absent when it cannot be read back. */
  contents?: string;
}

export interface AddedSlug {
  slug: string;
  aliases: string[];
  target: string | null;
  contents?: string;
}

export interface SlugRenamePair {
  from: string;
  to: string;
  via: PairingRule;
}

/** The definition without the two keys a rename owns, comparably; null when it does not load. */
export function definitionIdentity(contents: string): string | null {
  let raw: unknown;
  try {
    raw = yaml.load(contents);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const {
    name: _name,
    aliases: _aliases,
    ...rest
  } = raw as Record<string, unknown>;
  return JSON.stringify(sortKeys(rest));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

/**
 * Which removed slugs are renamed added slugs (see the module note).
 * `gitRenames` is rule 2's input, removed slug → the added slugs git
 * matched it with (two when it could be either). With
 * `aliasOnly`, only an added file that names the removed slug pairs: what a
 * read may act on, where no tree has been verified.
 */
export function pairRenamedSlugs(input: {
  removed: RemovedSlug[];
  added: AddedSlug[];
  gitRenames?: ReadonlyMap<string, readonly string[]>;
  aliasOnly?: boolean;
}): {
  pairs: SlugRenamePair[];
  ambiguous: Array<{ slug: string; rule: PairingRule; candidates: string[] }>;
} {
  const { removed, added, gitRenames, aliasOnly = false } = input;
  const ambiguous: Array<{
    slug: string;
    rule: PairingRule;
    candidates: string[];
  }> = [];
  const sameTarget = (r: RemovedSlug, a: AddedSlug) =>
    r.target !== null && r.target === a.target;
  const identity = new Map(
    added.map(a => [
      a.slug,
      a.contents === undefined ? null : definitionIdentity(a.contents),
    ]),
  );
  const candidates: SlugRenamePair[] = [];
  for (const r of removed) {
    const own =
      r.contents === undefined ? null : definitionIdentity(r.contents);
    const rules: Array<[PairingRule, AddedSlug[]]> = [
      [
        "alias",
        // The reverse (a move back to an old name) only onto the same
        // target: a NEW flow pushed at an old name while the renamed one is
        // deleted is not that flow, and must not inherit its checkpoints.
        added.filter(
          a =>
            a.aliases.includes(r.slug) ||
            (!aliasOnly && r.aliases.includes(a.slug) && sameTarget(r, a)),
        ),
      ],
      [
        "git",
        added.filter(
          a => gitRenames?.get(r.slug)?.includes(a.slug) && sameTarget(r, a),
        ),
      ],
      [
        "identical",
        own === null ? [] : added.filter(a => identity.get(a.slug) === own),
      ],
    ];
    for (const [rule, found] of aliasOnly ? rules.slice(0, 1) : rules) {
      if (found.length === 0) continue;
      if (found.length === 1) {
        candidates.push({ from: r.slug, to: found[0].slug, via: rule });
      } else {
        ambiguous.push({
          slug: r.slug,
          rule,
          candidates: found.map(a => a.slug).sort(),
        });
      }
      break;
    }
  }
  // An added slug two removed slugs claim belongs to neither.
  const pairs = candidates.filter(pair => {
    const rivals = candidates.filter(other => other.to === pair.to);
    if (rivals.length === 1) return true;
    ambiguous.push({ slug: pair.from, rule: pair.via, candidates: [pair.to] });
    return false;
  });
  return { pairs, ambiguous };
}

// ---- git --------------------------------------------------------------------

const OID = /^[0-9a-f]{40}$/;

/** Whether `commit` is `tip` or in its history. An unknown commit is not. */
export async function isAncestorCommit(
  repoDir: string,
  commit: string,
  tip: string,
): Promise<boolean> {
  if (!OID.test(commit) || !OID.test(tip)) return false;
  return runGit(["-C", repoDir, "merge-base", "--is-ancestor", commit, tip])
    .then(() => true)
    .catch(() => false);
}

/** A blob's text by oid, or null when this repo does not have it. */
async function blobText(repoDir: string, oid: string): Promise<string | null> {
  if (!OID.test(oid)) return null;
  return runGit(["-C", repoDir, "cat-file", "blob", oid])
    .then(result => result.stdout)
    .catch(() => null);
}

async function treeOf(
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
 * Git's own rename detection over just these files: a tree of the removed
 * files at their last-synced blobs diffed against a tree of the added ones.
 * 90%, not git's default 50%: two flows share most of the format's
 * boilerplate. With `-C`, so that a removed file two added files resemble
 * is reported with BOTH (git alone would pick one). A git failure is "no
 * renames" — this feeds a decision that fails safe.
 */
export async function detectGitRenames(
  repoDir: string,
  removed: Array<{ path: string; oid: string }>,
  added: Array<{ path: string; oid: string }>,
): Promise<Map<string, string[]>> {
  const renames = new Map<string, string[]>();
  if (removed.length === 0 || added.length === 0) return renames;
  try {
    const { stdout } = await runGit([
      "-C",
      repoDir,
      "diff",
      "-M90%",
      "-C90%",
      "--name-status",
      "--diff-filter=RC",
      "-z",
      await treeOf(repoDir, removed),
      await treeOf(repoDir, added),
    ]);
    const parts = stdout.split("\0").filter(Boolean);
    // (R|C)<score> NUL <from> NUL <to>
    for (let i = 0; i + 2 < parts.length; i += 3) {
      const to = renames.get(parts[i + 1]) ?? [];
      renames.set(parts[i + 1], [...to, parts[i + 2]]);
    }
  } catch {
    return new Map();
  }
  return renames;
}

// ---- settling a tree against the rows ---------------------------------------

export interface SlugFileAtHead {
  slug: string;
  oid: string;
  aliases: string[];
  target: string | null;
  contents?: string;
}

/** Whether `head` is a tree read before this row's rename could reach it. */
async function treePredatesRename(
  repoDir: string,
  head: string,
  row: SlugRow,
): Promise<boolean> {
  if (!row.lastRenameCommit || !row.lastRenameAt) return false;
  if (Date.now() - new Date(row.lastRenameAt).getTime() > RENAME_GUARD_MS) {
    return false;
  }
  return !(await isAncestorCommit(repoDir, row.lastRenameCommit, head));
}

/**
 * Bring the rows level with the files at `head` where a file MOVED, before
 * the caller matches rows to files by slug:
 *
 *  - `renamed`: rows re-keyed in place (the pairing rules; on a `read`,
 *    only an added file that names the row's slug in its `aliases:`);
 *  - `ahead`: rows renamed by a commit this tree does not contain yet
 *    (another instance's rename whose mirror push has not landed), keyed by
 *    the OLD slug the tree still shows. That file is the row's own, as it
 *    was: nothing is created from it and the row is not a removal.
 *
 * `rows` are the caller's, read before the call; after a re-key they are
 * stale and the caller reads them again.
 */
export async function settleRenames(
  kind: SlugKind,
  args: {
    workspaceId: string;
    repoDir: string;
    head: string;
    files: SlugFileAtHead[];
    rows: SlugRow[];
    mode: "sync" | "read";
  },
): Promise<{ renamed: SlugRenamePair[]; ahead: Map<string, SlugRow> }> {
  const { workspaceId, repoDir, head, files, rows, mode } = args;
  const fileSlugs = new Set(files.map(file => file.slug));
  const rowSlugs = new Set(rows.map(row => row.slug));
  const ahead = new Map<string, SlugRow>();
  const gone: SlugRow[] = [];
  for (const row of rows) {
    if (!row.slug || fileSlugs.has(row.slug)) continue;
    const oldSlug = [...(row.aliases ?? [])]
      .reverse()
      .find(alias => fileSlugs.has(alias) && !rowSlugs.has(alias));
    if (oldSlug && (await treePredatesRename(repoDir, head, row))) {
      ahead.set(oldSlug, row);
    } else {
      gone.push(row);
    }
  }
  const added = files.filter(
    file => !rowSlugs.has(file.slug) && !ahead.has(file.slug),
  );
  if (gone.length === 0 || added.length === 0) return { renamed: [], ahead };

  const removed: RemovedSlug[] = [];
  const bases: Array<{ path: string; oid: string }> = [];
  for (const row of gone) {
    const slug = row.slug as string;
    let contents: string | undefined;
    if (mode === "sync") {
      // What main last had for this row. While its own rename is not in the
      // tree, that is the blob the rename STARTED from (it was on the
      // mirror, so it is here too); the blob the rename wrote may exist on
      // the renaming instance alone, and is then not readable here either.
      const oids = (await treePredatesRename(repoDir, head, row))
        ? [row.renameFromBlobSha, row.sourceBlobSha]
        : [row.sourceBlobSha, row.renameFromBlobSha];
      for (const oid of oids) {
        const text = oid ? await blobText(repoDir, oid) : null;
        if (oid && text !== null) {
          contents = text;
          bases.push({ path: kind.filePath(slug), oid });
          break;
        }
      }
    }
    const read = contents === undefined ? null : kind.read(contents);
    removed.push({
      slug,
      aliases: row.aliases ?? [],
      target: read?.ok ? read.target : null,
      contents,
    });
  }
  const gitRenames = new Map<string, string[]>();
  if (mode === "sync") {
    const detected = await detectGitRenames(
      repoDir,
      bases,
      added.map(file => ({ path: kind.filePath(file.slug), oid: file.oid })),
    );
    for (const [from, to] of detected) {
      const fromSlug = kind.slugOf(from);
      const slugs = to.flatMap(p => kind.slugOf(p) ?? []);
      if (fromSlug) gitRenames.set(fromSlug, slugs);
    }
  }
  const pairing = pairRenamedSlugs({
    removed,
    added,
    gitRenames,
    aliasOnly: mode === "read",
  });
  for (const entry of pairing.ambiguous) {
    logger.warn(`Ambiguous ${kind.noun} rename; not pairing`, {
      workspaceId,
      ...entry,
    });
  }
  const renamed: SlugRenamePair[] = [];
  for (const pair of pairing.pairs) {
    const row = gone.find(candidate => candidate.slug === pair.from);
    if (!row) continue;
    try {
      // Guarded by `head`: an instance whose tree is older than this move
      // must not read the row back to its old name.
      if (await rekeyRow(kind, row._id, pair.from, pair.to, { commit: head })) {
        renamed.push(pair);
        logger.info(`${kind.noun} re-keyed in place from a moved file`, {
          workspaceId,
          id: String(row._id),
          ...pair,
        });
      }
    } catch (error) {
      logger.warn(`Could not re-key a renamed ${kind.noun}`, {
        workspaceId,
        ...pair,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { renamed, ahead };
}
