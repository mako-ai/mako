/* eslint-disable no-console */
/**
 * Seed a local dbt project wired to a local Postgres so you can exercise the
 * resident dbt engine end-to-end through the running app (open the project,
 * hit Compile / use the agent's dbt_compile_model — with DBT_ENGINE_ENABLED=true
 * the compile is served by the warm in-memory manifest).
 *
 * Companion Postgres (throwaway):
 *   docker run -d --name mako-dbt-pg -e POSTGRES_PASSWORD=testpw \
 *     -e POSTGRES_DB=mako -p 55432:5432 postgres:16
 *
 * Then:  pnpm --filter api run seed:dbt-demo
 *
 * Idempotent. REFUSES to run against a production-looking database.
 * Credentials / target Postgres are overridable via env (see constants below).
 */
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcrypt";

const envPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const DEMO_EMAIL = (process.env.DBT_DEMO_EMAIL || "dbt-demo@mako.dev")
  .trim()
  .toLowerCase();
const DEMO_PASSWORD = process.env.DBT_DEMO_PASSWORD || "DbtDemo!2024";
const WORKSPACE_NAME = "dbt Engine Demo";
const CONNECTION_NAME = "Local Postgres (dbt demo)";
const PROJECT_NAME = "Engine Demo";

// Target Postgres (the throwaway container above by default).
const PG_HOST = process.env.DBT_DEMO_PG_HOST || "127.0.0.1";
const PG_PORT = Number(process.env.DBT_DEMO_PG_PORT || "55432");
const PG_USER = process.env.DBT_DEMO_PG_USER || "postgres";
const PG_PASSWORD = process.env.DBT_DEMO_PG_PASSWORD || "testpw";
const PG_DATABASE = process.env.DBT_DEMO_PG_DATABASE || "mako";

const PROJECT_FILES: Array<{ path: string; content: string }> = [
  {
    path: "dbt_project.yml",
    content: [
      "name: engine_demo",
      "profile: mako", // must match DBT_PROFILE_NAME rendered by adapter-map
      'version: "1.0.0"',
      "config-version: 2",
      'model-paths: ["models"]',
      "models:",
      "  engine_demo:",
      "    +materialized: view",
      "",
    ].join("\n"),
  },
  {
    path: "models/example/my_first_model.sql",
    content: [
      "-- Edit me and hit Compile: the resident engine reuses the warm manifest.",
      "select",
      "  1 as id,",
      "  'demo' as name,",
      "  current_date as loaded_on",
      "",
    ].join("\n"),
  },
  {
    path: "models/example/downstream.sql",
    content: [
      "select id, name from {{ ref('my_first_model') }} where id > 0",
      "",
    ].join("\n"),
  },
];

function isProductionUri(uri: string): boolean {
  if (process.env.PROD_DATABASE_URL && uri === process.env.PROD_DATABASE_URL) {
    return true;
  }
  try {
    const dbName = new URL(uri).pathname.replace(/^\//, "").split("?")[0];
    if (dbName.toLowerCase() === "production") return true;
  } catch {
    /* non-standard URI */
  }
  return /\/production(\b|\?|$)/i.test(uri);
}

async function main(): Promise<void> {
  const uri = process.env.DEV_DATABASE_URL || process.env.DATABASE_URL;
  if (!uri) {
    console.log("[seed-dbt-demo] No DATABASE_URL set; skipping.");
    return;
  }
  if (isProductionUri(uri)) {
    console.log("[seed-dbt-demo] Refusing to seed PRODUCTION. Skipping.");
    return;
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  const { User } = await import("../database/schema");
  const { DatabaseConnection, DbtProject } = await import(
    "../database/workspace-schema"
  );
  const { writeWorkingFile } = await import(
    "../dbt/dbt-working-tree.service"
  );
  const { workspaceService } = await import("../services/workspace.service");

  const rounds = parseInt(process.env.BCRYPT_ROUNDS || "10", 10);
  const hashedPassword = await bcrypt.hash(DEMO_PASSWORD, rounds);

  let user = await User.findOne({ email: DEMO_EMAIL });
  if (!user) {
    user = await User.create({
      email: DEMO_EMAIL,
      hashedPassword,
      emailVerified: true,
      onboarding: { completedAt: new Date(), role: "developer" },
    });
    console.log(`[seed-dbt-demo] Created user ${DEMO_EMAIL}`);
  } else {
    user.hashedPassword = hashedPassword;
    user.emailVerified = true;
    user.onboarding = {
      ...(user.onboarding || {}),
      completedAt: user.onboarding?.completedAt || new Date(),
    };
    await user.save();
    console.log(`[seed-dbt-demo] Updated user ${DEMO_EMAIL}`);
  }

  const { workspace } = await workspaceService.getOrCreateDefaultWorkspace(
    user._id,
    WORKSPACE_NAME,
  );
  console.log(
    `[seed-dbt-demo] Workspace: "${workspace.name}" (${workspace._id})`,
  );

  // Postgres connection (the `set: encryptObject` hook encrypts at rest).
  let connection = await DatabaseConnection.findOne({
    workspaceId: workspace._id,
    name: CONNECTION_NAME,
  });
  const connectionFields = {
    host: PG_HOST,
    port: PG_PORT,
    username: PG_USER,
    password: PG_PASSWORD,
    database: PG_DATABASE,
  };
  if (!connection) {
    connection = await DatabaseConnection.create({
      workspaceId: workspace._id,
      name: CONNECTION_NAME,
      type: "postgresql",
      connection: connectionFields,
      createdBy: user._id.toString(),
    });
    console.log("[seed-dbt-demo] Created Postgres connection.");
  } else {
    connection.set("connection", connectionFields);
    await connection.save();
    console.log("[seed-dbt-demo] Updated Postgres connection.");
  }

  // dbt project with a single "dev" environment pointing at the connection.
  let project = await DbtProject.findOne({
    workspaceId: workspace._id,
    name: PROJECT_NAME,
  });
  const environments = [
    {
      name: "dev",
      connectionId: connection._id,
      targetSchema: "public",
      threads: 4,
    },
  ];
  if (!project) {
    project = await DbtProject.create({
      workspaceId: workspace._id,
      name: PROJECT_NAME,
      dbtVersion: "1.9",
      environments,
      defaultEnvironment: "dev",
      createdBy: user._id.toString(),
    });
    console.log("[seed-dbt-demo] Created dbt project.");
  } else {
    project.environments = environments;
    project.defaultEnvironment = "dev";
    await project.save();
    console.log("[seed-dbt-demo] Updated dbt project.");
  }

  for (const file of PROJECT_FILES) {
    await writeWorkingFile(
      project,
      user._id.toString(),
      file.path,
      file.content,
    );
  }
  console.log(`[seed-dbt-demo] Seeded ${PROJECT_FILES.length} dbt files.`);

  console.log(
    [
      "",
      "[seed-dbt-demo] Done. To exercise the resident engine:",
      "  1) Ensure local Postgres is running (see header comment).",
      "  2) Set DBT_ENGINE_ENABLED=true in your .env.",
      "  3) pnpm dev",
      `  4) Log in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`,
      `  5) Open project "${PROJECT_NAME}" -> models/example/my_first_model.sql -> Compile.`,
      "  6) Watch the API logs for: 'dbt engine compile hit'.",
      "",
    ].join("\n"),
  );
}

main()
  .catch(err => {
    console.log(
      "[seed-dbt-demo] Failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(process.exitCode ?? 0);
  });
