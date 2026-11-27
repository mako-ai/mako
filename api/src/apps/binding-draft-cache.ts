/**
 * Short-lived reuse of DRAFT binding builds (the laptop dev loop, see
 * binding-dev-build.ts), and a backoff for drafts that keep failing.
 *
 * A draft — uncommitted SQL, or `{{ dbt_schema }}` rendered against a dev
 * dbt environment — used to be built, streamed and thrown away. With a dbt
 * environment set EVERY binding is a draft, so each cold laptop cache re-ran
 * every query in full (about a minute for a five-dataset app, 75 s per call
 * quarter). Now the parquet is kept for DRAFT_TTL_MS under a hash of exactly
 * what ran: connection, database, the RENDERED SQL (dbt schema and every
 * per-relation defer choice included) and when the newest dev relation it
 * reads was last written — so a `dbt run` into the dev schema, or a model
 * appearing there, is a new draft rather than stale data.
 *
 * Rows, one collection, two kinds:
 *   - "build": one per successful build, with its OWN object key
 *     (`apps/drafts/<projectId>/<hash>-<buildId>.parquet`), so concurrent
 *     builds of one draft never overwrite or delete each other's object;
 *     the newest unexpired one answers;
 *   - "failure": one per draft hash, the consecutive-failure streak behind
 *     the backoff. A failure never discards an earlier successful build of
 *     the same SQL: a valid build is served first, and the backoff only
 *     refuses when there is none.
 *
 * Scope: the `apps/drafts/` prefix is never resolved by published, preview
 * or scheduled serving (those use content-addressed `apps/bindings/…` keys),
 * and drafts are handed out only by the dev-build route, after the same
 * write-access check that building one needs.
 *
 * Cleanup: the store cannot list, so every object is tracked here; whenever a
 * project keeps a new draft, its expired rows go — for a build row exactly
 * the object it recorded, for a failure row nothing but the row.
 */
import { createHash, randomBytes } from "node:crypto";
import { appsMetadataRepo } from "../repositories/apps-metadata";
import { getArtifactStore } from "../services/artifact-store.service";
import {
  snapshotArtifactKey,
  snapshotFromParquetBestEffort,
  storeParquetWithSnapshot,
} from "../services/binding-snapshot";
import { cooldownMsFor } from "./live-binding-guard";
import { loggers } from "../logging";

const logger = loggers.api("apps");

/**
 * How long a draft build is reused. 30 minutes: several of the plugin's
 * 5-minute revalidations, a dev-server restart or a branch switch and back
 * all hit it, while data a developer iterates on is never older than a
 * coffee break. `refresh` (the SDK's refresh(), `?refresh`) always rebuilds.
 */
export const DRAFT_TTL_MS = 30 * 60_000;

/** A failure streak is forgotten this long after its refusal window ends. */
export const FAILURE_RETENTION_MS = 60 * 60_000;

export interface DraftDefinition {
  connectionId: string;
  databaseId?: string;
  databaseName?: string;
  /** The SQL exactly as it will run: dbt schema and defer choices rendered. */
  renderedCode: string;
  /**
   * When the newest dev relation the SQL reads was last written (epoch ms),
   * or null. Part of the hash: rebuilding a dev model is a new draft.
   */
  devModifiedAt?: number | null;
  /**
   * `-- row_limit:` as written. Part of the hash only when set (drafts
   * without one keep their hash): raising the limit after a draft failed on
   * it is a new draft, not one the failure backoff refuses.
   */
  rowLimit?: string;
}

export function draftHash(d: DraftDefinition): string {
  const rowLimit = d.rowLimit?.trim();
  return createHash("sha256")
    .update(
      [
        d.connectionId,
        d.databaseId ?? "",
        d.databaseName ?? "",
        d.renderedCode,
        d.devModifiedAt == null ? "" : String(d.devModifiedAt),
        ...(rowLimit ? [`row_limit=${rowLimit}`] : []),
      ]
        .map(part => `${part.length}:${part}`)
        .join("|"),
    )
    .digest("hex")
    .slice(0, 32);
}

export function draftArtifactKey(
  projectId: string,
  hash: string,
  buildId: string,
): string {
  return `apps/drafts/${projectId}/${hash}-${buildId}.parquet`;
}

export type DraftLookup =
  | { kind: "hit"; key: string; rowCount: number; builtAt: Date }
  | { kind: "cooling"; retryAfterMs: number; failures: number; error: string }
  | { kind: "miss" };

/**
 * What a draft request should do: serve the newest valid build, else refuse
 * while the failure backoff runs, else build.
 */
export async function lookupDraft(
  projectId: string,
  hash: string,
  now: Date = new Date(),
  workspaceId?: string,
): Promise<DraftLookup> {
  const build = await appsMetadataRepo.findActiveDraftBuild(
    projectId,
    hash,
    now,
    workspaceId,
  );
  if (build?.key && build.builtAt) {
    return {
      kind: "hit",
      key: build.key,
      rowCount: build.rowCount ?? 0,
      builtAt: build.builtAt,
    };
  }
  const failure = await appsMetadataRepo.findDraftFailure(
    projectId,
    hash,
    workspaceId,
  );
  if (failure?.until && failure.until > now) {
    return {
      kind: "cooling",
      retryAfterMs: failure.until.getTime() - now.getTime(),
      failures: failure.failures ?? 1,
      error: failure.error ?? "Query failed",
    };
  }
  return { kind: "miss" };
}

/**
 * A kept build whose object is gone (deleted by hand, lost with a bucket):
 * drop its row so the next lookup is a miss and the draft is rebuilt.
 */
export async function forgetDraftBuild(
  projectId: string,
  key: string,
  workspaceId?: string,
): Promise<void> {
  await appsMetadataRepo.deleteDraftBuildByKey(projectId, key, workspaceId);
}

/**
 * Keep a successful draft build under its own object key (the local file
 * stays; the caller streams it) and end the failure streak. Expired rows of
 * the project go first.
 */
export async function recordDraftBuilt(input: {
  projectId: string;
  workspaceId?: string;
  name: string;
  hash: string;
  filePath: string;
  rowCount: number;
  byteSize: number;
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  await pruneExpiredDrafts(input.projectId, now, input.workspaceId);
  const key = draftArtifactKey(
    input.projectId,
    input.hash,
    randomBytes(6).toString("hex"),
  );
  const context = { projectId: input.projectId, binding: input.name };
  // Per-build key, so no older snapshot can sit here; the shared helper
  // keeps the order identical to the committed path anyway.
  await storeParquetWithSnapshot({
    parquetKey: key,
    snapshot: await snapshotFromParquetBestEffort(
      input.filePath,
      input.rowCount,
      context,
    ),
    context,
    uploadParquet: () =>
      getArtifactStore().put(input.filePath, key, {
        appProjectId: input.projectId,
        binding: input.name,
        draft: "true",
      }),
  });
  await appsMetadataRepo.createDraftBuild(
    {
      projectId: input.projectId,
      hash: input.hash,
      name: input.name,
      key,
      builtAt: now,
      rowCount: input.rowCount,
      byteSize: input.byteSize,
      expiresAt: new Date(now.getTime() + DRAFT_TTL_MS),
    },
    input.workspaceId,
  );
  await appsMetadataRepo.deleteDraftFailures(
    input.projectId,
    input.hash,
    input.workspaceId,
  );
  return key;
}

/**
 * Count a failed draft build: without a valid build to serve, the same
 * definition is then refused for a window that doubles per consecutive
 * failure (1m … 15m, the live-binding guard's schedule), so a page reloading
 * a broken query does not re-run it each time. The streak is forgotten
 * FAILURE_RETENTION_MS after its window ends. Returns the window.
 */
export async function recordDraftFailed(input: {
  projectId: string;
  workspaceId?: string;
  name: string;
  hash: string;
  error: string;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const prior = await appsMetadataRepo.findDraftFailure(
    input.projectId,
    input.hash,
    input.workspaceId,
  );
  const failures = (prior?.failures ?? 0) + 1;
  const cooldownMs = cooldownMsFor(failures);
  const until = new Date(now.getTime() + cooldownMs);
  await appsMetadataRepo.upsertDraftFailure(
    {
      projectId: input.projectId,
      hash: input.hash,
      name: input.name,
      failures,
      until,
      error: input.error.slice(0, 2000),
      expiresAt: new Date(until.getTime() + FAILURE_RETENTION_MS),
    },
    input.workspaceId,
  );
  return cooldownMs;
}

async function pruneExpiredDrafts(
  projectId: string,
  now: Date,
  workspaceId?: string,
) {
  const expired = await appsMetadataRepo.listExpiredDrafts(
    projectId,
    now,
    200,
    workspaceId,
  );
  if (expired.length === 0) return;
  const store = getArtifactStore();
  for (const doc of expired) {
    if (!doc.key) continue;
    try {
      await store.delete(doc.key);
    } catch (error) {
      logger.warn("Could not delete expired draft artifact", {
        key: doc.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await store.delete(snapshotArtifactKey(doc.key));
    } catch (error) {
      logger.warn("Could not delete expired draft snapshot", {
        key: snapshotArtifactKey(doc.key),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await appsMetadataRepo.deleteDraftsByIds(
    projectId,
    expired.map(d => d.id),
    workspaceId,
  );
}
