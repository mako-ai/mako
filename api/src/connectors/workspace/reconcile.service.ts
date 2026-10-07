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
import { blobOid, repoDirFor } from "../../apps/repository.service";
import { renamedFoldersBetween } from "../../rename/git-renames";
import { loggers } from "../../logging";
import {
  connectorFileIdentity,
  isValidSlug,
  parseConnectorFile,
  validateSpec,
} from "./connector-file";
import {
  CONNECTORS_DIR,
  DEFAULT_ENTRY,
  UNBOUND_CONNECTOR_DEFINITION_ID,
  findConnectorDefinitionFor,
  listConnectorFoldersAtMain,
  ensureConnectorRuntime,
} from "./resolver";
import { WORKSPACE_TYPE_PREFIX } from "./SandboxedConnector";
import {
  failureMessage,
  firstOfType,
  materializeConnector,
  runConnectorCommand,
  syncBoxContext,
} from "./sync-box";

const logger = loggers.connector();

export interface ConnectorSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  blocked: number;
  removed: number;
  /** Folders a push moved: the row was re-keyed in place, not recreated. */
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
    for (;;) {
      try {
        const result = await reconcile(workspaceId, actorUserId);
        if (!rerunRequested.delete(workspaceId)) return result;
      } catch (error) {
        // A failed old pass must not consume a newer push. Retry when one is
        // pending; otherwise preserve the original failure for the caller.
        if (!rerunRequested.delete(workspaceId)) throw error;
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

async function reconcile(
  workspaceId: string,
  _actorUserId?: string,
): Promise<ConnectorSyncResult> {
  const { commit, slugs, filesBySlug, oversized } =
    await listConnectorFoldersAtMain(workspaceId);
  if (!commit) return { ...EMPTY };

  const rows = await ConnectorDefinition.find({ workspaceId });
  const rowBySlug = new Map(rows.map(row => [row.slug, row]));
  // Names each row had given up BEFORE this pass. A fold below honours a
  // yaml that lists a deleted slug only when that row had not already had
  // it taken away (a stale template copy); a claim retired during THIS
  // pass — because another folder in the same push listed it too — is a
  // second statement, which makes the fold ambiguous, not void.
  const retiredAtStart = new Map(
    rows.map(row => [String(row._id), new Set(row.retiredAliases ?? [])]),
  );

  const result: ConnectorSyncResult = { ...EMPTY, renamed: [], skipped: [] };
  const seen = new Set<string>();
  const inTree = new Set(slugs);
  /** What each folder's connector.yaml lists this pass (for explicit folds). */
  const fileAliasesBySlug = new Map<string, string[]>();

  // RENAMES FIRST (api/src/rename rule 3). A folder that disappeared while
  // another appeared is a rename when the new connector.yaml names the old
  // slug in `aliases`, when git's own rename detection pairs the two
  // folders between the commit the row last read and this one, or when the
  // folder's content is byte-identical. The row is re-keyed in place — same
  // _id, same status, old slug recorded as an alias — and every
  // `SourceConnection.type = "ws:<old>"` is moved to the new slug. Before
  // this, the old row was deleted and the new slug created fresh, which
  // stranded every connection of that type (its config schema, and so its
  // secret-field list, could no longer be resolved).
  for (const [to, from] of await detectRenames(
    workspaceId,
    commit,
    slugs,
    filesBySlug,
    rows,
  )) {
    const row = rowBySlug.get(from);
    if (!row || rowBySlug.has(to)) continue;
    // Taking `to` as a live slug: whoever still answered to it as an alias
    // must stop, and ITS connections typed ws:<to> move to its current
    // slug first — never over to this connector's code.
    await releaseAliasClaim(workspaceId, to, String(row._id), rowBySlug);
    // Connections still typed ws:<to> are not this connector's: bound ones
    // keep their own definition (type fixed), unbound ones are pinned
    // closed. A push cannot refuse (the UI rename does, with 409).
    await prepareSlugTakeover(workspaceId, to, String(row._id));
    row.slug = to;
    // Git detected this rename (the file may carry no alias): remembered
    // apart from the file's list so a later file edit cannot drop it.
    row.detectedAliases = [
      ...new Set([...(row.detectedAliases ?? []), from]),
    ].filter(a => a !== to);
    row.aliases = [...new Set([...(row.aliases ?? []), from])].filter(
      a => a !== to && !(row.retiredAliases ?? []).includes(a),
    );
    // The live slug is this connector's again, whatever its past.
    row.retiredAliases = (row.retiredAliases ?? []).filter(a => a !== to);
    await row.save();
    rowBySlug.delete(from);
    rowBySlug.set(to, row);
    // Its own connections: bound to this row, or legacy ones typed by the
    // slug it held until now (bound by this move).
    await migrateSourceConnectionType(workspaceId, from, to, {
      definitionId: String(row._id),
      includeUnstamped: true,
    });
    result.renamed.push({ from, to });
  }

  for (const slug of slugs) {
    const files = filesBySlug.get(slug) ?? new Map<string, Uint8Array>();

    // Too big to read, so its contents were never loaded. Block it with the
    // size in the message: the folder plainly exists, and "not found" for
    // something the author can see in the repo explains nothing.
    const tooBig = oversized.get(slug);
    if (tooBig) {
      seen.add(slug);
      await block(
        workspaceId,
        slug,
        commit,
        commit,
        tooBig,
        rowBySlug.get(slug),
        rowBySlug,
      );
      result.blocked++;
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

    const yamlBytes = files.get("connector.yaml");
    if (!yamlBytes) {
      // No connector.yaml at all means this folder is not claiming to be a
      // connector. Skipping rather than blocking keeps a stray directory from
      // producing an error nobody asked for.
      result.skipped.push({ slug, reason: "no connector.yaml" });
      continue;
    }
    seen.add(slug);

    const decoder = new TextDecoder();
    const parsed = parseConnectorFile(decoder.decode(yamlBytes));
    const row = rowBySlug.get(slug);

    if (!parsed.ok) {
      await block(
        workspaceId,
        slug,
        commit,
        sourceShaOf(files),
        parsed.reason,
        row,
        rowBySlug,
      );
      result.blocked++;
      continue;
    }

    const entryBytes = files.get(parsed.value.entry);
    if (!entryBytes) {
      await block(
        workspaceId,
        slug,
        commit,
        sourceShaOf(files),
        `connector.yaml points at "${parsed.value.entry}", which is not in the folder.`,
        row,
        rowBySlug,
      );
      result.blocked++;
      continue;
    }

    const sourceSha = sourceShaOf(files);
    // The row's aliases = the file's (the record that travels) ∪ what git
    // detected on a push that carried none − retired ones − anything a
    // live slug or another row already answers to (first claimant keeps
    // it; a copied folder's aliases are dropped, and retired, for the
    // copy — as a copied flow or app loses its identity).
    fileAliasesBySlug.set(slug, parsed.value.aliases);
    const aliases = await mergedAliases(
      workspaceId,
      row,
      parsed.value.aliases,
      slug,
      rowBySlug,
      inTree,
    );
    if (row && row.sourceSha === sourceSha && row.status !== "blocked") {
      // Unchanged content: keep the row, and with it a `verified` status that
      // a real connection test earned. Re-running spec here would demote it.
      // `entry` is still backfilled: a row indexed before it was stored
      // defaults to connector.ts, and a connector whose yaml names another
      // file would otherwise keep running the wrong one forever.
      if (
        row.sha !== commit ||
        row.entry !== parsed.value.entry ||
        !sameList(row.aliases ?? [], aliases)
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
        await block(
          workspaceId,
          slug,
          commit,
          sourceSha,
          spec.reason,
          row,
          rowBySlug,
        );
        result.blocked++;
        continue;
      }
      const entities = Object.keys((spec.spec?.mako as any)?.entities ?? {});
      if (row) {
        row.set({
          runtime: parsed.value.runtime,
          entry: parsed.value.entry,
          sha: commit,
          sourceSha,
          spec: spec.spec,
          status: "indexed",
          blockedReason: undefined,
          // New code, so the last check proved nothing about what runs now.
          lastCheckError: undefined,
          entities,
          hasIcon: files.has("icon.svg"),
          aliases,
        });
        await row.save();
        result.updated++;
      } else {
        await releaseAliasClaim(workspaceId, slug, undefined, rowBySlug);
        await prepareSlugTakeover(workspaceId, slug);
        const created = await ConnectorDefinition.create({
          workspaceId,
          slug,
          runtime: parsed.value.runtime,
          entry: parsed.value.entry,
          sha: commit,
          sourceSha,
          spec: spec.spec,
          status: "indexed",
          entities,
          hasIcon: files.has("icon.svg"),
          aliases,
          // What the file listed but another connector already holds is
          // retired for this newcomer, so it never comes back from the file.
          retiredAliases: parsed.value.aliases.filter(
            a => !aliases.includes(a) && a !== slug,
          ),
        });
        rowBySlug.set(slug, created);
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
      await block(
        workspaceId,
        slug,
        commit,
        sourceSha,
        reason,
        rowBySlug.get(slug),
        rowBySlug,
      );
      result.blocked++;
    }
  }

  const stale = rows.filter(row => !seen.has(row.slug));
  /**
   * The live rows whose yaml lists `name` in THIS push and had not given
   * it up before the pass began (a template copy that listed it while it
   * was live had it retired then, and is no statement).
   */
  const heirsOf = (name: string, deleted: string) => {
    const heirs: IConnectorDefinition[] = [];
    for (const [heir, aliases] of fileAliasesBySlug) {
      if (heir === deleted || !aliases.includes(name)) continue;
      const r = rowBySlug.get(heir);
      if (r && !retiredAtStart.get(String(r._id))?.has(name)) heirs.push(r);
    }
    return heirs;
  };
  if (stale.length > 0) {
    // An explicit fold in ONE push: `connectors/x/` deleted while exactly
    // one live folder's yaml now says `aliases: [x]`. That line is the
    // author's statement "x is now y", so x's connections are re-bound to
    // y (and typed ws:y) — logged, and only in this same-pass shape; a
    // later alias claim on a name already retired is never an adoption.
    for (const row of stale) {
      // An heir says `aliases: [x]` NOW and never had x taken from it: a
      // yaml that listed x while x was live (a stale template copy) was
      // already dropped and retired for that row, and is no statement.
      const heirs = heirsOf(row.slug, row.slug);
      if (heirs.length !== 1 || !heirs[0]) continue;
      const heir = heirs[0];
      const folded = await SourceConnection.updateMany(
        {
          workspaceId,
          type: `${WORKSPACE_TYPE_PREFIX}${row.slug}`,
          $or: [
            { connectorDefinitionId: row._id },
            { connectorDefinitionId: { $exists: false } },
            { connectorDefinitionId: null },
          ],
        },
        {
          $set: {
            type: `${WORKSPACE_TYPE_PREFIX}${heir.slug}`,
            connectorDefinitionId: heir._id,
          },
        },
      );
      logger.warn(
        "A deleted workspace connector was folded into another by its alias",
        {
          workspaceId,
          from: row.slug,
          into: heir.slug,
          connectionsMoved: folded.modifiedCount,
        },
      );
      if (!(heir.aliases ?? []).includes(row.slug)) {
        heir.aliases = [...(heir.aliases ?? []), row.slug];
        heir.retiredAliases = (heir.retiredAliases ?? []).filter(
          a => a !== row.slug,
        );
        await heir.save();
      }
    }
    // A deleted connector's slug is nobody's: a row that still lists it as
    // an alias (it once held the name) must not inherit the deleted
    // connector's connections — their credentials were entered for the
    // deleted code. Retire the slug on every claimant (durably), so
    // `ws:<slug>` resolves to nothing until a connector takes the name.
    for (const row of stale) {
      // Its slug AND every alias it answered to: a connection typed by any
      // of them was created for the deleted code.
      for (const name of [row.slug, ...(row.aliases ?? [])]) {
        // Only a SOLE heir keeps the name; two folders claiming it in one
        // push is ambiguous, and an ambiguous old name answers to nobody.
        const heirs = heirsOf(name, row.slug);
        const sole = heirs.length === 1 ? heirs[0] : undefined;
        const heirIds = sole ? [sole._id] : [];
        const retired = await ConnectorDefinition.updateMany(
          { workspaceId, aliases: name, _id: { $nin: [row._id, ...heirIds] } },
          {
            $pull: { aliases: name, detectedAliases: name },
            $addToSet: { retiredAliases: name },
          },
        );
        if (retired.modifiedCount > 0) {
          logger.warn(
            "A deleted workspace connector's name was retired from other connectors' aliases",
            {
              workspaceId,
              slug: row.slug,
              name,
              claimants: retired.modifiedCount,
            },
          );
        }
      }
    }
    await ConnectorDefinition.deleteMany({
      workspaceId,
      _id: { $in: stale.map(row => row._id) },
    });
    result.removed = stale.length;
  }

  await adoptSoleClaims(workspaceId);
  return result;
}

/** How alike the entry file must be for git to call a folder move a rename. */
export const CONNECTOR_RENAME_SIMILARITY = 75;

/** The row's alias list after a pass: the file's, plus what git detected. */
async function mergedAliases(
  workspaceId: string,
  row: IConnectorDefinition | undefined,
  fromFile: string[],
  slug: string,
  rowBySlug: Map<string, IConnectorDefinition>,
  /** Slugs present in THIS pass's tree: a row about to be removed as stale is not a claimant. */
  inTree: Set<string>,
): Promise<string[]> {
  const retired = new Set(row?.retiredAliases ?? []);
  const held = new Set(row?.aliases ?? []);
  // A name ANY row retired is a name that was taken from someone: a copy of
  // that row's folder must not pick it up from the copied yaml.
  const retiredAnywhere = new Set(
    [...rowBySlug.values()].flatMap(r =>
      r === row ? [] : (r.retiredAliases ?? []),
    ),
  );
  const out: string[] = [];
  for (const alias of new Set([...fromFile, ...(row?.detectedAliases ?? [])])) {
    if (alias === slug || retired.has(alias)) continue;
    if (held.has(alias)) {
      out.push(alias);
      continue;
    }
    // New to this row: nobody else may already answer to it, and nobody
    // may have had it taken away.
    const live = rowBySlug.get(alias);
    const other =
      (live && inTree.has(live.slug) ? live : undefined) ??
      [...rowBySlug.values()].find(
        r =>
          r !== row && inTree.has(r.slug) && (r.aliases ?? []).includes(alias),
      );
    if (other || retiredAnywhere.has(alias)) {
      retired.add(alias);
      logger.warn(
        "A workspace connector lists an alias another connector already answers to (or retired); dropped for it",
        { workspaceId, slug, alias, owner: other?.slug ?? "(retired)" },
      );
      continue;
    }
    out.push(alias);
  }
  if (row) row.retiredAliases = [...retired];
  return out;
}

/**
 * (c) of the alias lifecycle: a row that is the SOLE claimant of an alias
 * fixes the `type` of ITS OWN connections still typed by it (bound by id,
 * the type is cosmetic), so none stays typed by a name a future folder
 * could claim. Never adopts another definition's — or an unbound —
 * connection. Runs after the pass, over the rows that
 * remain, in slug order (deterministic, never Mongo's).
 */
async function adoptSoleClaims(workspaceId: string): Promise<void> {
  const rows = (await ConnectorDefinition.find({ workspaceId })).sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  );
  const live = new Set(rows.map(r => r.slug));
  const claimants = new Map<string, IConnectorDefinition[]>();
  for (const r of rows) {
    for (const alias of r.aliases ?? []) {
      const list = claimants.get(alias) ?? [];
      list.push(r);
      claimants.set(alias, list);
    }
  }
  for (const [alias, list] of claimants) {
    if (live.has(alias) || list.length !== 1) continue;
    // Only connections BOUND to this row (the slug in `type` is cosmetic
    // for them). An unstamped connection typed by an alias was entered for
    // nobody this index can name; it stays as it is and fails closed.
    await migrateSourceConnectionType(workspaceId, alias, list[0].slug, {
      definitionId: String(list[0]._id),
    });
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Pair folders that appeared with rows whose folder disappeared.
 * Returns new slug → old slug. Three signals, strongest first:
 *   1. the new folder's connector.yaml lists the old slug in `aliases`;
 *   2. git's rename detection between the old row's commit and this one
 *      pairs `connectors/<old>/connector.yaml` with the new folder's;
 *   3. identical content (same sourceSha) — a pure `git mv`.
 * A new slug claimed by two old rows is left alone (ambiguous: index both
 * as git shows them rather than guess).
 */
async function detectRenames(
  workspaceId: string,
  commit: string,
  slugs: string[],
  filesBySlug: Map<string, Map<string, Uint8Array>>,
  rows: IConnectorDefinition[],
): Promise<Map<string, string>> {
  const live = new Set(slugs);
  const gone = rows.filter(row => !live.has(row.slug));
  const appeared = slugs.filter(
    slug => !rows.some(row => row.slug === slug) && filesBySlug.has(slug),
  );
  const out = new Map<string, string>();
  if (gone.length === 0 || appeared.length === 0) return out;

  const decoder = new TextDecoder();
  const goneBySlug = new Map(gone.map(row => [row.slug, row]));
  const goneBySourceSha = new Map<string, IConnectorDefinition[]>();
  for (const row of gone) {
    const list = goneBySourceSha.get(row.sourceSha) ?? [];
    list.push(row);
    goneBySourceSha.set(row.sourceSha, list);
  }
  const claimed = new Set<string>();
  const claim = (to: string, from: string) => {
    if (out.has(to) || claimed.has(from)) return;
    out.set(to, from);
    claimed.add(from);
  };

  // 1. explicit aliases in the new folder's yaml
  for (const slug of appeared) {
    const yamlBytes = filesBySlug.get(slug)?.get("connector.yaml");
    if (!yamlBytes) continue;
    const parsed = parseConnectorFile(decoder.decode(yamlBytes));
    if (!parsed.ok) continue;
    const old = parsed.value.aliases.filter(a => goneBySlug.has(a));
    if (old.length === 1) claim(slug, old[0]);
  }

  // 2. git rename detection, per old row's last-read commit. Paired on the
  //    ENTRY file (the code), not connector.yaml: the yaml is three lines
  //    and identical across most connectors, so git would pair any delete
  //    with any add. The code must be at least CONNECTOR_RENAME_SIMILARITY
  //    alike; a rewrite that big is a new connector unless the yaml says
  //    otherwise (signal 1).
  const repoDir = repoDirFor(workspaceId);
  const byKey = new Map<string, IConnectorDefinition[]>();
  for (const row of gone) {
    if (claimed.has(row.slug) || !row.sha) continue;
    const key = `${row.sha}\0${row.entry || DEFAULT_ENTRY}`;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }
  for (const [key] of byKey) {
    const [sha, entry] = key.split("\0");
    const pairs = await renamedFoldersBetween(
      repoDir,
      sha,
      commit,
      CONNECTORS_DIR,
      entry,
      { similarity: CONNECTOR_RENAME_SIMILARITY },
    );
    for (const [to, from] of pairs) {
      if (appeared.includes(to) && goneBySlug.has(from)) claim(to, from);
    }
  }

  // 3. identical content
  for (const slug of appeared) {
    if (out.has(slug)) continue;
    const files = filesBySlug.get(slug);
    if (!files) continue;
    const candidates = (goneBySourceSha.get(sourceShaOf(files)) ?? []).filter(
      row => !claimed.has(row.slug),
    );
    if (candidates.length === 1) claim(slug, candidates[0].slug);
  }
  return out;
}

/**
 * Move every connection of `ws:<from>` to `ws:<to>`. Only `type` changes:
 * the credential stays encrypted exactly as it is, and both names resolve
 * to the same config schema (so the same secret fields) before and after.
 * Idempotent — a connection already on the new type is simply not matched.
 */
export async function migrateSourceConnectionType(
  workspaceId: string,
  from: string,
  to: string,
  options: {
    /**
     * Only connections bound to this definition (plus, with
     * `includeUnstamped`, legacy unbound ones — which are then bound to it).
     * Without it every ws:<from> connection moves; callers that re-type by
     * ALIAS must always give it.
     */
    definitionId?: string;
    includeUnstamped?: boolean;
  } = {},
): Promise<number> {
  if (from === to) return 0;
  const filter: Record<string, unknown> = {
    workspaceId,
    type: `${WORKSPACE_TYPE_PREFIX}${from}`,
  };
  if (options.definitionId) {
    filter.$or = options.includeUnstamped
      ? [
          { connectorDefinitionId: options.definitionId },
          { connectorDefinitionId: { $exists: false } },
          { connectorDefinitionId: null },
        ]
      : [{ connectorDefinitionId: options.definitionId }];
  }
  const result = await SourceConnection.updateMany(filter, {
    $set: {
      type: `${WORKSPACE_TYPE_PREFIX}${to}`,
      ...(options.definitionId && options.includeUnstamped
        ? { connectorDefinitionId: options.definitionId }
        : {}),
    },
  });
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
 * The identity of a folder's contents.
 *
 * Every file, not just the entry: a connector split across modules changes
 * when any of them changes, and hashing only `connector.ts` would serve a
 * stale copy of everything it imports.
 */
export function sourceShaOf(files: Map<string, Uint8Array>): string {
  const parts: string[] = [];
  for (const name of [...files.keys()].sort()) {
    const bytes = files.get(name) as Uint8Array;
    // connector.yaml is hashed without its `aliases` (a rename's only
    // edit), so renaming does not read as a code change.
    const contents =
      name === "connector.yaml"
        ? Buffer.from(
            connectorFileIdentity(new TextDecoder().decode(bytes)),
            "utf8",
          )
        : Buffer.from(bytes);
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

/**
 * A NEW definition is about to take `slug`, which another definition
 * still answers to as an alias. The live name wins (api/src/rename rule
 * 2), but it must not win silently: every connection still typed
 * `ws:<slug>` was created for the OLD connector, and letting it resolve
 * to the new one would send its credentials to different code. So first
 * move those connections to the old connector's current slug, then drop
 * the alias, then let the new definition be created.
 */
async function releaseAliasClaim(
  workspaceId: string,
  slug: string,
  /** The row taking the slug — its own alias is handled by the caller. */
  exceptId?: string,
  /**
   * The pass's own documents. A reconcile pass holds every row in memory
   * and saves them as it goes; releasing a claim on a FRESH copy from
   * Mongo would be undone the moment the pass saves its stale copy of the
   * same row (what resurrected `acme` on acme-crm). So the release edits
   * the pass's documents when it has them.
   */
  rowBySlug?: Map<string, IConnectorDefinition>,
): Promise<void> {
  const claimants = rowBySlug
    ? [...rowBySlug.values()].filter(
        r =>
          (r.aliases ?? []).includes(slug) &&
          (!exceptId || String(r._id) !== exceptId),
      )
    : await ConnectorDefinition.find({
        workspaceId,
        aliases: slug,
        ...(exceptId ? { _id: { $ne: exceptId } } : {}),
      });
  if (claimants.length > 1) {
    // Nobody can say whose UNBOUND connections those are: left typed
    // ws:<slug>, and pinned closed before the newcomer takes the name
    // (prepareSlugTakeover). Bound ones are each claimant's by id.
    logger.warn(
      "A slug taken by a new connector was claimed by several connectors; their unbound connections were left unresolvable",
      { workspaceId, slug, claimants: claimants.map(c => c.slug) },
    );
  }
  for (const claimant of claimants) {
    // Only connections BOUND to this claimant (by id — never a guess, so
    // however many claimants there are): their type is made to match.
    const moved = await migrateSourceConnectionType(
      workspaceId,
      slug,
      claimant.slug,
      { definitionId: String(claimant._id) },
    );
    claimant.aliases = (claimant.aliases ?? []).filter(a => a !== slug);
    claimant.detectedAliases = (claimant.detectedAliases ?? []).filter(
      a => a !== slug,
    );
    // Durable: the file still lists the alias and a sync cannot edit the
    // file, so the row remembers the retirement and `mergedAliases`
    // subtracts it on every later pass. Deleting the newcomer must not
    // hand `ws:<slug>` back to this connector — its connections were
    // created for the newcomer's code.
    claimant.retiredAliases = [
      ...new Set([...(claimant.retiredAliases ?? []), slug]),
    ];
    await claimant.save();
    logger.warn(
      "A new workspace connector took a slug another connector was still known by",
      {
        workspaceId,
        slug,
        previousOwner: claimant.slug,
        connectionsMoved: moved,
      },
    );
  }
}

/**
 * A definition is about to take `slug` as its LIVE name (a new folder, a
 * folder moved there, a rename). Every connection still typed `ws:<slug>`
 * was saved for something else — the connector that held the name before,
 * or nothing — so before the name changes hands:
 *
 *  - one BOUND to another definition that still exists keeps it: its type
 *    (cosmetic for a bound connection) is moved to that definition's
 *    current slug, so the newcomer's name does not make it refuse;
 *  - one bound to a definition that is gone stays as it is (it already
 *    fails closed, and only a person re-binds it);
 *  - one bound to NOTHING (a pre-stamp connection) is pinned closed with
 *    {@link UNBOUND_CONNECTOR_DEFINITION_ID}: it resolves by current slug
 *    only, and the current slug is about to be the newcomer's.
 */
export async function prepareSlugTakeover(
  workspaceId: string,
  slug: string,
  /** The definition taking the name, when it already has a row. */
  takerId?: string,
): Promise<void> {
  await retypeBoundElsewhere(workspaceId, slug, takerId);
  await pinUnboundConnections(workspaceId, slug);
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
  const type = `${WORKSPACE_TYPE_PREFIX}${slug}`;
  const boundTo = await SourceConnection.distinct("connectorDefinitionId", {
    workspaceId,
    type,
    connectorDefinitionId: { $exists: true, $ne: null },
  });
  const ids = boundTo
    .map(id => String(id))
    .filter(id => id !== takerId && id !== UNBOUND_CONNECTOR_DEFINITION_ID);
  if (ids.length === 0) return 0;
  const owners = await ConnectorDefinition.find({
    workspaceId,
    _id: { $in: ids },
  });
  let moved = 0;
  for (const owner of owners) {
    if (owner.slug === slug) continue;
    moved += await migrateSourceConnectionType(workspaceId, slug, owner.slug, {
      definitionId: String(owner._id),
    });
  }
  return moved;
}

/** Pin unbound connections typed `ws:<slug>` closed. Returns how many. */
export async function pinUnboundConnections(
  workspaceId: string,
  slug: string,
): Promise<number> {
  // Raw collection, both id forms: a row an old writer stored with a
  // string workspace id is exactly the kind no migration could stamp, and
  // the model's cast would never match it.
  const result = await SourceConnection.collection.updateMany(
    {
      workspaceId: { $in: [new Types.ObjectId(workspaceId), workspaceId] },
      type: `${WORKSPACE_TYPE_PREFIX}${slug}`,
      $or: [
        { connectorDefinitionId: { $exists: false } },
        { connectorDefinitionId: null },
      ],
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
      "A connector took a name that unbound (pre-stamp) connections still carry; they were pinned closed until a person re-binds them",
      { workspaceId, slug, connections: result.modifiedCount },
    );
  }
  return result.modifiedCount;
}

async function block(
  workspaceId: string,
  slug: string,
  sha: string,
  sourceSha: string,
  reason: string,
  row: IConnectorDefinition | undefined,
  rowBySlug?: Map<string, IConnectorDefinition>,
): Promise<void> {
  if (row) {
    row.set({ sha, sourceSha, status: "blocked", blockedReason: reason });
    await row.save();
    return;
  }
  await releaseAliasClaim(workspaceId, slug, undefined, rowBySlug);
  await prepareSlugTakeover(workspaceId, slug);
  await ConnectorDefinition.create({
    workspaceId,
    slug,
    runtime: "node",
    sha,
    sourceSha,
    status: "blocked",
    blockedReason: reason,
    entities: [],
  });
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
  /** The definition the connection is bound to; wins over `slug`. */
  definitionId?: string;
  /** The indexed source revision the connector instance actually ran. */
  sourceSha: string;
  success: boolean;
  message?: string;
}): Promise<boolean> {
  const { workspaceId, sourceSha, success, message } = input;
  // The row the connection is BOUND to (its stamp), else the one its slug
  // currently names — never an alias claimant.
  const found = await findConnectorDefinitionFor(workspaceId, {
    type: `${WORKSPACE_TYPE_PREFIX}${input.slug}`,
    connectorDefinitionId: input.definitionId,
  });
  if (!found) return false;
  const slug = found.row.slug;
  const result = await ConnectorDefinition.updateOne(
    // A blocked connector is blocked by its code, which a credential cannot
    // fix; it must not be talked back up to `verified` by a check that could
    // not have run against it in the first place.
    { workspaceId, slug, sourceSha, status: { $ne: "blocked" } },
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
