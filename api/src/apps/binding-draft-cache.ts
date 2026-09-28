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
}

export function draftHash(d: DraftDefinition): string {
  return createHash("sha256")
    .update(
      [
        d.connectionId,
        d.databaseId ?? "",
        d.databaseName ?? "",
        d.renderedCode,
        d.devModifiedAt == null ? "" : String(d.devModifiedAt),
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

interface DraftDoc {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  hash: string;
  kind: "build" | "failure";
  name: string;
  key?: string | null;
  builtAt?: Date | null;
  rowCount?: number | null;
  byteSize?: number | null;
  failures?: number;
  /** Refuse to re-run until then (failure backoff). */
  until?: Date | null;
  error?: string | null;
  expiresAt: Date;
}

const AppBindingDraft =
  mongoose.models.AppBindingDraft ??
  mongoose.model(
    "AppBindingDraft",
    new Schema(
      {
        projectId: { type: Schema.Types.ObjectId, required: true },
        hash: { type: String, required: true },
        kind: { type: String, enum: ["build", "failure"], required: true },
        name: { type: String, required: true },
        key: { type: String },
        builtAt: { type: Date },
        rowCount: { type: Number },
        byteSize: { type: Number },
        failures: { type: Number },
        until: { type: Date },
        error: { type: String },
        expiresAt: { type: Date, required: true },
      },
      { collection: "app_binding_drafts", timestamps: true },
    )
      .index({ projectId: 1, hash: 1, kind: 1, expiresAt: -1 })
      .index({ projectId: 1, expiresAt: 1 }),
  );

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
): Promise<DraftLookup> {
  const project = new Types.ObjectId(projectId);
  const build = (await AppBindingDraft.findOne({
    projectId: project,
    hash,
    kind: "build",
    expiresAt: { $gt: now },
  })
    .sort({ builtAt: -1 })
    .lean()) as DraftDoc | null;
  if (build?.key && build.builtAt) {
    return {
      kind: "hit",
      key: build.key,
      rowCount: build.rowCount ?? 0,
      builtAt: build.builtAt,
    };
  }
  const failure = (await AppBindingDraft.findOne({
    projectId: project,
    hash,
    kind: "failure",
  }).lean()) as DraftDoc | null;
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
): Promise<void> {
  await AppBindingDraft.deleteOne({
    projectId: new Types.ObjectId(projectId),
    kind: "build",
    key,
  });
}

/**
 * Keep a successful draft build under its own object key (the local file
 * stays; the caller streams it) and end the failure streak. Expired rows of
 * the project go first.
 */
export async function recordDraftBuilt(input: {
  projectId: string;
  name: string;
  hash: string;
  filePath: string;
  rowCount: number;
  byteSize: number;
  now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  await pruneExpiredDrafts(input.projectId, now);
  const key = draftArtifactKey(
    input.projectId,
    input.hash,
    randomBytes(6).toString("hex"),
  );
  await getDashboardArtifactStore().put(input.filePath, key, {
    appProjectId: input.projectId,
    binding: input.name,
    draft: "true",
  });
  const project = new Types.ObjectId(input.projectId);
  await AppBindingDraft.create({
    projectId: project,
    hash: input.hash,
    kind: "build",
    name: input.name,
    key,
    builtAt: now,
    rowCount: input.rowCount,
    byteSize: input.byteSize,
    expiresAt: new Date(now.getTime() + DRAFT_TTL_MS),
  });
  await AppBindingDraft.deleteMany({
    projectId: project,
    hash: input.hash,
    kind: "failure",
  });
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
  name: string;
  hash: string;
  error: string;
  now?: Date;
}): Promise<number> {
  const now = input.now ?? new Date();
  const filter = {
    projectId: new Types.ObjectId(input.projectId),
    hash: input.hash,
    kind: "failure",
  };
  const prior = (await AppBindingDraft.findOne(filter)
    .select("failures")
    .lean()) as Pick<DraftDoc, "failures"> | null;
  const failures = (prior?.failures ?? 0) + 1;
  const cooldownMs = cooldownMsFor(failures);
  const until = new Date(now.getTime() + cooldownMs);
  await AppBindingDraft.updateOne(
    filter,
    {
      $set: {
        name: input.name,
        failures,
        until,
        error: input.error.slice(0, 2000),
        expiresAt: new Date(until.getTime() + FAILURE_RETENTION_MS),
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
    .select("_id key")
    .limit(200)
    .lean()) as unknown as Array<Pick<DraftDoc, "_id" | "key">>;
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
  await AppBindingDraft.deleteMany({ _id: { $in: expired.map(d => d._id) } });
}
