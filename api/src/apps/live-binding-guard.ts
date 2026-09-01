/**
 * A circuit breaker in front of live binding queries.
 *
 * `/__data/<name>.parquet` in a dev box asks the API to run a binding's query
 * NOW. On success the box caches the parquet and drops the `.live` marker, so
 * the query runs once per dev session. On FAILURE the marker stays — correctly,
 * a failure must not be cached as data — and nothing else slows the next
 * attempt down. So a binding that cannot succeed is re-asked for as fast as the
 * page re-requests it, and every attempt starts a fresh warehouse query.
 *
 * Measured in prod (2026-09-01, app `post-valuation-conversion`): 41 attempts
 * in 48 minutes across two bindings, each launching a BigQuery job that hit the
 * 300s ceiling and was abandoned — "the query may still be running in
 * BigQuery". Abandoned jobs still scan, and still bill. Meanwhile each request
 * held a Cloud Run slot for up to an hour on a service capped at 15 instances,
 * which is the same starvation that took apps down that morning.
 *
 * So the guard lives HERE, on the server, not in the box: the box's data
 * middleware is generated into its Vite config when the sandbox is staged, so
 * every box already running carries the old client code and will keep asking.
 * Only the server can refuse.
 *
 * Two mechanisms:
 *
 *  - **Single flight.** Concurrent asks for the same binding share one query
 *    instead of starting one each. Per-process: it exists to collapse the
 *    burst a page makes when several tables mount at once, and those arrive on
 *    one instance.
 *  - **Failure backoff.** After a failure the same binding is refused without
 *    touching the warehouse, for a window that doubles per consecutive failure
 *    (1m, 2m, 4m, 8m, capped at 15m) and resets on success. This is shared
 *    through Redis where it is configured, because a storm's requests are
 *    load-balanced across instances and a per-process memory would only catch
 *    the fraction that happened to land twice on the same one.
 *
 * The backoff refuses; it never serves stale data and never invents a result.
 * The caller gets the previous error and how long to wait.
 */
import { Redis } from "ioredis";
import { loggers } from "../logging";

const logger = loggers.api("apps-live-binding");

/** First refusal window; each further consecutive failure doubles it. */
const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

/** Refusals outlive the window they announce, so the count keeps escalating. */
const RECORD_TTL_SECONDS = 60 * 60;

export interface CooldownRecord {
  /** Consecutive failures; drives the window width. */
  failures: number;
  /** Epoch ms until which this binding is refused. */
  until: number;
  /** What went wrong last time, passed back so the user sees a reason. */
  error: string;
}

export class LiveBindingCoolingDown extends Error {
  readonly retryAfterMs: number;
  readonly failures: number;
  constructor(record: CooldownRecord) {
    super(record.error);
    this.name = "LiveBindingCoolingDown";
    this.retryAfterMs = Math.max(0, record.until - Date.now());
    this.failures = record.failures;
  }
}

// --------------------------------------------------------------------------
// Storage: Redis when configured, else in-process with the same expiry.
// Mirrors box-state.service's store — same reasoning, same failure posture.
// --------------------------------------------------------------------------

interface GuardStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

function memoryStore(): GuardStore {
  const map = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        map.delete(key);
        return null;
      }
      return hit.value;
    },
    async set(key, value, ttlSeconds) {
      map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(key) {
      map.delete(key);
    },
  };
}

function redisStore(url: string): GuardStore {
  // Fail fast, exactly as the box-state cache does: this guard protects the
  // warehouse, and a Redis blip must not add seconds to a request that is
  // about to run a query anyway. A read that fails is treated as "no record",
  // which degrades to per-process protection rather than to an outage.
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
  });
  redis.on("error", error =>
    logger.warn("Apps live-binding guard redis error", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return {
    get: key => redis.get(key),
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, "EX", ttlSeconds);
    },
    async del(key) {
      await redis.del(key);
    },
  };
}

let store: GuardStore | null = null;
function getStore(): GuardStore {
  if (!store) {
    store = process.env.REDIS_URL
      ? redisStore(process.env.REDIS_URL)
      : memoryStore();
  }
  return store;
}

/** Test seam: drop the store so the next call rebuilds it (memory mode). */
export function resetLiveBindingGuardForTests(): void {
  store = null;
  inFlight.clear();
}

function keyFor(workspaceId: string, slug: string, name: string): string {
  return `apps:live-binding:cooldown:${workspaceId}:${slug}:${name}`;
}

/** The window a binding is refused for after `failures` consecutive failures. */
export function cooldownMsFor(failures: number): number {
  if (failures <= 0) return 0;
  const doubled = BASE_COOLDOWN_MS * 2 ** (failures - 1);
  return Math.min(doubled, MAX_COOLDOWN_MS);
}

async function readRecord(key: string): Promise<CooldownRecord | null> {
  let raw: string | null = null;
  try {
    raw = await getStore().get(key);
  } catch {
    // A store that cannot answer is not a reason to refuse work, and not a
    // reason to fail: fall through and let the query decide.
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CooldownRecord>;
    if (
      typeof parsed.failures !== "number" ||
      typeof parsed.until !== "number"
    ) {
      return null;
    }
    return {
      failures: parsed.failures,
      until: parsed.until,
      error: typeof parsed.error === "string" ? parsed.error : "Query failed",
    };
  } catch {
    return null;
  }
}

// Single flight is per-process by design: it collapses the burst one page
// makes when several tables mount together, which arrives on one instance.
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run a live binding query under the guard.
 *
 * Throws {@link LiveBindingCoolingDown} — without calling `run` — while the
 * binding is inside its refusal window. Otherwise runs it (sharing an
 * already-running call for the same binding), records the outcome, and
 * returns the result.
 */
export async function withLiveBindingGuard<T>(
  input: { workspaceId: string; slug: string; name: string },
  run: () => Promise<T>,
): Promise<T> {
  const key = keyFor(input.workspaceId, input.slug, input.name);

  const record = await readRecord(key);
  if (record && record.until > Date.now()) {
    logger.warn("Apps live binding refused while cooling down", {
      ...input,
      failures: record.failures,
      retryInMs: record.until - Date.now(),
    });
    throw new LiveBindingCoolingDown(record);
  }

  const running = inFlight.get(key);
  if (running) return running as Promise<T>;

  const started = (async () => {
    try {
      const result = await run();
      // Success clears the history: the next failure starts at one minute,
      // not wherever an old streak had escalated to.
      await getStore()
        .del(key)
        .catch(() => undefined);
      return result;
    } catch (error) {
      const failures = (record?.failures ?? 0) + 1;
      const next: CooldownRecord = {
        failures,
        until: Date.now() + cooldownMsFor(failures),
        error: error instanceof Error ? error.message : String(error),
      };
      await getStore()
        .set(key, JSON.stringify(next), RECORD_TTL_SECONDS)
        .catch(() => undefined);
      logger.warn("Apps live binding failed; cooling down", {
        ...input,
        failures,
        cooldownMs: cooldownMsFor(failures),
        error: next.error,
      });
      throw error;
    }
  })().finally(() => {
    if (inFlight.get(key) === started) inFlight.delete(key);
  });

  inFlight.set(key, started);
  return started;
}
