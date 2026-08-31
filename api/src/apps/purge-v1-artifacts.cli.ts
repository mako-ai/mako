/* eslint-disable no-console */
/**
 * Sweep `v1_artifact_purge_backlog` (apps.md §17): delete the v1 binding
 * parquet prefixes the rip-out migration recorded before dropping
 * `makoapps`. Exists because the first prod run was denied
 * storage.objects.list — run this with a credential that can list/delete on
 * GCS_DASHBOARD_BUCKET.
 *
 *   GCS_DASHBOARD_BUCKET=<bucket> pnpm apps:purge-v1-artifacts [--execute]
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(process.cwd(), ".env") });
loadEnv({ path: path.resolve(process.cwd(), "..", ".env") });
import { MongoClient } from "mongodb";
import { Storage } from "@google-cloud/storage";

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const uri = process.env.DATABASE_URL;
  const bucketName = process.env.GCS_DASHBOARD_BUCKET;
  if (!uri) throw new Error("DATABASE_URL is not set");
  if (!bucketName) throw new Error("GCS_DASHBOARD_BUCKET is not set");
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const backlog = client.db().collection("v1_artifact_purge_backlog");
    const entries = await backlog
      .find({ purgedAt: { $exists: false } })
      .toArray();
    const prefixes = entries.flatMap(e => (e.prefixes as string[]) ?? []);
    console.log(
      `${entries.length} backlog entr${entries.length === 1 ? "y" : "ies"}, ${prefixes.length} prefixes`,
    );
    if (prefixes.length === 0) return;
    const bucket = new Storage().bucket(bucketName);
    let deleted = 0;
    for (const p of prefixes) {
      const [files] = await bucket.getFiles({ prefix: p });
      if (files.length === 0) continue;
      console.log(
        `${execute ? "deleting" : "would delete"} ${files.length} object(s) under ${p}`,
      );
      if (execute) await bucket.deleteFiles({ prefix: p, force: true });
      deleted += files.length;
    }
    console.log(
      `${execute ? "deleted" : "would delete"} ${deleted} object(s) total`,
    );
    if (execute) {
      await backlog.updateMany(
        { purgedAt: { $exists: false } },
        { $set: { purgedAt: new Date() } },
      );
    } else {
      console.log("dry run — pass --execute to delete");
    }
  } finally {
    await client.close();
  }
}

main().then(
  // eslint-disable-next-line no-process-exit -- operator CLI, not server code
  () => process.exit(0),
  error => {
    console.error(error instanceof Error ? error.message : error);
    // eslint-disable-next-line no-process-exit -- operator CLI, not server code
    process.exit(1);
  },
);
