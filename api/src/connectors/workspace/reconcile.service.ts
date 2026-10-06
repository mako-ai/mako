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
  findConnectorDefinitionRow,
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

  const result: ConnectorSyncResult = { ...EMPTY, renamed: [], skipped: [] };
  const seen = new Set<string>();

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
    row.slug = to;
    row.aliases = [...new Set([...(row.aliases ?? []), from])].filter(
      a => a !== to && !(row.retiredAliases ?? []).includes(a),
    );
    // The live slug is this connector's again, whatever its past.
    row.retiredAliases = (row.retiredAliases ?? []).filter(a => a !== to);
    await row.save();
    rowBySlug.delete(from);
    rowBySlug.set(to, row);
    await migrateSourceConnectionType(workspaceId, from, to);
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
      );
      result.blocked++;
      continue;
    }

    const sourceSha = sourceShaOf(files);
    // The file's `aliases` are the record that travels; the row mirrors
    // them (plus any rename git detected on a push that carried none).
    const aliases = mergedAliases(row, parsed.value.aliases, slug);
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
        await block(workspaceId, slug, commit, sourceSha, spec.reason, row);
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
        await releaseAliasClaim(workspaceId, slug);
        await ConnectorDefinition.create({
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
        });
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
      );
      result.blocked++;
    }
  }

  const stale = rows.filter(row => !seen.has(row.slug));
  if (stale.length > 0) {
    await ConnectorDefinition.deleteMany({
      workspaceId,
      _id: { $in: stale.map(row => row._id) },
    });
    result.removed = stale.length;
  }

  return result;
}

/** How alike the entry file must be for git to call a folder move a rename. */
export const CONNECTOR_RENAME_SIMILARITY = 75;

/** The row's alias list after a pass: the file's, plus what git detected. */
function mergedAliases(
  row: IConnectorDefinition | undefined,
  fromFile: string[],
  slug: string,
): string[] {
  const retired = new Set(row?.retiredAliases ?? []);
  return [...new Set([...fromFile, ...(row?.aliases ?? [])])].filter(
    a => a !== slug && !retired.has(a),
  );
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
): Promise<number> {
  if (from === to) return 0;
  const result = await SourceConnection.updateMany(
    { workspaceId, type: `${WORKSPACE_TYPE_PREFIX}${from}` },
    { $set: { type: `${WORKSPACE_TYPE_PREFIX}${to}` } },
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
): Promise<void> {
  const claimants = await ConnectorDefinition.find({
    workspaceId,
    aliases: slug,
  });
  for (const claimant of claimants) {
    const moved = await migrateSourceConnectionType(
      workspaceId,
      slug,
      claimant.slug,
    );
    claimant.aliases = (claimant.aliases ?? []).filter(a => a !== slug);
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

async function block(
  workspaceId: string,
  slug: string,
  sha: string,
  sourceSha: string,
  reason: string,
  row: IConnectorDefinition | undefined,
): Promise<void> {
  if (row) {
    row.set({ sha, sourceSha, status: "blocked", blockedReason: reason });
    await row.save();
    return;
  }
  await releaseAliasClaim(workspaceId, slug);
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
  /** The indexed source revision the connector instance actually ran. */
  sourceSha: string;
  success: boolean;
  message?: string;
}): Promise<boolean> {
  const { workspaceId, sourceSha, success, message } = input;
  // The check may have run under a previous slug (a connection typed
  // `ws:<old>` after a rename); record it on the row that answers to it.
  const found = await findConnectorDefinitionRow(workspaceId, input.slug);
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
