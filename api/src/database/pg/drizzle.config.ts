import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

// Match api/src/index.ts & scripts/neon-branch.ts: load repo-root .env first,
// then optional api/.env fallback without clobbering already-set env vars.
const repoRootEnv = path.resolve(__dirname, "../../../../.env");
if (fs.existsSync(repoRootEnv)) {
  dotenv.config({ path: repoRootEnv, quiet: true });
}
const apiEnv = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(apiEnv)) {
  dotenv.config({ path: apiEnv, quiet: true });
}

export default defineConfig({
  schema: "./src/database/pg/schema/index.ts",
  out: "./src/database/pg/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.POSTGRES_DIRECT_URL || process.env.POSTGRES_URL || "",
  },
});
