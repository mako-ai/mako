#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SECRET_NAMES = [
  "NEON_API_KEY",
  "NEON_ORG_ID",
  "NEON_PROJECT_ID",
  "NEON_DATABASE_NAME",
  "NEON_ROLE_NAME",
  "NEON_POOLED",
];

loadDotenv(".env");

function loadDotenv(filePath) {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) return;

  const content = readFileSync(absolutePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ||= value;
  }
}

function projectArgs() {
  const project =
    process.env.GCP_SECRET_PROJECT_ID ||
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT;
  return project ? ["--project", project] : [];
}

function runGcloud(args, options = {}) {
  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
    stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    input: options.input,
  });
  if (result.status !== 0) {
    const message = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(`gcloud ${args.join(" ")} failed${message ? `: ${message}` : ""}`);
  }
  return result.stdout.trim();
}

function secretExists(name) {
  const result = spawnSync(
    "gcloud",
    ["secrets", "describe", name, ...projectArgs(), "--format=value(name)", "--quiet"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return result.status === 0;
}

function pushSecret(name, value) {
  if (!secretExists(name)) {
    runGcloud(
      [
        "secrets",
        "create",
        name,
        "--replication-policy=automatic",
        "--data-file=-",
        ...projectArgs(),
        "--quiet",
      ],
      { input: value },
    );
    console.log(`Created Google Secret Manager secret ${name}`);
    return;
  }

  runGcloud(["secrets", "versions", "add", name, "--data-file=-", ...projectArgs(), "--quiet"], {
    input: value,
  });
  console.log(`Added new Google Secret Manager version for ${name}`);
}

function pullSecret(name) {
  return runGcloud([
    "secrets",
    "versions",
    "access",
    "latest",
    "--secret",
    name,
    ...projectArgs(),
    "--quiet",
  ]);
}

function updateDotenv(values, filePath = ".env") {
  const absolutePath = resolve(filePath);
  const existing = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map(line => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !(match[1] in values)) return line;
    seen.add(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }

  writeFileSync(absolutePath, `${next.filter((line, index) => line || index < next.length - 1).join("\n")}\n`);
}

function ensureGcloudInstalled() {
  try {
    execFileSync("gcloud", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("gcloud CLI is required. Install and authenticate with Google Cloud first.");
  }
}

function push() {
  ensureGcloudInstalled();
  for (const name of SECRET_NAMES) {
    const value = process.env[name];
    if (!value) {
      if (["NEON_API_KEY", "NEON_ORG_ID", "NEON_PROJECT_ID"].includes(name)) {
        throw new Error(`${name} is required in the environment or .env`);
      }
      console.log(`Skipping optional ${name}; no local value set`);
      continue;
    }
    pushSecret(name, value);
  }
}

function pull() {
  ensureGcloudInstalled();
  const values = {};
  for (const name of SECRET_NAMES) {
    if (!secretExists(name)) {
      if (["NEON_API_KEY", "NEON_ORG_ID", "NEON_PROJECT_ID"].includes(name)) {
        throw new Error(`Required Google Secret Manager secret ${name} does not exist`);
      }
      continue;
    }
    values[name] = pullSecret(name);
  }
  updateDotenv(values);
  console.log(`Updated .env with ${Object.keys(values).length} Neon secret(s)`);
}

const command = process.argv[2];
if (command === "push") {
  push();
} else if (command === "pull") {
  pull();
} else {
  console.error(`Usage:
  node scripts/neon-secrets.mjs push
  node scripts/neon-secrets.mjs pull
`);
  process.exit(1);
}
