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
} from "./connector-file";
import { listConnectorFoldersAtMain, ensureConnectorRuntime } from "./resolver";
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

/** Coalesce concurrent pushes: a burst of them must not boot several boxes. */
const inFlight = new Map<string, Promise<ConnectorSyncResult>>();

export function syncConnectorsFromRepo(
  workspaceId: string,
  actorUserId?: string,
): Promise<ConnectorSyncResult> {
  const existing = inFlight.get(workspaceId);
  if (existing) return existing;
  const run = reconcile(workspaceId, actorUserId).finally(() =>
    inFlight.delete(workspaceId),
  );
  inFlight.set(workspaceId, run);
  return run;
}

async function reconcile(
  workspaceId: string,
  _actorUserId?: string,
): Promise<ConnectorSyncResult> {
  const { commit, slugs, filesBySlug } =
    await listConnectorFoldersAtMain(workspaceId);
  if (!commit) return { ...EMPTY };

  const rows = await ConnectorDefinition.find({ workspaceId });
  const rowBySlug = new Map(rows.map(row => [row.slug, row]));

  // An empty `connectors/` is never a reason to delete an index. A tree that
  // reads as empty because a git command failed looks exactly like a workspace
  // that deleted every connector, and one of those is recoverable.
  if (slugs.length === 0) {
    return { ...EMPTY, unchanged: rows.length };
  }

  const result: ConnectorSyncResult = { ...EMPTY, skipped: [] };
  const seen = new Set<string>();

  for (const slug of slugs) {
    const files = filesBySlug.get(slug) ?? new Map<string, Uint8Array>();

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
    if (row && row.sourceSha === sourceSha && row.status !== "blocked") {
      // Unchanged content: keep the row, and with it a `verified` status that
      // a real connection test earned. Re-running spec here would demote it.
      if (row.sha !== commit) {
        row.sha = commit;
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
          sha: commit,
          sourceSha,
          spec: spec.spec,
          status: "indexed",
          blockedReason: undefined,
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
          sha: commit,
          sourceSha,
          spec: spec.spec,
          status: "indexed",
          entities,
          hasIcon: files.has("icon.svg"),
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
): Promise<
  { ok: true; spec: Record<string, unknown> } | { ok: false; reason: string }
> {
  const ctx = syncBoxContext(workspaceId);
  await ensureConnectorRuntime(ctx);
  const dir = await materializeConnector({ ctx, slug, sourceSha, files });

  const result = await runConnectorCommand({
    ctx,
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
  success: boolean;
  message?: string;
}): Promise<void> {
  const { workspaceId, slug, success, message } = input;
  await ConnectorDefinition.updateOne(
    { workspaceId, slug },
    success
      ? {
          $set: { status: "verified", lastCheckedAt: new Date() },
          $unset: { blockedReason: "" },
        }
      : {
          $set: {
            lastCheckedAt: new Date(),
            blockedReason: message ?? "Connection test failed",
          },
        },
  );
}
