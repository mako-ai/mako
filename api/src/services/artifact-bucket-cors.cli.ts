/**
 * Operator CLI: put the browser CORS rule on the artifact bucket.
 *
 *   pnpm artifacts:cors
 *
 * The API installs the rule itself the first time it serves an artifact —
 * this command exists for service accounts that may not update bucket
 * metadata: run it once with credentials that may (a developer's gcloud
 * login), then set APPS_ARTIFACT_REDIRECTS=on for the API. Idempotent; says
 * what it found and what it did, and never prints credentials.
 */
// The root .env, wherever this is run from — tsx's cwd is api/, the env
// file is the repo's.
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(process.cwd(), ".env") });
loadEnv({ path: path.resolve(process.cwd(), "..", ".env") });

async function main(): Promise<void> {
  const { getDashboardArtifactStore } = await import(
    "./dashboard-artifact-store.service"
  );
  const store = getDashboardArtifactStore();
  if (!store.ensureBrowserCors) {
    console.log(
      `Artifact store type is "${store.type}" — no bucket CORS to configure.` +
        (store.type === "s3"
          ? " Configure the S3 bucket's CORS (allow GET/HEAD from *) " +
            "yourself, then set APPS_ARTIFACT_REDIRECTS=on."
          : ""),
    );
    return;
  }
  const ok = await store.ensureBrowserCors();
  console.log(
    ok
      ? "Bucket CORS is in place — signed-URL redirects will activate."
      : "Could not confirm bucket CORS; nothing was changed.",
  );
}

main().catch(error => {
  console.error("artifacts:cors failed:", error?.message ?? error);
  // eslint-disable-next-line no-process-exit -- operator CLI, not server code
  process.exit(1);
});
