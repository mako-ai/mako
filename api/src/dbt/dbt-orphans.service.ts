// Owner: WP5 (warehouse introspection). Stub: the signatures are the contract.
import type { WarehouseRelation } from "../databases/driver";
import type { WarehouseIntrospection } from "../services/warehouse-job-history.service";

export interface DbtOrphansReport {
  environment: string;
  /** Run whose manifest defined the expected set, and that manifest's age. */
  manifestRunId?: string;
  manifestGeneratedAt?: string;
  schemasScanned: string[];
  expectedCount: number;
  /** Relations in the scanned schemas that no model, seed or snapshot owns. */
  orphans: WarehouseRelation[];
}

/**
 * Read-only: relations left behind by deleted models. Nothing is dropped.
 * `supported: false` when the engine cannot list relations or no manifest
 * exists yet. Throws on a failed warehouse query.
 */
export async function listDbtOrphans(params: {
  workspaceId: string;
  projectId: string;
  /** Default: the project's production environment. */
  environment?: string;
}): Promise<WarehouseIntrospection<DbtOrphansReport>> {
  void params;
  throw new Error("not implemented");
}
