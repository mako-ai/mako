/**
 * Derived runtime state per binding — when its artifact was built, its run
 * history, and the public-refresh claim. Not the source of truth: the repo is.
 */
import mongoose, { Schema, Types } from "mongoose";
import {
  PARQUET_CODECS,
  type ParquetCodec,
} from "../../utils/parquet-compression";

/**
 * Derived runtime state per binding (NOT source of truth — that is the repo).
 * Only what the scheduler needs: when the artifact was last built, and
 * which artifact that was.
 */
export interface AppBindingRun {
  at: Date;
  status: "ready" | "error";
  rowCount?: number | null;
  durationMs?: number | null;
  error?: string | null;
  /**
   * The content-addressed artifact this run built. State is per binding
   * NAME while artifacts are per DEFINITION, so without this a run says
   * "fr_demos was built this morning" but not of which query — which is
   * what made #992 impossible to see in the history. Recorded for
   * observability; absent on runs recorded before the field existed.
   */
  artifactKey?: string | null;
  /** Artifact bytes after compression. Absent on older runs. */
  byteSize?: number | null;
  /** Parquet codec of this build. Absent on older runs (all SNAPPY). */
  compression?: ParquetCodec | null;
}

export interface AppBindingStateDoc {
  lastMaterializedAt?: Date;
  lastRowCount?: number;
  history?: AppBindingRun[];
  /** Throttle marker for anonymous on-demand refreshes (public shares). */
  publicRefreshAt?: Date;
}

const AppBindingState =
  mongoose.models.AppBindingState ??
  mongoose.model(
    "AppBindingState",
    new Schema(
      {
        projectId: { type: Schema.Types.ObjectId, required: true },
        name: { type: String, required: true },
        lastMaterializedAt: { type: Date },
        lastRowCount: { type: Number },
        publicRefreshAt: { type: Date },
        history: {
          type: [
            new Schema(
              {
                at: { type: Date, required: true },
                status: { type: String, enum: ["ready", "error"] },
                rowCount: { type: Number },
                durationMs: { type: Number },
                error: { type: String },
                artifactKey: { type: String },
                byteSize: { type: Number },
                compression: { type: String, enum: [...PARQUET_CODECS] },
              },
              { _id: false },
            ),
          ],
          default: undefined,
        },
      },
      { collection: "app_v2_binding_state", timestamps: true },
    ).index({ projectId: 1, name: 1 }, { unique: true }),
  );

export async function getBindingState(
  projectId: string,
  name: string,
): Promise<AppBindingStateDoc | null> {
  return AppBindingState.findOne({
    projectId: new Types.ObjectId(projectId),
    name,
  }).lean() as Promise<AppBindingStateDoc | null>;
}

export async function recordBindingRun(
  projectId: string,
  name: string,
  run: AppBindingRun,
): Promise<void> {
  await AppBindingState.updateOne(
    { projectId: new Types.ObjectId(projectId), name },
    {
      ...(run.status === "ready"
        ? {
            $set: {
              lastMaterializedAt: run.at,
              lastRowCount: run.rowCount ?? 0,
            },
          }
        : {}),
      // Newest first, keep the last 20 runs.
      $push: { history: { $each: [run], $position: 0, $slice: 20 } },
    },
    { upsert: true },
  );
}

/**
 * Claim the right to refresh a binding on behalf of an anonymous viewer:
 * succeeds at most once per `cooldownMs` per binding, atomically, so a
 * public page full of concurrent viewers cannot queue duplicate warehouse
 * queries. Returns
 * how long to wait when the slot is taken.
 *
 * One upsert does the whole thing: the filter admits a row that has never
 * been claimed (no marker) or whose marker is older than the cooldown; a row
 * that exists but is cooling down fails the filter, so the upsert tries to
 * INSERT a duplicate and the unique (projectId, name) index rejects it —
 * that rejection IS the "cooling down" answer, with no read-then-write gap.
 */
export async function claimPublicBindingRefresh(
  projectId: string,
  name: string,
  cooldownMs: number,
): Promise<{ claimed: true } | { claimed: false; retryAfterMs: number }> {
  const now = new Date();
  const filter = { projectId: new Types.ObjectId(projectId), name };
  try {
    await AppBindingState.updateOne(
      {
        ...filter,
        publicRefreshAt: {
          $not: { $gt: new Date(now.getTime() - cooldownMs) },
        },
      },
      { $set: { publicRefreshAt: now } },
      { upsert: true },
    );
    return { claimed: true };
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  const existing = (await AppBindingState.findOne(filter).lean()) as {
    publicRefreshAt?: Date;
  } | null;
  const last = existing?.publicRefreshAt?.getTime() ?? now.getTime();
  return {
    claimed: false,
    retryAfterMs: Math.max(1000, cooldownMs - (now.getTime() - last)),
  };
}
