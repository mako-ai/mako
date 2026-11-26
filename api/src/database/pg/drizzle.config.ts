import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/database/pg/schema/index.ts",
  out: "./src/database/pg/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.POSTGRES_DIRECT_URL || process.env.POSTGRES_URL || "",
  },
});
