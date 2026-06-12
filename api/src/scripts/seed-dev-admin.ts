/* eslint-disable no-console */
/**
 * Seed a deterministic admin test user into the DEV database.
 *
 * Why this exists
 * ---------------
 * The Mako dev database is periodically restored from a prod snapshot, which
 * wipes any ad-hoc test accounts. Running this on Cloud Agent VM startup
 * guarantees there is always a known-good login that future agents can use to
 * sign in to the running app with prod-like data available.
 *
 * Behavior
 * --------
 * - Connects to DEV_DATABASE_URL (preferred) or DATABASE_URL.
 * - REFUSES to run against the production database (safety guard).
 * - Idempotently upserts a verified user, (re)sets its password to the known
 *   dev password, marks onboarding complete, ensures it owns a workspace, and
 *   attaches the Chinook demo Postgres database so there is queryable data.
 * - Never throws on a "soft" failure (missing URL, unreachable DB): it logs and
 *   exits 0 so it can be wired into VM startup without ever breaking it.
 *
 * Credentials (override via env if desired):
 *   DEV_ADMIN_EMAIL    (default: cloud-agent@mako.dev)
 *   DEV_ADMIN_PASSWORD (default: CloudAgentDev!2024)
 */
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcrypt";

// Load root .env if present (matches api/src/index.ts behavior). Real injected
// env vars take precedence because dotenv does not override existing values.
const envPath = path.resolve(__dirname, "../../../.env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const DEV_ADMIN_EMAIL = (process.env.DEV_ADMIN_EMAIL || "cloud-agent@mako.dev")
  .trim()
  .toLowerCase();
const DEV_ADMIN_PASSWORD =
  process.env.DEV_ADMIN_PASSWORD || "CloudAgentDev!2024";
const WORKSPACE_NAME = "Cloud Agent Dev";

function resolveDevUri(): string | undefined {
  // Prefer the explicit dev URL so we never accidentally seed staging/prod.
  return process.env.DEV_DATABASE_URL || process.env.DATABASE_URL || undefined;
}

function isProductionUri(uri: string): boolean {
  const prod = process.env.PROD_DATABASE_URL;
  if (prod && uri === prod) return true;
  // Heuristic: the prod database name in these connection strings is "production".
  try {
    const dbName = new URL(uri).pathname.replace(/^\//, "").split("?")[0];
    if (dbName.toLowerCase() === "production") return true;
  } catch {
    // Non-standard URI; fall through to substring check below.
  }
  return /\/production(\b|\?|$)/i.test(uri);
}

async function main(): Promise<void> {
  const uri = resolveDevUri();
  if (!uri) {
    console.log(
      "[seed-dev-admin] No DEV_DATABASE_URL/DATABASE_URL set; skipping.",
    );
    return;
  }

  if (isProductionUri(uri)) {
    console.log(
      "[seed-dev-admin] Refusing to seed: resolved URI looks like PRODUCTION. Skipping.",
    );
    return;
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  // Import models/services lazily so a connection failure above short-circuits
  // before any model side effects run.
  const { User } = await import("../database/schema");
  const { DatabaseConnection } = await import("../database/workspace-schema");
  const { workspaceService } = await import("../services/workspace.service");

  const rounds = parseInt(process.env.BCRYPT_ROUNDS || "10", 10);
  const hashedPassword = await bcrypt.hash(DEV_ADMIN_PASSWORD, rounds);

  // Upsert the user: always (re)set the password + verified + onboarding-complete
  // so login works reliably even after a prod restore.
  let user = await User.findOne({ email: DEV_ADMIN_EMAIL });
  if (!user) {
    user = await User.create({
      email: DEV_ADMIN_EMAIL,
      hashedPassword,
      emailVerified: true,
      onboarding: { completedAt: new Date(), role: "developer" },
    });
    console.log(`[seed-dev-admin] Created user ${DEV_ADMIN_EMAIL}`);
  } else {
    user.hashedPassword = hashedPassword;
    user.emailVerified = true;
    user.onboarding = {
      ...(user.onboarding || {}),
      completedAt: user.onboarding?.completedAt || new Date(),
    };
    await user.save();
    console.log(`[seed-dev-admin] Updated existing user ${DEV_ADMIN_EMAIL}`);
  }

  // Ensure the user owns a workspace (idempotent; creates on first run).
  const { workspace } = await workspaceService.getOrCreateDefaultWorkspace(
    user._id,
    WORKSPACE_NAME,
  );
  console.log(
    `[seed-dev-admin] Workspace ready: "${workspace.name}" (${workspace._id})`,
  );

  // Attach the Chinook demo Postgres DB so there is real queryable data.
  const demoUrl = process.env.DEMO_DATABASE_URL;
  if (demoUrl) {
    const existingDemo = await DatabaseConnection.findOne({
      workspaceId: workspace._id,
      isDemo: true,
    });
    if (!existingDemo) {
      await DatabaseConnection.create({
        workspaceId: workspace._id,
        name: "Chinook Music Store",
        type: "postgresql",
        connection: { connectionString: demoUrl },
        isDemo: true,
        createdBy: user._id,
      });
      console.log("[seed-dev-admin] Attached Chinook demo database.");
    } else {
      console.log("[seed-dev-admin] Demo database already present.");
    }
  } else {
    console.log(
      "[seed-dev-admin] DEMO_DATABASE_URL not set; skipping demo DB attach.",
    );
  }

  console.log(
    `[seed-dev-admin] Done. Login with ${DEV_ADMIN_EMAIL} / (DEV_ADMIN_PASSWORD).`,
  );
}

main()
  .catch(err => {
    // Soft-fail: never break VM startup if the dev DB is unreachable.
    console.log(
      "[seed-dev-admin] Skipped due to error:",
      err instanceof Error ? err.message : String(err),
    );
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
