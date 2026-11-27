import { hasPostgresConfig } from "../database/pg/client";

/**
 * `MAKO_TEST_MONGO_FALLBACK=0` turns the fallback off even under vitest, so
 * a suite migrated to PGlite (`test-support/pg-test.ts`) proves that every
 * repository call it makes reaches Postgres: any call made without
 * `setPgTestDb()` throws instead of reading Mongo.
 */
function isLegacyMongoTestEnv(): boolean {
  const flag = process.env.MAKO_TEST_MONGO_FALLBACK;
  if (flag === "0") return false;
  return Boolean(
    process.env.VITEST || process.env.NODE_ENV === "test" || flag === "1",
  );
}

/**
 * Direct Postgres repository resolver (post-Stage 5 `pg_only` cutover).
 *
 * Whenever Postgres is configured (all production, preview, dev, and PGlite
 * test environments), dispatches straight to `pgRepo` with zero dual-run
 * routing, shadow reads, or MongoDB dual-writes.
 *
 * Legacy unit tests running against `MongoMemoryServer` without `POSTGRES_URL`
 * fall back to `mongoTestFallback`. In non-test environments, missing
 * `POSTGRES_URL` fails fast instead of reading stale MongoDB collections.
 */
export function createPgFirstRepoProxy<T extends object>(
  domain: string,
  pgRepo: T,
  mongoTestFallback: T,
): T {
  const resolve = (): T => {
    if (hasPostgresConfig()) {
      return pgRepo;
    }
    if (isLegacyMongoTestEnv()) {
      return mongoTestFallback;
    }
    throw new Error(
      `[${domain}] POSTGRES_URL is required (domain is pg_only; MongoDB dual-run has been removed).`,
    );
  };

  // Empty own-property target lets `vi.spyOn(proxy, "method")` install spies
  // onto the proxy and cleanly `delete` them on `mockRestore()` without
  // mutating `pgRepo` or being shadowed by `mongoTestFallback`.
  const overrides = {} as T;

  return new Proxy(overrides, {
    get(target, prop, receiver) {
      if (Object.prototype.hasOwnProperty.call(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      const impl = resolve();
      const value = Reflect.get(impl, prop, impl);
      return typeof value === "function" ? value.bind(impl) : value;
    },
    getPrototypeOf() {
      return resolve();
    },
    has(target, prop) {
      return prop in target || prop in resolve();
    },
  });
}
