/**
 * Shared in-process PGlite test factory with Mako's required Postgres extensions
 * (`vector` / `pgvector` and `pg_trgm`) preloaded.
 *
 * Every Postgres / migration test suite MUST use `createTestPglite()` instead of
 * `new PGlite()` directly so Phase 2+ migrations (`CREATE EXTENSION vector`,
 * `CREATE EXTENSION pg_trgm`) apply cleanly across all test files.
 *
 * Test-only module — excluded from production `tsconfig.build.json` because
 * `@electric-sql/pglite` is a devDependency.
 */
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";

export function createTestPglite(options?: PGliteOptions): PGlite {
  return new PGlite({
    ...options,
    extensions: {
      vector,
      pg_trgm,
      ...options?.extensions,
    },
  });
}
