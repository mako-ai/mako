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
  type IConnectorDefinition,
} from "../../database/workspace-schema";
import { blobOid } from "../../apps/repository.service";
import { loggers } from "../../logging";
import {
  isValidSlug,
  parseConnectorFile,
  validateSpec,
  type ConnectorFile,
} from "./connector-file";
import type { SandboxExecContext } from "../../apps/sandbox/provider";
import {
  connectorRuntimeId,
  listConnectorFoldersAtMain,
  ensureConnectorRuntime,
} from "./resolver";
import { connectorBoxLeasesEnabled } from "./boxes/config";
import { getBoxScheduler } from "./boxes/scheduler";
import {
  BundleBuildError,
  prepareBundledConnector,
  type BundleBuildStatus,
} from "./bundle/bundle.service";
import { connectorBundlesEnabled } from "./bundle/flag";
import {
  dependencyPlan,
  hasDependencies,
  nodeModulesRefusal,
} from "./bundle/manifest";
import {
  CONNECTOR_BUNDLE_ENTRY,
  failureMessage,
  firstOfType,
  ensureBundle,
  materializeConnector,
  retireLegacySyncBox,
  retireSyncBox,
  runConnectorCommand,
  syncBoxContext,
  type RunResult,
} from "./sync-box";
import { connectorRegistryEnabled } from "./registry/flag";
import {
  getRegistryCatalog,
  prepareRegistryConnector,
  resolveReference,
  type RegistryResolution,
} from "./registry/registry.service";
import type { RegistryCatalog } from "./registry/store";

const logger = loggers.connector();

export interface ConnectorSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  blocked: number;
  removed: number;
  /** Slugs skipped without touching their row, with the reason. */
  skipped: Array<{ slug: string; reason: string }>;
}

const EMPTY: ConnectorSyncResult = {
  created: 0,
  updated: 0,
  unchanged: 0,
  blocked: 0,
  removed: 0,
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
  const { commit, slugs, filesBySlug, oversized, nodeModules } =
    await listConnectorFoldersAtMain(workspaceId);
  if (!commit) return { ...EMPTY };

  // Connector bundles (RFC connector-runtime §5). Off: every line below that
  // reads `bundling` is skipped. The node_modules/ guard runs either way.
  const bundling = connectorBundlesEnabled();
  // Install by reference (RFC connector-runtime §7). Off: `source:` is not
  // read, and a push behaves exactly as before.
  const registry = connectorRegistryEnabled();
  // Read at most once per pass, and only when a folder holds a reference.
  let catalog: Promise<RegistryCatalog> | null = null;
  const loadCatalog = () => (catalog ??= getRegistryCatalog({ fresh: true }));

  const rows = await ConnectorDefinition.find({ workspaceId });
  const rowBySlug = new Map(rows.map(row => [row.slug, row]));

  const result: ConnectorSyncResult = { ...EMPTY, skipped: [] };
  const seen = new Set<string>();

  for (const slug of slugs) {
    const files = filesBySlug.get(slug) ?? new Map<string, Uint8Array>();

    // A committed node_modules/ is refused before anything else, and before
    // the size cap: it is usually also over the cap, and "too big" would hide
    // the actual fix, which is to stop committing it. Always on, flag or not:
    // Mako never runs dependencies a folder brought along itself. Only for a
    // folder that claims to be a connector (a valid slug with connector.yaml,
    // or too big to read): a helper folder stays skipped, as before.
    const committedModules =
      nodeModules?.get(slug) &&
      isValidSlug(slug) &&
      (files.has("connector.yaml") || oversized.has(slug));
    if (committedModules) {
      seen.add(slug);
      await block(
        workspaceId,
        slug,
        commit,
        commit,
        nodeModulesRefusal(slug),
        rowBySlug.get(slug),
      );
      result.blocked++;
      continue;
    }

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
    const parsed = parseConnectorFile(decoder.decode(yamlBytes), {
      registry,
    });
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

    if (parsed.value.source) {
      const outcome = await indexReference({
        workspaceId,
        slug,
        commit,
        files,
        file: parsed.value,
        row,
        loadCatalog,
      });
      result[outcome]++;
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

    const plan =
      bundling && parsed.value.runtime === "node"
        ? dependencyPlan(files)
        : ({ kind: "none" } as const);
    if (plan.kind === "invalid") {
      await block(
        workspaceId,
        slug,
        commit,
        sourceShaOf(files),
        plan.reason,
        row,
      );
      result.blocked++;
      continue;
    }
    const bundled = plan.kind === "npm" && hasDependencies(files);

    const sourceSha = sourceShaOf(files);
    if (row && row.sourceSha === sourceSha && row.status !== "blocked") {
      // Unchanged content: keep the row, and with it a `verified` status that
      // a real connection test earned. Re-running spec here would demote it.
      // `entry` is still backfilled: a row indexed before it was stored
      // defaults to connector.ts, and a connector whose yaml names another
      // file would otherwise keep running the wrong one forever.
      if (row.sha !== commit || row.entry !== parsed.value.entry) {
        row.sha = commit;
        row.entry = parsed.value.entry;
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
        bundled,
      );
      if (!spec.ok) {
        await block(
          workspaceId,
          slug,
          commit,
          sourceSha,
          spec.reason,
          row,
          spec.build,
        );
        result.blocked++;
        continue;
      }
      const entities = Object.keys((spec.spec?.mako as any)?.entities ?? {});
      // With bundles on, the row says how this code was built; a folder that
      // dropped its package.json loses a stale build record. Off, untouched.
      const buildFields = bundling ? { build: spec.build } : {};
      if (row) {
        row.set({
          ...buildFields,
          // An ejected folder is code again: it no longer follows a release.
          ...(row.registry ? { registry: undefined } : {}),
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
        });
        await row.save();
        result.updated++;
      } else {
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
          ...(spec.build ? { build: spec.build } : {}),
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
        error instanceof BundleBuildError
          ? { status: "failed", hash: error.hash, error: error.reason }
          : undefined,
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
    parts.push(
      `${name}:${blobOid(Buffer.from(files.get(name) as Uint8Array))}`,
    );
  }
  return blobOid(parts.join("\n"));
}

async function runSpec(
  workspaceId: string,
  slug: string,
  sourceSha: string,
  files: Map<string, Uint8Array>,
  entry: string,
  bundled = false,
): Promise<
  | { ok: true; spec: Record<string, unknown>; build?: BundleBuildStatus }
  | { ok: false; reason: string; build?: BundleBuildStatus }
> {
  // A folder with dependencies runs its bundle, built first if storage has
  // none for this hash. A build failure throws BundleBuildError, which the
  // caller records as both `blocked` and a failed build.
  let build: BundleBuildStatus | undefined;
  const bundle = bundled
    ? async (args: {
        ctx: SandboxExecContext;
        runtimeId: string;
        files: Map<string, Uint8Array>;
      }) => {
        const prepared = await prepareBundledConnector({
          ...args,
          workspaceId,
          slug,
          entry,
        });
        build = prepared.build ?? { status: "built", hash: prepared.hash };
        return prepared;
      }
    : undefined;

  const result = connectorBoxLeasesEnabled()
    ? await getBoxScheduler().withLease(
        {
          workspaceId,
          // `spec` takes no credential. One key per connector: a push that
          // touches N connectors must not make each spec drain the others.
          connectionId: `spec:${workspaceId}:${slug}`,
          bundleHash: sourceSha,
          command: "spec",
          runtimeId: await connectorRuntimeId(),
          timeoutMs: 60_000,
          // A push's spec is a one-time check: no template, killed after.
          oneOff: true,
        },
        async lease => {
          const prepared = await ensureBundle({
            ctx: lease.ctx,
            hash: sourceSha,
            slug,
            entry,
            files: async () => files,
            ensureRuntime: ensureConnectorRuntime,
            bundle,
          });
          lease.noteRuntime(prepared.runtimeId);
          // Before any credentialed command: the template must hold none.
          await lease.snapshotPristine(prepared.runtimeId);
          const run = await runConnectorCommand({
            ctx: lease.ctx,
            runtimeId: prepared.runtimeId,
            connectorDir: prepared.dir,
            command: "spec",
            entry: prepared.entry,
            timeoutMs: 60_000,
            onCleanupFailure: reason => lease.markUnhealthy(reason),
          });
          if (run.timedOut) lease.markFailed("timed out");
          return run;
        },
      )
    : await runSpecInWorkspaceBox(
        workspaceId,
        slug,
        sourceSha,
        files,
        entry,
        bundle,
      );
  return { ...specFrom(result), build };
}

/** Run `spec` on code already in the box and validate what it says. */
async function specAt(
  ctx: SandboxExecContext,
  runtimeId: string,
  dir: string,
  entry: string,
  onCleanupFailure: (reason: string) => void,
): Promise<
  { ok: true; spec: Record<string, unknown> } | { ok: false; reason: string }
> {
  const result = await runConnectorCommand({
    ctx,
    runtimeId,
    connectorDir: dir,
    command: "spec",
    entry,
    timeoutMs: 60_000,
    onCleanupFailure,
  });
  return specFrom(result);
}

/** What a `spec` run said, validated. */
function specFrom(
  result: RunResult,
): { ok: true; spec: Record<string, unknown> } | { ok: false; reason: string } {
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
 * A folder whose connector.yaml says `source: mako/<slug>@<range>`.
 *
 * The folder holds no code. The reference resolves to the newest registry
 * version in range; that version's bundle runs `spec` in the sync box, and
 * the row records the version so every later command runs the same bytes.
 *
 * `sourceSha` covers the folder AND the resolved bundle hash. A new release
 * inside the range therefore reads as changed code: spec runs again and a
 * `verified` status, which a check on the old version earned, is dropped.
 * A newer major only updates `upgradeAvailable` on an otherwise unchanged row.
 */
async function indexReference(input: {
  workspaceId: string;
  slug: string;
  commit: string;
  files: Map<string, Uint8Array>;
  file: ConnectorFile;
  row: IConnectorDefinition | undefined;
  loadCatalog: () => Promise<RegistryCatalog>;
}): Promise<"created" | "updated" | "unchanged" | "blocked"> {
  const { workspaceId, slug, commit, files, file, row } = input;
  const reference = file.source!;
  const folderSha = sourceShaOf(files);

  let catalog: RegistryCatalog;
  try {
    catalog = await input.loadCatalog();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error("Could not read the connector registry", {
      workspaceId,
      slug,
      reason,
    });
    // A storage outage is not a broken connector. A row that already runs a
    // resolved version keeps running it; only a first install is refused.
    if (row && row.registry && row.status !== "blocked") return "unchanged";
    await block(
      workspaceId,
      slug,
      commit,
      folderSha,
      `Could not read the connector registry to resolve ${reference.text}: ${reason}`,
      row,
    );
    return "blocked";
  }

  let resolved: ReturnType<typeof resolveReference>;
  try {
    resolved = resolveReference(reference, catalog);
  } catch (error) {
    // A malformed catalog entry blocks this connector, never the whole push.
    resolved = {
      ok: false,
      reason: `Could not resolve ${reference.text}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!resolved.ok) {
    await block(workspaceId, slug, commit, folderSha, resolved.reason, row);
    return "blocked";
  }
  const resolution = resolved.resolution;
  const sourceSha = blobOid(
    `${folderSha}\nregistry:${resolution.slug}@${resolution.version}:${resolution.hash}`,
  );

  if (row && row.sourceSha === sourceSha && row.status !== "blocked") {
    // Same version: keep the row and its `verified`. Only what is newer than
    // it may have changed, which is news, not new code.
    const previous = row.registry;
    if (
      row.sha !== commit ||
      previous?.latest !== resolution.latest ||
      previous?.upgradeAvailable !== resolution.upgradeAvailable ||
      previous?.ref !== resolution.ref
    ) {
      row.set({
        sha: commit,
        registry: {
          ...resolution,
          resolvedAt: previous?.resolvedAt ?? resolution.resolvedAt,
        },
      });
      await row.save();
    }
    return "unchanged";
  }

  try {
    const spec = await runRegistrySpec(workspaceId, resolution);
    if (!spec.ok) {
      await block(workspaceId, slug, commit, sourceSha, spec.reason, row);
      return "blocked";
    }
    const entities = Object.keys((spec.spec?.mako as any)?.entities ?? {});
    const fields = {
      runtime: "node",
      entry: CONNECTOR_BUNDLE_ENTRY,
      sha: commit,
      sourceSha,
      spec: spec.spec,
      status: "indexed" as const,
      entities,
      hasIcon: false,
      registry: resolution,
    };
    if (row) {
      row.set({
        ...fields,
        blockedReason: undefined,
        lastCheckError: undefined,
        // The code is the registry's bundle, not a build of this folder.
        build: undefined,
      });
      await row.save();
      return "updated";
    }
    await ConnectorDefinition.create({ workspaceId, slug, ...fields });
    return "created";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error("Failed to index a connector installed by reference", {
      workspaceId,
      slug,
      ref: reference.text,
      reason,
    });
    await block(workspaceId, slug, commit, sourceSha, reason, row);
    return "blocked";
  }
}

async function runRegistrySpec(
  workspaceId: string,
  resolution: RegistryResolution,
): Promise<
  { ok: true; spec: Record<string, unknown> } | { ok: false; reason: string }
> {
  const ctx = syncBoxContext(workspaceId);
  await retireLegacySyncBox(workspaceId);
  const runtimeId = await ensureConnectorRuntime(ctx);
  const { dir, entry } = await prepareRegistryConnector({
    ctx,
    runtimeId,
    registry: resolution,
  });
  // Same rule as every other run in the workspace box: a run whose cleanup
  // failed may have left its credential or a thread behind, so the box dies.
  let cleanupFailure: string | null = null;
  const spec = await specAt(ctx, runtimeId, dir, entry, reason => {
    cleanupFailure = reason;
  });
  if (cleanupFailure) await retireSyncBox(workspaceId, cleanupFailure);
  return spec;
}

/** The flag-off path: the workspace's one sync box, as before leases. */
async function runSpecInWorkspaceBox(
  workspaceId: string,
  slug: string,
  sourceSha: string,
  files: Map<string, Uint8Array>,
  entry: string,
  bundle: Parameters<typeof ensureBundle>[0]["bundle"],
) {
  const ctx = syncBoxContext(workspaceId);
  await retireLegacySyncBox(workspaceId);
  const runtimeId = await ensureConnectorRuntime(ctx);
  const bundled = bundle ? await bundle({ ctx, runtimeId, files }) : null;
  const dir =
    bundled?.dir ??
    (await materializeConnector({ ctx, runtimeId, slug, sourceSha, files }));
  let cleanupFailure: string | null = null;
  const result = await runConnectorCommand({
    ctx,
    runtimeId,
    connectorDir: dir,
    command: "spec",
    entry: bundled?.entry ?? entry,
    timeoutMs: 60_000,
    onCleanupFailure: reason => {
      cleanupFailure = reason;
    },
  });
  if (cleanupFailure) await retireSyncBox(workspaceId, cleanupFailure);
  return result;
}

async function block(
  workspaceId: string,
  slug: string,
  sha: string,
  sourceSha: string,
  reason: string,
  row: IConnectorDefinition | undefined,
  build?: BundleBuildStatus,
): Promise<void> {
  if (row) {
    row.set({
      sha,
      sourceSha,
      status: "blocked",
      blockedReason: reason,
      ...(build ? { build } : {}),
    });
    await row.save();
    return;
  }
  await ConnectorDefinition.create({
    workspaceId,
    slug,
    runtime: "node",
    sha,
    sourceSha,
    status: "blocked",
    blockedReason: reason,
    entities: [],
    ...(build ? { build } : {}),
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
  const { workspaceId, slug, sourceSha, success, message } = input;
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
