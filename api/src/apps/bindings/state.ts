/**
 * Derived runtime state per binding — when its artifact was built, its run
 * history, and the public-refresh claim. Not the source of truth: the repo is.
 */
import { appsMetadataRepo } from "../../repositories/apps-metadata";
import { type ParquetCodec } from "../../utils/parquet-compression";

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

export async function getBindingState(
  projectId: string,
  name: string,
  workspaceId?: string,
): Promise<AppBindingStateDoc | null> {
  return appsMetadataRepo.getBindingState(projectId, name, workspaceId);
}

export async function recordBindingRun(
  projectId: string,
  name: string,
  run: AppBindingRun,
  workspaceId?: string,
): Promise<void> {
  await appsMetadataRepo.recordBindingRun(projectId, name, run, workspaceId);
}

/**
 * Claim the right to refresh a binding on behalf of an anonymous viewer:
 * succeeds at most once per `cooldownMs` per binding, atomically, so a
 * public page full of concurrent viewers cannot queue duplicate warehouse
 * queries. Returns
 * how long to wait when the slot is taken.
 */
export async function claimPublicBindingRefresh(
  projectId: string,
  name: string,
  cooldownMs: number,
  workspaceId?: string,
): Promise<{ claimed: true } | { claimed: false; retryAfterMs: number }> {
  return appsMetadataRepo.claimPublicBindingRefresh(
    projectId,
    name,
    cooldownMs,
    undefined,
    workspaceId,
  );
}
