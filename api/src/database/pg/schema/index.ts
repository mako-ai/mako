/**
 * Platform Postgres Drizzle schema barrel.
 *
 * Phase 0 exports the migration control-plane tables.
 * Phases 1–3 add domain schema modules here (auth, workspaces, apps, consoles, usage, chat).
 */
export * from "./control-plane";
export * from "./auth";
export * from "./workspaces";
export * from "./connections";
export * from "./consoles-charts";
export * from "./apps-metadata";
export * from "./usage-stats";
