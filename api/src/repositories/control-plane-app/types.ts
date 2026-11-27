/**
 * Small app control-plane repositories: a dry run's recorded writes, the
 * global model-catalog snapshots, and the apps box idle policy.
 */
import type { RecordedRequest } from "../../connections/forward";
import type { ModelCatalogSnapshotIdPg } from "../../database/pg/schema/control-plane-app";

export type ModelCatalogSnapshotId = ModelCatalogSnapshotIdPg;

// ── Workflow recorded writes ────────────────────────────────────────────

export interface RecordedWriteInput {
  workspaceId: string;
  runId: string;
  userId?: string;
  connectionId: string;
  connection: string;
  step?: string;
  request: RecordedRequest;
  bodyCut?: boolean;
  wouldSend?: boolean;
}

export interface RecordedWriteRow {
  connection: string;
  step?: string;
  request: RecordedRequest;
  seq: number;
  bodyCut?: boolean;
  wouldSend?: boolean;
  at: Date;
}

export interface RecordedWritesFilter {
  workspaceId: string;
  runId: string;
  /** Only this person's writes (a sandbox run). */
  userId?: string;
}

export interface WorkflowRecordedWritesRepository {
  /** Append at the next sequence number, or return null at the per-run cap. */
  appendWrite(input: RecordedWriteInput, max: number): Promise<number | null>;
  countWrites(filter: RecordedWritesFilter): Promise<number>;
  /** Writes in `seq` order from `offset`, at most `limit`. */
  listWrites(
    filter: RecordedWritesFilter,
    page: { offset: number; limit: number },
  ): Promise<RecordedWriteRow[]>;
}

// ── Model catalog snapshots ─────────────────────────────────────────────

export interface ModelCatalogSnapshotRecord {
  id: ModelCatalogSnapshotId;
  data: unknown;
  fetchedAt: Date;
  itemCount: number;
}

export interface ModelCatalogSnapshotWrite {
  data: unknown;
  fetchedAt: Date;
  itemCount: number;
}

export interface ModelCatalogSnapshotsRepository {
  findSnapshot(
    id: ModelCatalogSnapshotId,
  ): Promise<ModelCatalogSnapshotRecord | null>;
  findSnapshots(
    ids: readonly ModelCatalogSnapshotId[],
  ): Promise<ModelCatalogSnapshotRecord[]>;
  upsertSnapshot(
    id: ModelCatalogSnapshotId,
    write: ModelCatalogSnapshotWrite,
  ): Promise<void>;
  /**
   * Read-modify-write one snapshot under a lock. `mutate` gets the current
   * row (or null) and returns the new row, or null to leave it unchanged.
   * Returns whether it wrote.
   */
  mutateSnapshot(
    id: ModelCatalogSnapshotId,
    mutate: (
      current: ModelCatalogSnapshotRecord | null,
    ) => ModelCatalogSnapshotWrite | null,
  ): Promise<boolean>;
}

// ── Apps box policy ─────────────────────────────────────────────────────

export interface AppsBoxPolicyRepository {
  /** Record `now` the first time; return the stored start either way. */
  ensureSince(id: string, now: Date): Promise<Date>;
  readSince(id: string): Promise<Date | null>;
}
