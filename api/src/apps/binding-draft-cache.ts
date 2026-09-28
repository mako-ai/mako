/**
 * Short-lived reuse of DRAFT binding builds (the laptop dev loop, see
 * binding-dev-build.ts), and a backoff for drafts that keep failing.
 *
 * A draft — uncommitted SQL, or `{{ dbt_schema }}` rendered against a dev
 * dbt environment — used to be built, streamed and thrown away. With a dbt
 * environment set EVERY binding is a draft, so each cold laptop cache re-ran
 * every query in full (about a minute for a five-dataset app, 75 s per call
 * quarter). Now the parquet is kept for DRAFT_TTL_MS under a key derived from
 * exactly what ran: connection, database, and the RENDERED SQL — which already
 * carries the dbt schema and every per-relation defer choice, so a model
 * appearing in the dev schema changes the key rather than serving stale data.
 *
 * Scope: keys live under `apps/drafts/<projectId>/`, a prefix no published,
 * preview or scheduled path ever resolves (those use content-addressed
 * `apps/bindings/…` keys), and they are only ever handed out by the dev-build
 * route, after the same write-access check that building a draft needs.
 *
 * Cleanup: the store has no listing, so every draft is tracked in Mongo and
 * expired ones of a project are deleted (object + row) whenever that project
 * stores a new draft.
 */
import { createHash } from "node:crypto";
import mongoose, { Schema, Types } from "mongoose";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
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

export interface DraftDefinition {
  connectionId: string;
  databaseId?: string;
  databaseName?: string;
  /** The SQL exactly as it will run: dbt schema and defer choices rendered. */
  renderedCode: string;
}

export function draftHash(d: DraftDefinition): string {
  return createHash("sha256")
    .update(
      [d.connectionId, d.databaseId ?? "", d.databaseName ?? "", d.renderedCode]
        .map(part => `${part.length}:${part}`)
        .join("|"),
    )
    .digest("hex")
    .slice(0, 32);
}

export function draftArtifactKey(projectId: string, hash: string): string {
  return `apps/drafts/${projectId}/${hash}.parquet`;
}

interface DraftDoc {
  projectId: Types.ObjectId;
  hash: string;
  name: string;
  /** Set once a build succeeded; cleared by a later failure. */
  key?: string | null;
  builtAt?: Date | null;
  expiresAt?: Date | null;
  rowCount?: number | null;
  byteSize?: number | null;
  failures?: number;
  /** Refuse to re-run until then (failure backoff). */
  until?: Date | null;
  error?: string | null;
}

const AppBindingDraft =
  mongoose.models.AppBindingDraft ??
  mongoose.model(
    "AppBindingDraft",
    new Schema(
      {
        projectId: { type: Schema.Types.ObjectId, required: true },
        hash: { type: String, required: true },
        name: { type: String, required: true },
        key: { type: String },
        builtAt: { type: Date },
        expiresAt: { type: Date },
        rowCount: { type: Number },
        byteSize: { type: Number },
        failures: { type: Number, default: 0 },
        until: { type: Date },
        error: { type: String },
      },
      { collection: "app_binding_drafts", timestamps: true },
    )
      .index({ projectId: 1, hash: 1 }, { unique: true })
      .index({ projectId: 1, expiresAt: 1 }),
  );

export type DraftLookup =
  | { kind: "hit"; key: string; rowCount: number; builtAt: Date }
  | { kind: "cooling"; retryAfterMs: number; failures: number; error: string }
  | { kind: "miss" };

/** What a draft request should do: serve the cache, refuse, or build. */
export async function lookupDraft(
  projectId: string,
  hash: string,
  now: Date = new Date(),
): Promise<DraftLookup> {
  const doc = (await AppBindingDraft.findOne({
    projectId: new Types.ObjectId(projectId),
    hash,
  }).lean()) as DraftDoc | null;
  if (!doc) return { kind: "miss" };
  if (doc.until && doc.until > now) {
    return {
      kind: "cooling",
      retryAfterMs: doc.until.getTime() - now.getTime(),
      failures: doc.failures ?? 1,
      error: doc.error ?? "Query failed",
    };
  }
  if (doc.key && doc.builtAt && doc.expiresAt && doc.expiresAt > now) {
    return {
      kind: "hit",
      key: doc.key,
      rowCount: doc.rowCount ?? 0,
      builtAt: doc.builtAt,
    };
  }
  return { kind: "miss" };
}

/**
 * Keep a successful draft build (the local file stays; the caller streams
 * it) and clear its failure streak. Expired drafts of the project go first.
 */
export async function recordDraftBuilt(input: {
  projectId: string;
  name: string;
  hash: string;
  filePath: string;
  rowCount: number;
  byteSize: number;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await pruneExpiredDrafts(input.projectId, now);
  const key = draftArtifactKey(input.projectId, input.hash);
  await getDashboardArtifactStore().put(input.filePath, key, {
    appProjectId: input.projectId,
    binding: input.name,
    draft: "true",
  });
  await AppBindingDraft.updateOne(
    { projectId: new Types.ObjectId(input.projectId), hash: input.hash },
    {
      $set: {
        name: input.name,
        key,
        builtAt: now,
        expiresAt: new Date(now.getTime() + DRAFT_TTL_MS),
        rowCount: input.rowCount,
        byteSize: input.byteSize,
        failures: 0,
        until: null,
        error: null,
      },
    },
    { upsert: true },
  );
}

/**
 * Count a failed draft build: the same definition is refused for a window
 * that doubles per consecutive failure (1m … 15m, the live-binding guard's
 * schedule), so a page reloading a broken query does not re-run it each time.
 * Returns the window.
 */
export async function recordDraftFailed(input: {
  projectId: string;
  name: string;
  hash: string;
  error: string;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const filter = {
    projectId: new Types.ObjectId(input.projectId),
    hash: input.hash,
  };
  const prior = (await AppBindingDraft.findOne(filter)
    .select("failures")
    .lean()) as Pick<DraftDoc, "failures"> | null;
  const failures = (prior?.failures ?? 0) + 1;
  const cooldownMs = cooldownMsFor(failures);
  await AppBindingDraft.updateOne(
    filter,
    {
      $set: {
        name: input.name,
        failures,
        until: new Date(now.getTime() + cooldownMs),
        error: input.error.slice(0, 2000),
      },
    },
    { upsert: true },
  );
  return cooldownMs;
}

async function pruneExpiredDrafts(projectId: string, now: Date) {
  const expired = (await AppBindingDraft.find({
    projectId: new Types.ObjectId(projectId),
    expiresAt: { $lte: now },
  })
    .select("key hash")
    .limit(200)
    .lean()) as unknown as Array<Pick<DraftDoc, "key" | "hash">>;
  if (expired.length === 0) return;
  const store = getDashboardArtifactStore();
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
  }
  await AppBindingDraft.deleteMany({
    projectId: new Types.ObjectId(projectId),
    hash: { $in: expired.map(doc => doc.hash) },
    expiresAt: { $lte: now },
  });
}
