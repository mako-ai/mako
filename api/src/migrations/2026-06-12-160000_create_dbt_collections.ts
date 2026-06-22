import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create dbt_projects/dbt_files/dbt_jobs/dbt_runs collections with indexes " +
  "for the dbt Cloud replica (workspace-scoped dbt Core projects)";

function hasIndexOnKeys(
  indexes: { key: Record<string, number | string> }[],
  keyPattern: Record<string, number | string>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

async function ensureCollection(db: Db, name: string): Promise<void> {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name);
    log.info(`Created '${name}' collection`);
  } else {
    log.info(`'${name}' collection already exists`);
  }
}

export async function up(db: Db): Promise<void> {
  await ensureCollection(db, "dbt_projects");
  await ensureCollection(db, "dbt_files");
  await ensureCollection(db, "dbt_jobs");
  await ensureCollection(db, "dbt_runs");

  const projects = db.collection("dbt_projects");
  let indexes = await projects.indexes();
  if (!hasIndexOnKeys(indexes, { workspaceId: 1, name: 1 })) {
    await projects.createIndex(
      { workspaceId: 1, name: 1 },
      { unique: true, name: "dbt_projects_workspace_name_unique" },
    );
    log.info("Created unique index on dbt_projects { workspaceId, name }");
  }
  if (!hasIndexOnKeys(indexes, { workspaceId: 1, updatedAt: -1 })) {
    await projects.createIndex(
      { workspaceId: 1, updatedAt: -1 },
      { name: "dbt_projects_workspace_updated" },
    );
    log.info("Created index on dbt_projects { workspaceId, updatedAt }");
  }

  const files = db.collection("dbt_files");
  indexes = await files.indexes();
  if (!hasIndexOnKeys(indexes, { projectId: 1, path: 1 })) {
    await files.createIndex(
      { projectId: 1, path: 1 },
      { unique: true, name: "dbt_files_project_path_unique" },
    );
    log.info("Created unique index on dbt_files { projectId, path }");
  }
  if (
    !hasIndexOnKeys(indexes, { workspaceId: 1, projectId: 1, is_deleted: 1 })
  ) {
    await files.createIndex(
      { workspaceId: 1, projectId: 1, is_deleted: 1 },
      { name: "dbt_files_workspace_project" },
    );
    log.info(
      "Created index on dbt_files { workspaceId, projectId, is_deleted }",
    );
  }

  const jobs = db.collection("dbt_jobs");
  indexes = await jobs.indexes();
  if (!hasIndexOnKeys(indexes, { workspaceId: 1, projectId: 1 })) {
    await jobs.createIndex(
      { workspaceId: 1, projectId: 1 },
      { name: "dbt_jobs_workspace_project" },
    );
    log.info("Created index on dbt_jobs { workspaceId, projectId }");
  }
  if (!hasIndexOnKeys(indexes, { "scheduledRun.nextAt": 1, enabled: 1 })) {
    await jobs.createIndex(
      { "scheduledRun.nextAt": 1, enabled: 1 },
      { sparse: true, name: "dbt_jobs_scheduler_due" },
    );
    log.info("Created index on dbt_jobs { scheduledRun.nextAt, enabled }");
  }

  const runs = db.collection("dbt_runs");
  indexes = await runs.indexes();
  if (
    !hasIndexOnKeys(indexes, { workspaceId: 1, projectId: 1, createdAt: -1 })
  ) {
    await runs.createIndex(
      { workspaceId: 1, projectId: 1, createdAt: -1 },
      { name: "dbt_runs_workspace_project_created" },
    );
    log.info("Created index on dbt_runs { workspaceId, projectId, createdAt }");
  }
  if (!hasIndexOnKeys(indexes, { jobId: 1, createdAt: -1 })) {
    await runs.createIndex(
      { jobId: 1, createdAt: -1 },
      { sparse: true, name: "dbt_runs_job_created" },
    );
    log.info("Created index on dbt_runs { jobId, createdAt }");
  }
}
