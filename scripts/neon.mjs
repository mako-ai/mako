#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const API_BASE = "https://console.neon.tech/api/v2";
const DEFAULT_DATABASE_NAME = "neondb";
const DEFAULT_ROLE_NAME = "neondb_owner";

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

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalEnv(name, fallback) {
  return process.env[name] || fallback;
}

function neonConfig() {
  return {
    apiKey: requiredEnv("NEON_API_KEY"),
    projectId: requiredEnv("NEON_PROJECT_ID"),
    databaseName: optionalEnv("NEON_DATABASE_NAME", DEFAULT_DATABASE_NAME),
    roleName: optionalEnv("NEON_ROLE_NAME", DEFAULT_ROLE_NAME),
    pooled: optionalEnv("NEON_POOLED", "true") !== "false",
  };
}

async function neonFetch(path, options = {}) {
  const { apiKey } = neonConfig();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Neon API ${response.status} ${response.statusText}: ${body}`);
  }

  if (response.status === 204) return {};
  return response.json();
}

async function listBranches() {
  const { projectId } = neonConfig();
  const data = await neonFetch(`/projects/${projectId}/branches`);
  return data.branches || [];
}

function isDefaultBranch(branch) {
  return branch.default === true || branch.primary === true || branch.is_default === true;
}

async function getDefaultBranch() {
  const branches = await listBranches();
  const branch = branches.find(isDefaultBranch) || branches[0];
  if (!branch) throw new Error("No Neon branches found for project");
  return branch;
}

async function findBranchByName(name) {
  const branches = await listBranches();
  return branches.find(branch => branch.name === name) || null;
}

async function waitForOperations(operations = []) {
  const { projectId } = neonConfig();
  const operationIds = operations.map(operation => operation.id).filter(Boolean);
  if (operationIds.length === 0) return;

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const statuses = await Promise.all(
      operationIds.map(id => neonFetch(`/projects/${projectId}/operations/${id}`)),
    );
    const pending = statuses.filter(({ operation }) =>
      ["running", "scheduling", "pending"].includes(operation?.status),
    );
    const failed = statuses.find(({ operation }) =>
      ["failed", "error"].includes(operation?.status),
    );
    if (failed) {
      throw new Error(`Neon operation failed: ${JSON.stringify(failed.operation)}`);
    }
    if (pending.length === 0) return;
    await new Promise(resolveTimeout => setTimeout(resolveTimeout, 2_000));
  }

  throw new Error("Timed out waiting for Neon operations to finish");
}

async function createBranch(name, { parentId, expiresAt } = {}) {
  const { projectId } = neonConfig();
  const defaultBranch = await getDefaultBranch();
  const data = await neonFetch(`/projects/${projectId}/branches`, {
    method: "POST",
    body: JSON.stringify({
      branch: {
        name,
        parent_id: parentId || defaultBranch.id,
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      },
      endpoints: [{ type: "read_write" }],
    }),
  });
  await waitForOperations(data.operations);
  return data.branch;
}

async function ensureBranch(name, options = {}) {
  const existing = await findBranchByName(name);
  if (existing) return { branch: existing, created: false };
  const branch = await createBranch(name, options);
  return { branch, created: true };
}

async function deleteBranchByName(name) {
  const { projectId } = neonConfig();
  const branch = await findBranchByName(name);
  if (!branch) return false;
  if (isDefaultBranch(branch)) {
    throw new Error(`Refusing to delete default Neon branch ${name}`);
  }
  const data = await neonFetch(`/projects/${projectId}/branches/${branch.id}`, {
    method: "DELETE",
  });
  await waitForOperations(data.operations);
  return true;
}

async function restoreBranchFromDefault(branchId) {
  const { projectId } = neonConfig();
  const defaultBranch = await getDefaultBranch();
  if (branchId === defaultBranch.id) {
    throw new Error("Refusing to reset the default Neon branch");
  }
  const data = await neonFetch(`/projects/${projectId}/branches/${branchId}/restore`, {
    method: "POST",
    body: JSON.stringify({ source_branch_id: defaultBranch.id }),
  });
  await waitForOperations(data.operations);
}

async function getConnectionUri(branchId) {
  const { projectId, databaseName, roleName, pooled } = neonConfig();
  const params = new URLSearchParams({
    branch_id: branchId,
    database_name: databaseName,
    role_name: roleName,
    pooled: String(pooled),
  });
  const data = await neonFetch(`/projects/${projectId}/connection_uri?${params}`);
  return data.uri || data.connection_uri;
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function whoami() {
  try {
    return execFileSync("whoami", [], { encoding: "utf8" }).trim();
  } catch {
    return "developer";
  }
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/@.*/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function localBranchName() {
  return (
    process.env.NEON_BRANCH_NAME ||
    `local-${slug(gitValue(["config", "user.email"]) || gitValue(["config", "user.name"]) || whoami())}`
  );
}

function prBranchName() {
  const prNumber = requiredEnv("PR_NUMBER");
  return `pr-${prNumber}`;
}

function expiresInDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function maskUri(uri) {
  return uri.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
}

function writeGithubOutput(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  writeFileSync(outputPath, `${lines.join("\n")}\n`, { flag: "a" });
}

function writeLocalEnv(values) {
  const file = process.env.NEON_LOCAL_ENV_FILE || ".env.neon.local";
  const lines = [
    "# Generated by pnpm neon:local. Do not commit.",
    `POSTGRES_URL=${values.postgresUrl}`,
    `NEON_BRANCH_ID=${values.branchId}`,
    `NEON_BRANCH_NAME=${values.branchName}`,
  ];
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

async function outputBranch({ branch, branchName, created, writeEnvFile = false }) {
  const postgresUrl = await getConnectionUri(branch.id);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${postgresUrl}`);
  }
  writeGithubOutput({
    branch_id: branch.id,
    branch_name: branchName,
    postgres_url: postgresUrl,
  });

  const envFile = writeEnvFile
    ? writeLocalEnv({ postgresUrl, branchId: branch.id, branchName })
    : null;
  console.log(
    JSON.stringify(
      {
        branchName,
        branchId: branch.id,
        created,
        postgresUrl: maskUri(postgresUrl),
        ...(envFile ? { envFile } : {}),
      },
      null,
      2,
    ),
  );
}

async function main() {
  const command = process.argv[2];

  if (command === "create-pr") {
    const branchName = prBranchName();
    const { branch, created } = await ensureBranch(branchName, {
      expiresAt: expiresInDays(Number(process.env.NEON_PR_EXPIRES_DAYS || 30)),
    });
    await outputBranch({ branch, branchName, created });
    return;
  }

  if (command === "delete-pr") {
    const deleted = await deleteBranchByName(prBranchName());
    console.log(JSON.stringify({ deleted }, null, 2));
    return;
  }

  if (command === "local") {
    const branchName = localBranchName();
    const { branch, created } = await ensureBranch(branchName);
    await outputBranch({ branch, branchName, created, writeEnvFile: true });
    return;
  }

  if (command === "reset-local") {
    const branchName = localBranchName();
    const { branch, created } = await ensureBranch(branchName);
    if (!created) await restoreBranchFromDefault(branch.id);
    await outputBranch({ branch, branchName, created, writeEnvFile: true });
    return;
  }

  if (command === "default-connection") {
    const branch = await getDefaultBranch();
    await outputBranch({ branch, branchName: branch.name, created: false });
    return;
  }

  console.error(`Usage:
  node scripts/neon.mjs create-pr
  node scripts/neon.mjs delete-pr
  node scripts/neon.mjs local
  node scripts/neon.mjs reset-local
  node scripts/neon.mjs default-connection
`);
  process.exit(1);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
