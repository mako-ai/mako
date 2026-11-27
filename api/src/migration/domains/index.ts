/**
 * Registry bootstrap for all Postgres migration domains (backfill, verifier,
 * Inngest sync-retry handlers, and TTL reaper rules).
 *
 * Imported by migration CLIs (`pg:backfill`, `pg:verify`) and Inngest migration
 * functions (`sync-retry`, `ttl-reaper`).
 */
import { registerAuthMigrationDomain } from "./auth.backfill";
import { registerWorkspacesMigrationDomain } from "./workspaces.backfill";
import { registerConnectionsMigrationDomain } from "./connections.backfill";

let registered = false;

/**
 * Register all migration domains. Safe to call multiple times; pass `force: true`
 * in tests after calling `clear*RegistryForTests()`.
 */
export function registerMigrationDomains(
  options: { force?: boolean } = {},
): void {
  if (registered && !options.force) return;
  registerAuthMigrationDomain();
  registerWorkspacesMigrationDomain();
  registerConnectionsMigrationDomain();
  registered = true;
}

export {
  registerAuthMigrationDomain,
  registerWorkspacesMigrationDomain,
  registerConnectionsMigrationDomain,
};
