/**
 * Postgres persistence layer (Drizzle ORM) for Mako's own metadata.
 *
 * This is the migration target replacing the Mongoose models in
 * `database/schema.ts` and `database/workspace-schema.ts`, introduced as a
 * repository seam so call sites can move off Mongo domain-by-domain.
 */
export {
  getDb,
  getPool,
  getPostgresUrl,
  pingPostgres,
  closePostgres,
  schema,
  type Database,
} from "./client";
export * as ids from "./ids";
export * from "./repositories";
