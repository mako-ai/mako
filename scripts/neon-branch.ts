#!/usr/bin/env tsx
/**
 * Neon Postgres branching helper for Mako local dev, PR previews, CI integration,
 * and production secret sync. Adapted from RealAdvisor's `crm-chat-api/scripts/neon-branch.ts`.
 *
 * Prerequisites:
 *   - `neonctl` installed (`npx neonctl` or global) and authenticated (`neonctl auth`
 *     or `NEON_API_KEY` set in env).
 *   - `NEON_PROJECT_ID` set in `.env` or environment.
 *
 * Usage:
 *   tsx scripts/neon-branch.ts create-dev [branch-name]
 *   tsx scripts/neon-branch.ts reset-dev [branch-name]
 *   tsx scripts/neon-branch.ts resolve-preview <pr-number-or-slug>
 *   tsx scripts/neon-branch.ts delete-preview <pr-number-or-slug>
 *   tsx scripts/neon-branch.ts resolve-integration [branch-name]
 *   tsx scripts/neon-branch.ts list
 *   tsx scripts/neon-branch.ts sync-prod-secret
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";

const ENV_FILE = ".env";
const ENV_TEMPLATE = ".env.example";
const DB_NAME = process.env.NEON_DB_NAME || "neondb";
const ROLE_NAME = process.env.NEON_ROLE_NAME || "neondb_owner";
const PARENT_BRANCH_DEFAULT = process.env.NEON_PARENT_BRANCH || "test";
const GCP_PROJECT = process.env.GCP_PROJECT || "mako-ai-prod";
const PROD_POOLED_SECRET = "POSTGRES_URL";
const PROD_DIRECT_SECRET = "POSTGRES_DIRECT_URL";

/**
 * Shared/protected Neon branch names that `create-dev`, `reset-dev`, and
 * `resolve-integration` must NEVER reset, delete, or write into local `.env`.
 */
export const PROTECTED_BRANCH_NAMES: ReadonlySet<string> = new Set([
  "main",
  "master",
  "prod",
  "production",
  "staging",
  "test",
  "integration",
  PARENT_BRANCH_DEFAULT.toLowerCase(),
]);

const DEV_BRANCH_NAME_RE = /^dev-[a-z0-9][a-z0-9-]*$/;

type Command =
  | "create-dev"
  | "reset-dev"
  | "resolve-preview"
  | "delete-preview"
  | "resolve-integration"
  | "list"
  | "sync-prod-secret";

interface NeonBranch {
  id: string;
  name: string;
  default?: boolean;
}

const VALID_COMMANDS = new Set<Command>([
  "create-dev",
  "reset-dev",
  "resolve-preview",
  "delete-preview",
  "resolve-integration",
  "list",
  "sync-prod-secret",
]);

function run(cmd: string, args: string[], silent = false): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: silent ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
  }).trim();
}

function neonctl(args: string[], silent = true): string {
  return run("neonctl", args, silent);
}

export function sanitizeBranchSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Reject shared/protected branch names and require a `dev-` prefix for
 * `create-dev` and `reset-dev` so operators can never wipe `staging` or point
 * local `.env` at production (`main`).
 */
export function assertSafeDevBranchName(
  branch: string,
  command: "create-dev" | "reset-dev",
  defaultBranchName?: string,
): void {
  const lower = branch.toLowerCase();
  if (!lower) {
    throw new Error(`${command}: branch name cannot be empty.`);
  }
  if (
    PROTECTED_BRANCH_NAMES.has(lower) ||
    (defaultBranchName && lower === defaultBranchName.toLowerCase())
  ) {
    throw new Error(
      `${command}: refusing protected/shared branch "${branch}". ` +
        `Developer commands require a "dev-" prefix (e.g. dev-alice).`,
    );
  }
  if (!DEV_BRANCH_NAME_RE.test(lower)) {
    throw new Error(
      `${command}: branch name "${branch}" must start with "dev-" (e.g. dev-alice) ` +
        `to prevent modifying shared or protected branches.`,
    );
  }
}

export function assertNotProtectedBranch(
  branch: string,
  command: string,
  defaultBranchName?: string,
): void {
  const lower = branch.toLowerCase();
  if (
    !lower ||
    PROTECTED_BRANCH_NAMES.has(lower) ||
    (defaultBranchName && lower === defaultBranchName.toLowerCase())
  ) {
    throw new Error(
      `${command}: refusing protected/shared branch "${branch}".`,
    );
  }
}

export function isSensitiveOutputKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("url") ||
    lower.includes("password") ||
    lower.includes("secret") ||
    lower.includes("token")
  );
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_./:@%+-?=&#]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function readEnvFile(): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(ENV_FILE)) return values;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values.set(match[1], unquote(match[2]));
  }
  return values;
}

function upsertEnvFile(updates: Record<string, string>): void {
  if (!existsSync(ENV_FILE) && existsSync(ENV_TEMPLATE)) {
    copyFileSync(ENV_TEMPLATE, ENV_FILE);
    console.info(`Created ${ENV_FILE} from ${ENV_TEMPLATE}`);
  }
  const existing = existsSync(ENV_FILE)
    ? readFileSync(ENV_FILE, "utf8").split("\n")
    : [];
  const seen = new Set<string>();
  const next = existing.map(line => {
    const match = line.match(/^(\s*)([A-Z0-9_]+)(\s*=\s*)(.*)$/);
    if (!match) return line;
    const [, prefix, key, sep] = match;
    if (!(key in updates)) return line;
    seen.add(key);
    return `${prefix}${key}${sep}${quoteEnv(updates[key])}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      next.push(`${key}=${quoteEnv(value)}`);
    }
  }
  writeFileSync(ENV_FILE, `${next.join("\n").replace(/\n*$/, "")}\n`);
}

function resolveProjectId(): string {
  const envId =
    process.env.NEON_PROJECT_ID || readEnvFile().get("NEON_PROJECT_ID");
  if (!envId) {
    throw new Error(
      "NEON_PROJECT_ID is not set in environment or .env. Set NEON_PROJECT_ID first.",
    );
  }
  return envId;
}

function listBranches(projectId: string): NeonBranch[] {
  const out = neonctl([
    "branches",
    "list",
    "--project-id",
    projectId,
    "--output",
    "json",
  ]);
  const parsed = JSON.parse(out) as NeonBranch[] | { branches: NeonBranch[] };
  return Array.isArray(parsed) ? parsed : (parsed.branches ?? []);
}

function findBranch(projectId: string, name: string): NeonBranch | undefined {
  return listBranches(projectId).find(b => b.name === name);
}

function resolveParentBranch(projectId: string): string {
  const branches = listBranches(projectId);
  const preferred = branches.find(b => b.name === PARENT_BRANCH_DEFAULT);
  if (preferred) return preferred.name;
  const fallback = branches.find(b => b.default) ?? branches[0];
  if (!fallback) {
    throw new Error(`No branches found in Neon project ${projectId}`);
  }
  return fallback.name;
}

function ensureBranch(
  projectId: string,
  name: string,
  parent?: string,
): NeonBranch {
  const existing = findBranch(projectId, name);
  if (existing) {
    console.info(`Using existing Neon branch: ${name} (${existing.id})`);
    return existing;
  }
  const parentName = parent ?? resolveParentBranch(projectId);
  console.info(`Creating Neon branch ${name} from ${parentName}...`);
  const out = neonctl([
    "branches",
    "create",
    "--project-id",
    projectId,
    "--name",
    name,
    "--parent",
    parentName,
    "--output",
    "json",
  ]);
  const parsed = JSON.parse(out) as { branch?: NeonBranch } & NeonBranch;
  return parsed.branch ?? parsed;
}

function getConnectionString(
  projectId: string,
  branchName: string,
  pooled: boolean,
): string {
  const args = [
    "connection-string",
    branchName,
    "--project-id",
    projectId,
    "--database-name",
    DB_NAME,
    "--role-name",
    ROLE_NAME,
  ];
  if (pooled) args.push("--pooled");
  return neonctl(args);
}

export function emitOutput(key: string, value: string): void {
  if (process.env.GITHUB_OUTPUT) {
    if (isSensitiveOutputKey(key)) {
      console.info(`::add-mask::${value}`);
    }
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  } else {
    console.info(`${key}=${value}`);
  }
}

function defaultDevBranchName(): string {
  const user = sanitizeBranchSlug(
    process.env.MAKO_DEV_BRANCH || userInfo().username || "local",
  );
  return `dev-${user}`;
}

function upsertGcpSecret(secretName: string, value: string): void {
  let exists = true;
  try {
    execFileSync(
      "gcloud",
      [
        "secrets",
        "describe",
        secretName,
        `--project=${GCP_PROJECT}`,
        "--quiet",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    exists = false;
  }

  if (!exists) {
    execFileSync(
      "gcloud",
      [
        "secrets",
        "create",
        secretName,
        `--project=${GCP_PROJECT}`,
        "--replication-policy=automatic",
        "--quiet",
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  }

  execFileSync(
    "gcloud",
    [
      "secrets",
      "versions",
      "add",
      secretName,
      `--project=${GCP_PROJECT}`,
      "--data-file=-",
      "--quiet",
    ],
    { input: value, stdio: ["pipe", "inherit", "inherit"] },
  );
}

function main(): void {
  const command = process.argv[2] as Command | undefined;
  const arg = process.argv[3];

  if (!command || !VALID_COMMANDS.has(command)) {
    console.error(
      [
        "Usage:",
        "  tsx scripts/neon-branch.ts create-dev [branch-name]",
        "  tsx scripts/neon-branch.ts reset-dev [branch-name]",
        "  tsx scripts/neon-branch.ts resolve-preview <pr-number-or-slug>",
        "  tsx scripts/neon-branch.ts delete-preview <pr-number-or-slug>",
        "  tsx scripts/neon-branch.ts resolve-integration [branch-name]",
        "  tsx scripts/neon-branch.ts list",
        "  tsx scripts/neon-branch.ts sync-prod-secret",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const projectId = resolveProjectId();

  switch (command) {
    case "list": {
      const branches = listBranches(projectId);
      for (const b of branches) {
        console.info(`${b.name}\t${b.id}${b.default ? "\t(default)" : ""}`);
      }
      break;
    }

    case "create-dev": {
      const branch = arg ? sanitizeBranchSlug(arg) : defaultDevBranchName();
      assertSafeDevBranchName(branch, "create-dev");
      const existing = findBranch(projectId, branch);
      if (existing?.default) {
        throw new Error(
          `create-dev: refusing default Neon branch "${branch}".`,
        );
      }
      ensureBranch(projectId, branch);
      const pooled = getConnectionString(projectId, branch, true);
      const direct = getConnectionString(projectId, branch, false);
      upsertEnvFile({
        POSTGRES_URL: pooled,
        POSTGRES_DIRECT_URL: direct,
      });
      console.info(
        `Updated ${ENV_FILE} with pooled POSTGRES_URL and direct POSTGRES_DIRECT_URL for branch ${branch}.`,
      );
      break;
    }

    case "reset-dev": {
      const branch = arg ? sanitizeBranchSlug(arg) : defaultDevBranchName();
      assertSafeDevBranchName(branch, "reset-dev");
      const existing = findBranch(projectId, branch);
      if (existing?.default) {
        throw new Error(`reset-dev: refusing default Neon branch "${branch}".`);
      }
      if (existing) {
        console.info(`Resetting Neon branch ${branch} to its parent branch...`);
        neonctl(
          ["branches", "reset", branch, "--project-id", projectId, "--parent"],
          false,
        );
      } else {
        const parent = resolveParentBranch(projectId);
        ensureBranch(projectId, branch, parent);
      }
      const pooled = getConnectionString(projectId, branch, true);
      const direct = getConnectionString(projectId, branch, false);
      upsertEnvFile({
        POSTGRES_URL: pooled,
        POSTGRES_DIRECT_URL: direct,
      });
      console.info(`Branch ${branch} reset and ${ENV_FILE} updated.`);
      break;
    }

    case "resolve-preview": {
      if (!arg) {
        throw new Error("resolve-preview requires <pr-number-or-slug>");
      }
      const slug = sanitizeBranchSlug(arg);
      const branch = slug.startsWith("preview-") ? slug : `preview-pr-${slug}`;
      ensureBranch(projectId, branch);
      emitOutput("branch", branch);
      emitOutput("postgres_url", getConnectionString(projectId, branch, true));
      emitOutput(
        "postgres_direct_url",
        getConnectionString(projectId, branch, false),
      );
      break;
    }

    case "delete-preview": {
      if (!arg) {
        throw new Error("delete-preview requires <pr-number-or-slug>");
      }
      const slug = sanitizeBranchSlug(arg);
      const branch = slug.startsWith("preview-") ? slug : `preview-pr-${slug}`;
      const existing = findBranch(projectId, branch);
      if (!existing) {
        console.info(`Neon branch ${branch} does not exist (already deleted).`);
        return;
      }
      if (existing.default) {
        throw new Error(
          `delete-preview: refusing default Neon branch "${branch}".`,
        );
      }
      neonctl(["branches", "delete", branch, "--project-id", projectId], false);
      console.info(`Deleted Neon preview branch ${branch}.`);
      break;
    }

    case "resolve-integration": {
      const branch = arg
        ? sanitizeBranchSlug(arg)
        : `ci-integration-${Date.now().toString(36)}`;
      assertNotProtectedBranch(branch, "resolve-integration");
      const existing = findBranch(projectId, branch);
      if (existing?.default) {
        throw new Error(
          `resolve-integration: refusing default Neon branch "${branch}".`,
        );
      }
      ensureBranch(projectId, branch);
      emitOutput("branch", branch);
      emitOutput("postgres_url", getConnectionString(projectId, branch, true));
      emitOutput(
        "postgres_direct_url",
        getConnectionString(projectId, branch, false),
      );
      break;
    }

    case "sync-prod-secret": {
      const branches = listBranches(projectId);
      const prod =
        branches.find(b => b.default) ??
        branches.find(b => b.name === "main" || b.name === "production");
      if (!prod) {
        throw new Error(
          `Could not identify production default branch in project ${projectId}`,
        );
      }
      const pooled = getConnectionString(projectId, prod.name, true);
      const direct = getConnectionString(projectId, prod.name, false);
      upsertGcpSecret(PROD_POOLED_SECRET, pooled);
      upsertGcpSecret(PROD_DIRECT_SECRET, direct);
      console.info(
        `Synced ${PROD_POOLED_SECRET} (pooled) and ${PROD_DIRECT_SECRET} (direct) in GCP project ${GCP_PROJECT} from Neon branch ${prod.name}.`,
      );
      emitOutput("branch", prod.name);
      break;
    }
  }
}

const isDirectExecution = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    console.error(
      "[neon-branch] Error:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}
