/**
 * `connectors/` in the workspace repo -> the ConnectorDefinition index.
 *
 * The same arrangement skills, flows and dbt use: a push to main is the only
 * way a connector becomes usable, the repo is the truth, and Mongo is a
 * derived index that can be rebuilt from it at any time.
 *
 * WHAT A PUSH CAN AND CANNOT PROVE. A push carries no credential, so `check`,
 * `discover` and `read` have nothing to run against. What can be run is
 * `spec`, and what that proves is real: the connector starts, it is valid
 * JavaScript, it declares its config. That earns `indexed`, which is enough to
 * offer the connector in the picker so a credential can be entered. `verified`
 * is only ever set later, by an actual connection test against an actual data
 * source. Claiming more at push time would be a lie the UI would repeat.
 */
import { Types } from "mongoose";
import {
  ConnectorDefinition,
  SourceConnection,
  type IConnectorDefinition,
} from "../../database/workspace-schema";
import { ensureCommitLocally } from "../../apps/cloud-repo.service";
import { runGit } from "../../apps/git";
import { blobOid, repoDirFor } from "../../apps/repository.service";
import { capAliases } from "../../rename/alias-cap";
import { loggers } from "../../logging";
import {
  connectorFileIdentity,
  isValidSlug,
  parseConnectorFile,
  validateSpec,
  type ParseResult,
} from "./connector-file";
import {
  CONNECTORS_DIR,
  DEFAULT_ENTRY,
  LIVE_DEFINITION,
  UNBOUND_CONNECTOR_DEFINITION_ID,
  listConnectorFoldersAtMain,
  ensureConnectorRuntime,
} from "./resolver";
import {
  failureMessage,
  firstOfType,
  materializeConnector,
  runConnectorCommand,
  syncBoxContext,
} from "./sync-box";

const logger = loggers.connector();

/** `ws:` — SandboxedConnector's prefix; that module imports this one's peers. */
const TYPE_PREFIX = "ws:";

export interface ConnectorSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  blocked: number;
  /** Definitions whose folder left main: kept as tombstones. */
  removed: number;
  /** Tombstones whose folder came back at the same slug: the same id again. */
  revived: number;
  /** Folders a push moved: the definition was re-keyed in place. */
  renamed: Array<{ from: string; to: string }>;
  /** Slugs skipped without touching their row, with the reason. */
  skipped: Array<{ slug: string; reason: string }>;
}

const EMPTY: ConnectorSyncResult = {
  created: 0,
  updated: 0,
  unchanged: 0,
  blocked: 0,
  removed: 0,
  revived: 0,
  renamed: [],
  skipped: [],
};

/** Coalesce concurrent pushes without losing the newest tree in the burst. */
const inFlight = new Map<string, Promise<ConnectorSyncResult>>();
const rerunRequested = new Set<string>();

export function syncConnectorsFromRepo(
  workspaceId: string,
  actorUserId?: string,
): Promise<ConnectorSyncResult> {
  const existing = inFlight.get(workspaceId);
  if (existing) {
    // The active pass may already have resolved main. Remember this push and
    // read main again after it completes instead of acknowledging stale work.
    rerunRequested.add(workspaceId);
    return existing;
  }
  const work = (async () => {
    for (let staleRows = 0; ;) {
      try {
        const result = await reconcile(workspaceId, actorUserId);
        if (!rerunRequested.delete(workspaceId)) return result;
      } catch (error) {
        // A failed old pass must not consume a newer push. Retry when one is
        // pending; otherwise preserve the original failure for the caller.
        // A definition another writer saved during the pass (a rename made
        // in Mako) is not a failure: read the rows again.
        const stale =
          (error as Error | null)?.name === "VersionError" && staleRows++ < 2;
        if (!rerunRequested.delete(workspaceId) && !stale) throw error;
      }
    }
  })();
  const run = work.finally(() => {
    rerunRequested.delete(workspaceId);
    inFlight.delete(workspaceId);
  });
  inFlight.set(workspaceId, run);
  return run;
}

/** One reconcile pass: the tree it read and the rows it holds (and saves). */
interface Pass {
  workspaceId: string;
  commit: string;
  /** Live definitions by slug. The pass edits THESE documents, never copies. */
  rowBySlug: Map<string, IConnectorDefinition>;
  /** Definitions whose folder is off main, by the slug they had. */
  tombstones: Map<string, IConnectorDefinition>;
  /** Folders under `connectors/` in this tree. */
  inTree: Set<string>;
  /** Old names two or more folders newly claim in this tree: nobody's. */
  contested: Set<string>;
  result: ConnectorSyncResult;
}

async function reconcile(
  workspaceId: string,
  _actorUserId?: string,
): Promise<ConnectorSyncResult> {
  const { commit, slugs, filesBySlug, oversized } =
    await listConnectorFoldersAtMain(workspaceId);
  if (!commit) return { ...EMPTY };

  const rows = await ConnectorDefinition.find({ workspaceId });
  const result: ConnectorSyncResult = { ...EMPTY, renamed: [], skipped: [] };
  const pass: Pass = {
    workspaceId,
    commit,
    rowBySlug: new Map(rows.filter(r => !r.removedAt).map(r => [r.slug, r])),
    tombstones: new Map(rows.filter(r => r.removedAt).map(r => [r.slug, r])),
    inTree: new Set(slugs),
    contested: new Set(),
    result,
  };
  const { rowBySlug } = pass;

  const decoder = new TextDecoder();
  const parsedBySlug = new Map<string, ParseResult>();
  for (const slug of slugs) {
    const yamlBytes = filesBySlug.get(slug)?.get("connector.yaml");
    if (yamlBytes && isValidSlug(slug)) {
      parsedBySlug.set(slug, parseConnectorFile(decoder.decode(yamlBytes)));
    }
  }
  pass.contested = contestedAliases(pass, parsedBySlug);

  // RENAMES FIRST. A folder that left while another appeared is a rename
  // when the new connector.yaml names the old slug in `aliases`, or when git
  // pairs the two entry files between the commit the definition last read
  // and this one. The definition is re-keyed in place (same id, same status,
  // old slug kept as an alias) and its connections' `type` follows.
  for (const [to, from] of await detectRenames(pass, parsedBySlug)) {
    const row = rowBySlug.get(from);
    if (!row || rowBySlug.has(to)) continue;
    await takeSlug(pass, to, String(row._id));
    // Its own connections FIRST, then the definition: a pass that stops in
    // between leaves them bound by id to a row that still says `from` (they
    // keep running it), and the next pass finishes the move.
    await migrateSourceConnectionType(workspaceId, from, to, {
      definitionId: String(row._id),
      includeUnbound: true,
    });
    const parsed = parsedBySlug.get(to);
    rekeyDefinition(row, to, commit, {
      // Only git knows about this move when the file does not say it.
      detected: !(parsed?.ok && parsed.value.aliases.includes(from)),
    });
    await row.save();
    rowBySlug.delete(from);
    rowBySlug.set(to, row);
    result.renamed.push({ from, to });
  }

  const seen = new Set<string>();
  for (const slug of slugs) {
    const files = filesBySlug.get(slug) ?? new Map<string, Uint8Array>();

    // Too big to read, so its contents were never loaded. Block it with the
    // size in the message: the folder plainly exists, and "not found" for
    // something the author can see in the repo explains nothing.
    const tooBig = oversized.get(slug);
    if (tooBig) {
      seen.add(slug);
      await block(pass, slug, commit, tooBig);
      continue;
    }

    if (!isValidSlug(slug)) {
      result.skipped.push({
        slug,
        reason:
          "A connector folder must be named as a lowercase slug, e.g. connectors/acme-crm/",
      });
      continue;
    }

    const parsed = parsedBySlug.get(slug);
    if (!parsed) {
      // No connector.yaml at all means this folder is not claiming to be a
      // connector. Skipping rather than blocking keeps a stray directory from
      // producing an error nobody asked for.
      result.skipped.push({ slug, reason: "no connector.yaml" });
      continue;
    }
    seen.add(slug);

    if (!parsed.ok) {
      await block(pass, slug, sourceShaOf(files), parsed.reason);
      continue;
    }

    if (!files.get(parsed.value.entry)) {
      await block(
        pass,
        slug,
        sourceShaOf(files),
        `connector.yaml points at "${parsed.value.entry}", which is not in the folder.`,
      );
      continue;
    }

    const sourceSha = sourceShaOf(files);
    // A folder back at the slug of a definition whose folder had left main,
    // while no other definition took that slug: the SAME definition again.
    const revived = !rowBySlug.has(slug) && (await revive(pass, slug));
    const row = rowBySlug.get(slug);
    const { aliases, retired } = mergedAliases(
      pass,
      row,
      parsed.value.aliases,
      slug,
    );
    if (row) row.retiredAliases = retired;
    if (row && row.sourceSha === sourceSha && row.status !== "blocked") {
      // Unchanged content: keep the row, and with it a `verified` status that
      // a real connection test earned. Re-running spec here would demote it.
      // `entry` is still backfilled: a row indexed before it was stored
      // defaults to connector.ts, and a connector whose yaml names another
      // file would otherwise keep running the wrong one forever.
      if (
        revived ||
        row.sha !== commit ||
        row.entry !== parsed.value.entry ||
        row.isModified("retiredAliases") ||
        (row.aliases ?? []).join("\0") !== aliases.join("\0")
      ) {
        row.sha = commit;
        row.entry = parsed.value.entry;
        row.aliases = aliases;
        await row.save();
      }
      result.unchanged++;
      continue;
    }

    try {
      const spec = await runSpec(
        workspaceId,
        slug,
        sourceSha,
        files,
        parsed.value.entry,
      );
      if (!spec.ok) {
        await block(pass, slug, sourceSha, spec.reason);
        continue;
      }
      const entities = Object.keys((spec.spec?.mako as any)?.entities ?? {});
      const indexed = {
        runtime: parsed.value.runtime,
        entry: parsed.value.entry,
        sha: commit,
        sourceSha,
        spec: spec.spec,
        status: "indexed" as const,
        entities,
        hasIcon: files.has("icon.svg"),
        aliases,
      };
      if (row) {
        row.set({
          ...indexed,
          blockedReason: undefined,
          // New code, so the last check proved nothing about what runs now.
          lastCheckError: undefined,
        });
        await row.save();
        result.updated++;
      } else {
        await takeSlug(pass, slug);
        rowBySlug.set(
          slug,
          await ConnectorDefinition.create({
            workspaceId,
            slug,
            ...indexed,
            retiredAliases: retired,
          }),
        );
        result.created++;
      }
    } catch (error) {
      // One connector that cannot be run must not abort the push: the others
      // in the same commit are independent and have to land.
      const reason = error instanceof Error ? error.message : String(error);
      logger.error("Failed to index a workspace connector", {
        workspaceId,
        slug,
        reason,
      });
      await block(pass, slug, sourceSha, reason);
    }
  }

  // A definition whose folder left main is KEPT, as a tombstone nothing
  // resolves to: its connections fail closed, and the same folder coming
  // back at the same slug is the same definition (`revive`). Deleting the
  // row instead would make a restored folder a new definition, leaving
  // every connection bound to the old one closed until re-saved by hand.
  for (const row of [...rowBySlug.values()]) {
    if (seen.has(row.slug)) continue;
    row.removedAt = new Date();
    await row.save();
    rowBySlug.delete(row.slug);
    pass.tombstones.set(row.slug, row);
    result.removed++;
  }

  return result;
}

/** How alike two entry files must be for git to call a folder move a rename. */
export const CONNECTOR_RENAME_SIMILARITY = 75;

/**
 * Old names that two or more folders of this tree newly list in `aliases`.
 * Such a name is given to neither: an old name that could mean two
 * connectors must mean none, so `ws:<name>` resolves to nothing and no
 * connection follows either claim.
 */
function contestedAliases(
  pass: Pass,
  parsedBySlug: Map<string, ParseResult>,
): Set<string> {
  const claims = new Map<string, number>();
  for (const [slug, parsed] of parsedBySlug) {
    if (!parsed.ok) continue;
    const row = pass.rowBySlug.get(slug);
    for (const alias of parsed.value.aliases) {
      if (
        alias === slug ||
        (row?.aliases ?? []).includes(alias) ||
        (row?.retiredAliases ?? []).includes(alias)
      ) {
        continue;
      }
      claims.set(alias, (claims.get(alias) ?? 0) + 1);
    }
  }
  return new Set([...claims].filter(([, n]) => n > 1).map(([alias]) => alias));
}

/**
 * The definition's alias list after a pass, and what it must never answer
 * to again: the file's `aliases` plus what git detected, minus retired
 * names. A name NEW to this definition is refused (and retired for it, so
 * the file cannot bring it back) when a live connector holds it as its
 * slug, another one already lists or retired it, or two folders claim it at
 * once: a copied folder does not inherit the original's old names.
 */
function mergedAliases(
  pass: Pass,
  row: IConnectorDefinition | undefined,
  fromFile: string[],
  slug: string,
): { aliases: string[]; retired: string[] } {
  const retired = new Set(row?.retiredAliases ?? []);
  const held = new Set(row?.aliases ?? []);
  const others = [...pass.rowBySlug.values()].filter(r => r !== row);
  const aliases: string[] = [];
  for (const alias of new Set([...fromFile, ...(row?.detectedAliases ?? [])])) {
    if (alias === slug || retired.has(alias)) continue;
    if (!held.has(alias)) {
      const owner = others.find(
        r =>
          (pass.inTree.has(r.slug) &&
            (r.slug === alias || (r.aliases ?? []).includes(alias))) ||
          (r.retiredAliases ?? []).includes(alias),
      );
      if (owner || pass.contested.has(alias)) {
        retired.add(alias);
        logger.warn(
          "A workspace connector lists an old name that is not its own; dropped for it",
          { workspaceId: pass.workspaceId, slug, alias, owner: owner?.slug },
        );
        continue;
      }
    }
    aliases.push(alias);
  }
  return { aliases: capAliases(aliases), retired: [...retired] };
}

/**
 * Pair folders that appeared with live definitions whose folder left in
 * the same push. Returns new slug → old slug. Two signals:
 *   1. the new folder's connector.yaml lists exactly one such old slug;
 *   2. git's rename detection, between the commit the definition last read
 *      and this one, pairs the ENTRY files (the code: a connector.yaml is
 *      three lines and alike across connectors) at
 *      {@link CONNECTOR_RENAME_SIMILARITY} or more.
 * A tombstone is never a candidate: it comes back only at its own slug.
 */
async function detectRenames(
  pass: Pass,
  parsedBySlug: Map<string, ParseResult>,
): Promise<Map<string, string>> {
  const { rowBySlug, inTree, contested } = pass;
  const gone = new Map(
    [...rowBySlug.values()]
      .filter(row => !inTree.has(row.slug) && !contested.has(row.slug))
      .map(row => [row.slug, row]),
  );
  const appeared = new Set(
    [...parsedBySlug.keys()].filter(slug => !rowBySlug.has(slug)),
  );
  const out = new Map<string, string>();
  if (gone.size === 0 || appeared.size === 0) return out;
  const claimed = new Set<string>();
  const claim = (to: string, from: string) => {
    if (out.has(to) || claimed.has(from)) return;
    out.set(to, from);
    claimed.add(from);
  };

  for (const slug of appeared) {
    const parsed = parsedBySlug.get(slug);
    if (!parsed?.ok) continue;
    const old = parsed.value.aliases.filter(alias => gone.has(alias));
    if (old.length === 1) claim(slug, old[0]);
  }

  const repoDir = repoDirFor(pass.workspaceId);
  // One diff per (commit, entry file), however many folders left at once.
  const diffs = new Map<string, Promise<Map<string, string>>>();
  for (const row of gone.values()) {
    if (claimed.has(row.slug) || !row.sha) continue;
    const entry = row.entry || DEFAULT_ENTRY;
    const key = `${row.sha}\0${entry}`;
    if (!diffs.has(key)) {
      diffs.set(
        key,
        // Another replica may have indexed a commit this one has not fetched.
        ensureCommitLocally(pass.workspaceId, row.sha)
          .catch(() => {})
          .then(() =>
            renamedFoldersBetween(repoDir, row.sha, pass.commit, entry),
          ),
      );
    }
    const to = (await diffs.get(key))?.get(row.slug);
    if (to && appeared.has(to)) claim(to, row.slug);
  }
  return out;
}

/**
 * Old folder → new folder for every `connectors/<old>/<entry>` git reports
 * as renamed to `connectors/<new>/<entry>` between two commits. Empty,
 * never a throw, when either commit is unknown here.
 */
async function renamedFoldersBetween(
  repoDir: string,
  fromCommit: string,
  toCommit: string,
  entry: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (fromCommit === toCommit) return out;
  let stdout: string;
  try {
    ({ stdout } = await runGit(
      [
        "-C",
        repoDir,
        "diff",
        "--name-status",
        `-M${CONNECTOR_RENAME_SIMILARITY}%`,
        "-z",
        "--diff-filter=R",
        fromCommit,
        toCommit,
        "--",
        CONNECTORS_DIR,
      ],
      { timeoutMs: 60_000 },
    ));
  } catch {
    return out;
  }
  // -z output: R<score>\0<old>\0<new>\0 per rename.
  const fields = stdout.split("\0");
  const folderOf = (file: string): string | null => {
    const [dir, folder, ...rest] = file.split("/");
    return dir === CONNECTORS_DIR && rest.join("/") === entry ? folder : null;
  };
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const from = folderOf(fields[i + 1]);
    const to = folderOf(fields[i + 2]);
    if (fields[i].startsWith("R") && from && to && from !== to) {
      out.set(from, to);
    }
  }
  return out;
}

/**
 * Re-key a definition to `to` in place: the slug it had becomes an alias
 * (unless it was retired), and `to` is its own again whatever its past.
 * The caller moves the connections first and saves the row last.
 */
export function rekeyDefinition(
  row: IConnectorDefinition,
  to: string,
  commit: string,
  options: { detected?: boolean } = {},
): void {
  const from = row.slug;
  const retired = row.retiredAliases ?? [];
  row.slug = to;
  // The commit where `connectors/<to>/` exists: a definition re-keyed but
  // still pinned to a commit before the move would read a missing folder.
  row.sha = commit;
  if (options.detected) {
    row.detectedAliases = [
      ...new Set([...(row.detectedAliases ?? []), from]),
    ].filter(alias => alias !== to);
  }
  row.aliases = capAliases(
    [...new Set([...(row.aliases ?? []), from])].filter(
      alias => alias !== to && !retired.includes(alias),
    ),
  );
  row.retiredAliases = retired.filter(alias => alias !== to);
}

/**
 * Set `type` to `ws:<to>` on the connections of `ws:<from>` that belong to
 * one definition: those bound to it and, with `includeUnbound`, those not
 * bound yet, which are bound to it now. Only `type` and the binding change;
 * the stored config is not read. Idempotent.
 */
export async function migrateSourceConnectionType(
  workspaceId: string,
  from: string,
  to: string,
  options: { definitionId: string; includeUnbound?: boolean },
): Promise<number> {
  if (from === to) return 0;
  const result = await SourceConnection.updateMany(
    {
      workspaceId,
      type: `${TYPE_PREFIX}${from}`,
      $or: [
        { connectorDefinitionId: options.definitionId },
        ...(options.includeUnbound ? [{ connectorDefinitionId: null }] : []),
      ],
    },
    {
      $set: {
        type: `${TYPE_PREFIX}${to}`,
        connectorDefinitionId: options.definitionId,
      },
    },
  );
  if (result.modifiedCount > 0) {
    logger.info("Moved source connections to a renamed workspace connector", {
      workspaceId,
      from,
      to,
      count: result.modifiedCount,
    });
  }
  return result.modifiedCount;
}

/**
 * The folder of a tombstoned definition is back at its slug, and no other
 * definition took the slug in between (that drops the tombstone,
 * `takeSlug`): the same definition, same id, so the connections bound to
 * it resolve again without being re-saved. Deleting a folder and restoring
 * it at the same path is, for the binding, an edit of that connector's
 * code in place, which a push to main can already make.
 */
async function revive(pass: Pass, slug: string): Promise<boolean> {
  const row = pass.tombstones.get(slug);
  if (!row) return false;
  await releaseAliasClaim(pass, slug);
  // An old name another connector started answering to meanwhile stays its.
  const others = [...pass.rowBySlug.values()];
  row.aliases = (row.aliases ?? []).filter(
    alias =>
      !others.some(r => r.slug === alias || (r.aliases ?? []).includes(alias)),
  );
  row.set("removedAt", undefined);
  pass.tombstones.delete(slug);
  pass.rowBySlug.set(slug, row);
  pass.result.revived++;
  logger.info("A workspace connector's folder is back; same definition", {
    workspaceId: pass.workspaceId,
    slug,
    definitionId: String(row._id),
  });
  return true;
}

/**
 * A definition is about to take `slug` as its live name: a new folder, or
 * one renamed there (`takerId`). The live name wins over any alias, but the
 * connections still typed `ws:<slug>` were saved for something else, so
 * before the name changes hands:
 *
 *  - definitions that list `slug` as an alias give it up for good;
 *  - a tombstone at `slug` is dropped: its connections stay closed until
 *    re-saved, they are not given to the definition taking the name;
 *  - a connection bound to another live definition keeps it, and its
 *    `type` is set to that definition's current slug;
 *  - a connection not bound yet is locked with the placeholder binding.
 */
async function takeSlug(
  pass: Pass,
  slug: string,
  takerId?: string,
): Promise<void> {
  await releaseAliasClaim(pass, slug, takerId);
  const tombstone = pass.tombstones.get(slug);
  if (tombstone) {
    await ConnectorDefinition.deleteOne({ _id: tombstone._id });
    pass.tombstones.delete(slug);
    logger.warn(
      "A removed workspace connector's slug was taken by another definition",
      {
        workspaceId: pass.workspaceId,
        slug,
        definitionId: String(tombstone._id),
      },
    );
  }
  await retypeBoundElsewhere(pass.workspaceId, slug, takerId);
  await lockUnboundConnections(pass.workspaceId, slug);
}

/**
 * Live definitions that list `slug` as an alias stop: their own connections
 * still typed `ws:<slug>` get their current slug, and the name is retired
 * for them (the file may keep listing it; a sync cannot edit the file).
 * Edits the pass's own documents: a fresh copy would be overwritten when
 * the pass saves its stale one.
 */
async function releaseAliasClaim(
  pass: Pass,
  slug: string,
  exceptId?: string,
): Promise<void> {
  for (const claimant of pass.rowBySlug.values()) {
    if (
      !(claimant.aliases ?? []).includes(slug) ||
      String(claimant._id) === exceptId
    ) {
      continue;
    }
    await migrateSourceConnectionType(pass.workspaceId, slug, claimant.slug, {
      definitionId: String(claimant._id),
    });
    claimant.aliases = claimant.aliases.filter(alias => alias !== slug);
    claimant.detectedAliases = (claimant.detectedAliases ?? []).filter(
      alias => alias !== slug,
    );
    claimant.retiredAliases = [
      ...new Set([...(claimant.retiredAliases ?? []), slug]),
    ];
    await claimant.save();
    logger.warn(
      "A workspace connector took a slug another connector was known by",
      { workspaceId: pass.workspaceId, slug, previousOwner: claimant.slug },
    );
  }
}

/**
 * Connections typed `ws:<slug>` but bound to another LIVE definition get
 * that definition's current slug as their type. Returns how many moved.
 */
export async function retypeBoundElsewhere(
  workspaceId: string,
  slug: string,
  takerId?: string,
): Promise<number> {
  const bound = await SourceConnection.distinct("connectorDefinitionId", {
    workspaceId,
    type: `${TYPE_PREFIX}${slug}`,
    connectorDefinitionId: { $ne: null },
  });
  const ids = bound
    .map(id => String(id))
    .filter(id => id !== takerId && id !== UNBOUND_CONNECTOR_DEFINITION_ID);
  if (ids.length === 0) return 0;
  const owners = await ConnectorDefinition.find({
    workspaceId,
    _id: { $in: ids },
    ...LIVE_DEFINITION,
  });
  let moved = 0;
  for (const owner of owners) {
    moved += await migrateSourceConnectionType(workspaceId, slug, owner.slug, {
      definitionId: String(owner._id),
    });
  }
  return moved;
}

/**
 * Lock the connections typed `ws:<slug>` that are bound to nothing (saved
 * before bindings existed): they resolve by current slug, and the slug is
 * about to be another definition's. Returns how many.
 */
async function lockUnboundConnections(
  workspaceId: string,
  slug: string,
): Promise<number> {
  // The raw collection, both id forms: a row an old writer stored with a
  // string workspace id is one the model's cast would never match.
  const result = await SourceConnection.collection.updateMany(
    {
      workspaceId: { $in: [new Types.ObjectId(workspaceId), workspaceId] },
      type: `${TYPE_PREFIX}${slug}`,
      connectorDefinitionId: null,
    },
    {
      $set: {
        connectorDefinitionId: new Types.ObjectId(
          UNBOUND_CONNECTOR_DEFINITION_ID,
        ),
      },
    },
  );
  if (result.modifiedCount > 0) {
    logger.warn(
      "A connector took a name that connections saved before bindings still carry; they stay closed until re-saved",
      { workspaceId, slug, connections: result.modifiedCount },
    );
  }
  return result.modifiedCount;
}

/**
 * The identity of a folder's contents.
 *
 * Every file, not just the entry: a connector split across modules changes
 * when any of them changes, and hashing only `connector.ts` would serve a
 * stale copy of everything it imports. `connector.yaml` counts without its
 * `aliases` (a rename's only edit), so a rename is not new code.
 */
export function sourceShaOf(files: Map<string, Uint8Array>): string {
  const parts: string[] = [];
  for (const name of [...files.keys()].sort()) {
    const bytes = Buffer.from(files.get(name) as Uint8Array);
    const contents =
      name === "connector.yaml"
        ? Buffer.from(connectorFileIdentity(bytes.toString("utf8")), "utf8")
        : bytes;
    parts.push(`${name}:${blobOid(contents)}`);
  }
  return blobOid(parts.join("\n"));
}

async function runSpec(
  workspaceId: string,
  slug: string,
  sourceSha: string,
  files: Map<string, Uint8Array>,
  entry: string,
): Promise<
  { ok: true; spec: Record<string, unknown> } | { ok: false; reason: string }
> {
  const ctx = syncBoxContext(workspaceId);
  const runtimeId = await ensureConnectorRuntime(ctx);
  const dir = await materializeConnector({
    ctx,
    runtimeId,
    slug,
    sourceSha,
    files,
  });

  const result = await runConnectorCommand({
    ctx,
    runtimeId,
    connectorDir: dir,
    command: "spec",
    entry,
    timeoutMs: 60_000,
  });

  const failure = failureMessage(result);
  if (failure) return { ok: false, reason: failure };

  const message = firstOfType<{ spec?: Record<string, unknown> }>(
    result.messages,
    "SPEC",
  );
  const validation = validateSpec(message?.spec);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  return { ok: true, spec: message!.spec! };
}

/** Mark the folder at `slug` blocked, on its own definition when it has one. */
async function block(
  pass: Pass,
  slug: string,
  sourceSha: string,
  reason: string,
): Promise<void> {
  pass.result.blocked++;
  const { commit: sha, workspaceId } = pass;
  if (!pass.rowBySlug.has(slug)) await revive(pass, slug);
  const row = pass.rowBySlug.get(slug);
  if (row) {
    row.set({ sha, sourceSha, status: "blocked", blockedReason: reason });
    await row.save();
    return;
  }
  await takeSlug(pass, slug);
  pass.rowBySlug.set(
    slug,
    await ConnectorDefinition.create({
      workspaceId,
      slug,
      runtime: "node",
      sha,
      sourceSha,
      status: "blocked",
      blockedReason: reason,
      entities: [],
    }),
  );
}

/**
 * Record the outcome of a real connection test.
 *
 * The only path that may write `verified`, because it is the only one that has
 * a credential to prove it with.
 */
export async function recordConnectionCheck(input: {
  workspaceId: string;
  slug: string;
  /** The definition the connection is bound to; decides over `slug`. */
  definitionId?: string;
  /** The indexed source revision the connector instance actually ran. */
  sourceSha: string;
  success: boolean;
  message?: string;
}): Promise<boolean> {
  const { workspaceId, slug, sourceSha, success, message } = input;
  const result = await ConnectorDefinition.updateOne(
    // A blocked connector is blocked by its code, which a credential cannot
    // fix; it must not be talked back up to `verified` by a check that could
    // not have run against it in the first place.
    {
      workspaceId,
      ...(input.definitionId ? { _id: input.definitionId } : { slug }),
      ...LIVE_DEFINITION,
      sourceSha,
      status: { $ne: "blocked" },
    },
    success
      ? {
          $set: { status: "verified", lastCheckedAt: new Date() },
          $unset: { lastCheckError: "" },
        }
      : {
          // Demoted, not blocked: the connector still runs, this credential
          // does not. It stays offerable so the key can be corrected, and it
          // stops claiming a verification that no longer holds.
          $set: {
            status: "indexed",
            lastCheckedAt: new Date(),
            lastCheckError: message ?? "Connection test failed",
          },
        },
  );
  return result.matchedCount === 1;
}
