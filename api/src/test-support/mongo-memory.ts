/**
 * Test-only: MongoMemoryServer.create() survives a busy machine.
 *
 * 119 test files call `MongoMemoryServer.create()` with no options. It picks a
 * free port, then mongod binds it a moment later. On a laptop running dozens
 * of dev servers another process can take the port in between ("Port 56770
 * already in use"), and under load mongod can miss the 10 s launch timeout.
 * Either one fails the whole file, and with it a pre-push. On 18-19 Nov 2026
 * that blocked 6 pushes in a row.
 *
 * Loaded by every vitest config (setupFiles) and by run-tsx-tests.mjs
 * (--import), this wraps the static `create` once: a 30 s launch timeout, and
 * up to 3 attempts when the failure is a port clash or a slow start. Any other
 * error is thrown at once. Test files keep calling the stock API.
 */
import { MongoMemoryServer } from "mongodb-memory-server";

type CreateOpts = NonNullable<
  ConstructorParameters<typeof MongoMemoryServer>[0]
>;

const RETRYABLE = /already in use|failed to start within|EADDRINUSE/i;
export const MONGO_MEMORY_ATTEMPTS = 3;
export const MONGO_MEMORY_LAUNCH_TIMEOUT_MS = 30_000;

const PATCHED = Symbol.for("mako.test.mongoMemoryRetry");

type Patchable = typeof MongoMemoryServer & { [PATCHED]?: true };

/** Wraps `MongoMemoryServer.create` once; safe to call from several entry points. */
export function patchMongoMemoryServer(
  cls: Patchable = MongoMemoryServer as Patchable,
): void {
  if (cls[PATCHED]) return;
  cls[PATCHED] = true;
  cls.create = async function create(opts: CreateOpts = {}) {
    const withTimeout: CreateOpts = {
      ...opts,
      instance: {
        launchTimeout: MONGO_MEMORY_LAUNCH_TIMEOUT_MS,
        ...opts.instance,
      },
    };
    let last: unknown;
    for (let attempt = 1; attempt <= MONGO_MEMORY_ATTEMPTS; attempt++) {
      const server = new cls(withTimeout);
      try {
        await server.start();
        return server;
      } catch (err) {
        last = err;
        await server
          .stop({ doCleanup: true, force: true })
          .catch(() => undefined);
        if (!RETRYABLE.test(String((err as Error)?.message ?? err))) throw err;
      }
    }
    throw last;
  } as typeof MongoMemoryServer.create;
}

process.env.MAKO_TEST_MONGO_FALLBACK = "1";
patchMongoMemoryServer();
