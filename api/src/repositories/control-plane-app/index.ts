/**
 * Small app control-plane repositories (Neon Postgres `pg_only`): workflow
 * recorded writes, model catalog snapshots, apps box policy.
 */
import { createPgFirstRepoProxy } from "../resolve-repo";
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
  createPgFirstRepoProxy<WorkflowRecordedWritesRepository>(
    "workflow_recorded_writes",
    new PgWorkflowRecordedWritesRepository(),
    new MongoWorkflowRecordedWritesRepository(),
  );

export const modelCatalogSnapshotsRepo: ModelCatalogSnapshotsRepository =
  createPgFirstRepoProxy<ModelCatalogSnapshotsRepository>(
    "model_catalog_snapshots",
    new PgModelCatalogSnapshotsRepository(),
    new MongoModelCatalogSnapshotsRepository(),
  );

export const appsBoxPolicyRepo: AppsBoxPolicyRepository =
  createPgFirstRepoProxy<AppsBoxPolicyRepository>(
    "apps_box_policy",
    new PgAppsBoxPolicyRepository(),
    new MongoAppsBoxPolicyRepository(),
  );
