/**
 * Drizzle schema for Mako's own metadata, on Postgres.
 *
 * Domains migrated from MongoDB (Mongoose) in dependency order:
 *   auth -> workspaces -> connections -> consoles -> chats -> queries
 *
 * Everything is re-exported here so `import { db, schema } from "../db"` and
 * `drizzle(pool, { schema })` see the full table set in one place.
 */
export * from "./auth";
export * from "./workspaces";
export * from "./connections";
export * from "./consoles";
export * from "./chats";
export * from "./queries";
