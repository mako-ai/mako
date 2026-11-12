// Owner: WP5 (warehouse introspection). Stub: the signatures are the contract.

/** Shared by the three WP5 tools: unsupported engines answer, never throw. */
export type WarehouseIntrospection<T> =
  ({ supported: true } & T) | { supported: false; reason: string };

interface JobHistoryTarget {
  workspaceId: string;
  projectId: string;
  /** Default: the project's production environment. */
  environment?: string;
  /** Look-back window. Default 7, max 30. */
  days?: number;
  /** Default 100, max 500. */
  limit?: number;
}

export interface JobHistoryMeta {
  /** "user" = fell back to jobs of the connection's own account. */
  scope: "project" | "user";
  days: number;
  /** Set on fallback: the missing permission and the grant command. */
  warning?: string;
}

export interface ModelCostRow {
  /** YYYY-MM-DD, UTC. */
  day: string;
  nodeId?: string;
  relation?: string;
  jobs: number;
  bytesBilled: number;
  slotMs: number;
}

export interface TableReaderRow {
  makoSource?: string;
  makoApp?: string;
  userEmail: string;
  jobs: number;
  bytesBilled: number;
  lastReadAt: string;
}

/**
 * Cost per model per day for Mako dbt runs, matched through the runs'
 * `invocationIds`. `runId` narrows to one run, `jobId` to one job. Throws on
 * a failed warehouse query.
 */
export async function modelCost(
  params: JobHistoryTarget & { jobId?: string; runId?: string },
): Promise<WarehouseIntrospection<JobHistoryMeta & { rows: ModelCostRow[] }>> {
  void params;
  throw new Error("not implemented");
}

/** Who read one relation. Throws on a failed warehouse query. */
export async function tableReaders(
  params: JobHistoryTarget & {
    relation: { database?: string; schema: string; name: string };
  },
): Promise<
  WarehouseIntrospection<JobHistoryMeta & { rows: TableReaderRow[] }>
> {
  void params;
  throw new Error("not implemented");
}
