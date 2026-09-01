/**
 * dbt orchestration config into the workspace repo (apps.md §23): every
 * job becomes `dbt/jobs/<slug>.yml`, environments + settings become
 * `dbt/environments.yml`. Rows stay as the scheduler's derived index
 * (runtime fields never enter git); slugs + blob shas are stamped.
 *
 * Mongoose is connected FIRST — repo helpers use mongoose models, and the
 * dbt cutover proved that skipping this turns every lookup into a silently
 * swallowed 10s buffering timeout (apps.md §21 post-mortem).
 */
import { Db } from "mongodb";
import mongoose from "mongoose";
import { loggers } from "../logging";
import { adoptDbtConfig } from "../dbt/dbt-config.service";
import { mirrorPushNow } from "../apps/cloud-repo.service";

const log = loggers.migration();

export const description =
  "dbt jobs + environments become YAML files in the workspace repo (dbt/jobs/*.yml, dbt/environments.yml)";

export async function up(db: Db): Promise<void> {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(
      (db as unknown as { client: { s: { url: string } } }).client.s.url,
      { dbName: db.databaseName },
    );
  }
  const workspaceIds = (await db
    .collection("dbt_projects")
    .distinct("workspaceId")) as Array<{ toString(): string }>;
  let adopted = 0;
  let failed = 0;
  for (const raw of workspaceIds) {
    const workspaceId = raw.toString();
    try {
      const report = await adoptDbtConfig(workspaceId);
      if (report.written > 0) {
        await mirrorPushNow(workspaceId);
        adopted++;
        log.info("dbt config adopted", { workspaceId, ...report });
      }
    } catch (error) {
      failed++;
      log.error("dbt config adoption failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failed > 0) {
    throw new Error(`dbt config adoption failed for ${failed} workspace(s)`);
  }
  log.info("dbt_config_to_git done", {
    workspaces: workspaceIds.length,
    adopted,
  });
}
