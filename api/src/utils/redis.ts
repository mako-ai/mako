import type { RedisOptions } from "ioredis";

/**
 * Options every ioredis client shares.
 *
 * ioredis 6 negotiates RESP3 by default, which needs Redis >= 6 and fails the
 * connection (no fallback) on older servers. Stay on RESP2 — what ioredis 5
 * spoke — until the production Memorystore version is confirmed, then drop
 * this.
 */
export const BASE_REDIS_OPTIONS = { protocol: 2 } satisfies RedisOptions;
