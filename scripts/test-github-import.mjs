/**
 * Smoke test: GitHub App auth + public repo import fetch.
 * Usage: node scripts/test-github-import.mjs
 */
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

const { fetchRepoDbtFiles } = await import(
  "../api/src/dbt/dbt-github-sync.service.ts"
);
const { fileExistsAtRef, getRepoInfo } = await import(
  "../api/src/integrations/github/github-api.ts"
);
const { resolveRepoToken } = await import(
  "../api/src/integrations/github/app-auth.ts"
);

const binding = { owner: "dbt-labs", repo: "jaffle_shop", branch: "main" };
const token = await resolveRepoToken();
const info = await getRepoInfo(binding.owner, binding.repo, token);
const hasYml = await fileExistsAtRef(
  binding.owner,
  binding.repo,
  "dbt_project.yml",
  binding.branch,
  token,
);
const { sha, files, skippedLarge } = await fetchRepoDbtFiles(binding);

console.log(
  JSON.stringify(
    {
      repo: `${binding.owner}/${binding.repo}`,
      defaultBranch: info.defaultBranch,
      hasDbtProjectYml: hasYml,
      sha: sha?.slice(0, 12),
      fileCount: files.length,
      skippedLarge,
      samplePaths: files.slice(0, 8).map(f => f.path),
    },
    null,
    2,
  ),
);

if (!hasYml || files.length === 0) {
  process.exit(1);
}
