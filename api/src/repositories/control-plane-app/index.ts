/** Workflow recorded writes, model catalog snapshots and the box policy. The cutover fence selects the authoritative store. */
import { createControlPlaneRepo } from "../control-plane-fence";
import {
  MongoAppsBoxPolicyRepository,
  MongoModelCatalogSnapshotsRepository,
  MongoWorkflowRecordedWritesRepository,
} from "./mongo.repo";
import {
  PgAppsBoxPolicyRepository,
  PgModelCatalogSnapshotsRepository,
  PgWorkflowRecordedWritesRepository,
} from "./pg.repo";
import type {
  AppsBoxPolicyRepository,
  ModelCatalogSnapshotsRepository,
  WorkflowRecordedWritesRepository,
} from "./types";

export * from "./types";
export {
  MongoAppsBoxPolicyRepository,
  MongoModelCatalogSnapshotsRepository,
  MongoWorkflowRecordedWritesRepository,
} from "./mongo.repo";
export {
  PgAppsBoxPolicyRepository,
  PgModelCatalogSnapshotsRepository,
  PgWorkflowRecordedWritesRepository,
} from "./pg.repo";

export const workflowRecordedWritesRepo: WorkflowRecordedWritesRepository =
  createControlPlaneRepo<WorkflowRecordedWritesRepository>(
    "workflow_recorded_writes",
    new PgWorkflowRecordedWritesRepository(),
    new MongoWorkflowRecordedWritesRepository(),
    ["countWrites", "listWrites"],
  );

export const modelCatalogSnapshotsRepo: ModelCatalogSnapshotsRepository =
  createControlPlaneRepo<ModelCatalogSnapshotsRepository>(
    "model_catalog_snapshots",
    new PgModelCatalogSnapshotsRepository(),
    new MongoModelCatalogSnapshotsRepository(),
    ["findSnapshot", "findSnapshots"],
  );

export const appsBoxPolicyRepo: AppsBoxPolicyRepository =
  createControlPlaneRepo<AppsBoxPolicyRepository>(
    "apps_box_policy",
    new PgAppsBoxPolicyRepository(),
    new MongoAppsBoxPolicyRepository(),
    ["readSince"],
  );
