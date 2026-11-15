/**
 * Wise backfill, one fetcher per entity. Every list is per profile, so each
 * chunk walks `profileIds` in order and resumes from `profileIndex` plus the
 * entity's own page position (offset, seek position, cursor or statement
 * window).
 */
import type { AxiosInstance } from "axios";
import type { FetchState, ResumableFetchOptions } from "../base/BaseConnector";
import { clampPageSize, type RetryExecutor } from "../base/http-client";
import { DAY_MS, isoDay, windowEnd } from "../base/incremental";
import { sendWithSca } from "./client";
import { parseWiseDate, toStatementRecord, withStringId } from "./records";

const TRANSFER_PAGE_LIMIT = 100;
const RECIPIENT_PAGE_LIMIT = 100;
const ACTIVITY_PAGE_LIMIT = 50;
// Balance statements: one request per balance per window. Wise caps a
// statement at 469 days; 90 keeps each response small.
const STATEMENT_WINDOW_DAYS = 90;
// Incremental pulls restart a few days before `since`: transactions that
// settle late land in an earlier window (upserts dedupe them).
const STATEMENT_OVERLAP_DAYS = 7;

export type WiseProfile = {
  id: number | string;
  [key: string]: unknown;
};

type StatementBalance = {
  id: string;
  currency: string;
  start: string;
};

type MultiProfileState = {
  profileIds: string[];
  profileIndex: number;
};

type Row = Record<string, unknown>;

/**
 * What the fetchers read from the connector, always late-bound (so a client
 * or `sleep` stubbed on the instance is the one used).
 */
export interface WiseFetchContext {
  api(): AxiosInstance;
  execute: RetryExecutor;
  sleep(ms: number): Promise<void>;
  /** The connection's sync batch size setting. */
  batchSize(): number;
  /** The connection's rate-limit delay setting. */
  rateLimitDelay(): number;
  /** `config.profile_id` as stored. */
  configuredProfileId(): unknown;
  /** `config.sca_private_key` as stored. */
  scaPrivateKey(): unknown;
  listProfiles(): Promise<WiseProfile[]>;
  resolveProfileIds(): Promise<string[]>;
}

async function initMultiProfileState(
  ctx: WiseFetchContext,
  state: FetchState | undefined,
): Promise<MultiProfileState> {
  const existingIds = state?.metadata?.profileIds;
  if (Array.isArray(existingIds) && existingIds.length > 0) {
    return {
      profileIds: existingIds.map(String),
      profileIndex:
        typeof state?.metadata?.profileIndex === "number"
          ? state.metadata.profileIndex
          : 0,
    };
  }

  const profileIds = await ctx.resolveProfileIds();
  return { profileIds, profileIndex: 0 };
}

const pageSize = (
  ctx: WiseFetchContext,
  requested: number | undefined,
  max: number,
) => clampPageSize(requested, ctx.batchSize(), max);

const pause = (ctx: WiseFetchContext, options: ResumableFetchOptions) =>
  ctx.sleep(options.rateLimitDelay ?? ctx.rateLimitDelay());

const rowsOf = (data: unknown): Row[] =>
  Array.isArray(data) ? (data as Row[]) : [];

export async function fetchWiseProfilesChunk(
  ctx: WiseFetchContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  const { onBatch, onProgress, state } = options;
  if (state && state.totalProcessed > 0) {
    return {
      totalProcessed: state.totalProcessed,
      hasMore: false,
      iterationsInChunk: 0,
    };
  }

  const configured = ctx.configuredProfileId();
  let profiles = await ctx.listProfiles();
  if (configured != null && String(configured).trim().length > 0) {
    const wanted = String(configured).trim();
    profiles = profiles.filter(profile => String(profile.id) === wanted);
  }

  const records = profiles.map(profile => withStringId(profile as Row));

  if (records.length > 0) {
    await onBatch(records);
    onProgress?.(records.length, records.length);
  }

  return {
    totalProcessed: records.length,
    hasMore: false,
    iterationsInChunk: 1,
  };
}

export async function fetchWiseBalancesChunk(
  ctx: WiseFetchContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  const { onBatch, onProgress, state } = options;
  const maxIterations = options.maxIterations ?? 10;
  const multi = await initMultiProfileState(ctx, state);
  let profileIndex = multi.profileIndex;
  let recordCount = state?.totalProcessed ?? 0;
  let iterations = 0;

  const api = ctx.api();

  while (profileIndex < multi.profileIds.length && iterations < maxIterations) {
    const profileId = multi.profileIds[profileIndex];
    const response = await ctx.execute(() =>
      api.get(`/v4/profiles/${encodeURIComponent(profileId)}/balances`, {
        params: { types: "STANDARD" },
      }),
    );

    const records = rowsOf(response.data).map(balance =>
      withStringId({ ...balance, profileId: String(profileId) }),
    );

    if (records.length > 0) {
      await onBatch(records);
      recordCount += records.length;
      onProgress?.(recordCount, undefined);
    }

    profileIndex++;
    iterations++;
    await pause(ctx, options);
  }

  return {
    totalProcessed: recordCount,
    hasMore: profileIndex < multi.profileIds.length,
    iterationsInChunk: iterations,
    metadata: {
      profileIds: multi.profileIds,
      profileIndex,
    },
  };
}

export async function fetchWiseTransfersChunk(
  ctx: WiseFetchContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  const { onBatch, onProgress, since, state, batchSize } = options;
  const maxIterations = options.maxIterations ?? 10;
  const multi = await initMultiProfileState(ctx, state);
  let profileIndex = multi.profileIndex;
  let offset =
    typeof state?.metadata?.offset === "number" ? state.metadata.offset : 0;
  let recordCount = state?.totalProcessed ?? 0;
  let iterations = 0;
  const limit = pageSize(ctx, batchSize, TRANSFER_PAGE_LIMIT);

  const api = ctx.api();

  while (profileIndex < multi.profileIds.length && iterations < maxIterations) {
    const profileId = multi.profileIds[profileIndex];
    const params: Record<string, string | number> = {
      profile: profileId,
      limit,
      offset,
    };
    if (since instanceof Date) {
      params.createdDateStart = isoDay(since);
    }

    const response = await ctx.execute(() =>
      api.get("/v1/transfers", { params }),
    );
    const page = rowsOf(response.data);
    const records = page.map(transfer =>
      withStringId({
        ...transfer,
        profile_id:
          transfer.business ?? transfer.profile_id ?? Number(profileId),
      }),
    );

    if (records.length > 0) {
      await onBatch(records);
      recordCount += records.length;
      onProgress?.(recordCount, undefined);
    }

    iterations++;

    if (page.length < limit) {
      profileIndex++;
      offset = 0;
    } else {
      offset += page.length;
    }

    if (
      profileIndex < multi.profileIds.length ||
      (page.length >= limit && profileIndex < multi.profileIds.length + 1)
    ) {
      await pause(ctx, options);
    }

    if (iterations >= maxIterations) break;
  }

  return {
    totalProcessed: recordCount,
    hasMore: profileIndex < multi.profileIds.length,
    iterationsInChunk: iterations,
    metadata: {
      profileIds: multi.profileIds,
      profileIndex,
      offset,
    },
  };
}

export async function fetchWiseRecipientsChunk(
  ctx: WiseFetchContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  const { onBatch, onProgress, state, batchSize } = options;
  const maxIterations = options.maxIterations ?? 10;
  const multi = await initMultiProfileState(ctx, state);
  let profileIndex = multi.profileIndex;
  let seekPosition =
    typeof state?.metadata?.seekPosition === "number" ||
    typeof state?.metadata?.seekPosition === "string"
      ? state.metadata.seekPosition
      : undefined;
  let recordCount = state?.totalProcessed ?? 0;
  let iterations = 0;
  const size = pageSize(ctx, batchSize, RECIPIENT_PAGE_LIMIT);

  const api = ctx.api();

  while (profileIndex < multi.profileIds.length && iterations < maxIterations) {
    const profileId = multi.profileIds[profileIndex];
    const params: Record<string, string | number> = {
      profile: profileId,
      size,
    };
    if (seekPosition != null) {
      params.seekPosition = seekPosition as string | number;
    }

    const response = await ctx.execute(() =>
      api.get("/v2/accounts", { params }),
    );
    const body = response.data as {
      content?: Row[];
      seekPositionForNext?: number | string | null;
    };
    const page = Array.isArray(body.content) ? body.content : [];
    const records = page.map(account => withStringId(account));

    if (records.length > 0) {
      await onBatch(records);
      recordCount += records.length;
      onProgress?.(recordCount, undefined);
    }

    iterations++;
    const nextSeek = body.seekPositionForNext;

    // End of profile when: empty page, missing next seek, or Wise echoes
    // the same seekPositionForNext (no forward progress).
    // Do NOT treat short pages as terminal — Wise caps `size` (often at 20)
    // below our requested page size while still returning seekPositionForNext.
    if (
      page.length === 0 ||
      nextSeek == null ||
      String(nextSeek) === String(seekPosition)
    ) {
      profileIndex++;
      seekPosition = undefined;
    } else {
      seekPosition = nextSeek;
    }

    if (profileIndex < multi.profileIds.length || seekPosition != null) {
      await pause(ctx, options);
    }

    if (iterations >= maxIterations) break;
  }

  return {
    totalProcessed: recordCount,
    hasMore: profileIndex < multi.profileIds.length,
    iterationsInChunk: iterations,
    metadata: {
      profileIds: multi.profileIds,
      profileIndex,
      seekPosition: seekPosition ?? null,
    },
  };
}

export async function fetchWiseActivitiesChunk(
  ctx: WiseFetchContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  const { onBatch, onProgress, since, state, batchSize } = options;
  const maxIterations = options.maxIterations ?? 10;
  const multi = await initMultiProfileState(ctx, state);
  let profileIndex = multi.profileIndex;
  let cursor =
    typeof state?.metadata?.cursor === "string"
      ? state.metadata.cursor
      : undefined;
  let recordCount = state?.totalProcessed ?? 0;
  let iterations = 0;
  const size = pageSize(ctx, batchSize, ACTIVITY_PAGE_LIMIT);

  const api = ctx.api();

  while (profileIndex < multi.profileIds.length && iterations < maxIterations) {
    const profileId = multi.profileIds[profileIndex];
    // Wise paginates with response `cursor` → next request `nextCursor`
    // (not `cursor`). Sending the wrong param ignores pagination and
    // re-fetches page 1 forever.
    const params: Record<string, string | number> = { size };
    if (cursor) {
      params.nextCursor = cursor;
    }
    // Native server-side filter (ISO 8601). Prefer this over client-side
    // scanning of the newest-first feed.
    if (since instanceof Date) {
      params.since = since.toISOString();
    }

    const response = await ctx.execute(() =>
      api.get(`/v1/profiles/${encodeURIComponent(profileId)}/activities`, {
        params,
      }),
    );
    const body = response.data as {
      activities?: Row[];
      cursor?: string | null;
    };
    const page = Array.isArray(body.activities) ? body.activities : [];

    const records = page.map(activity =>
      withStringId({ ...activity, profileId: String(profileId) }),
    );

    if (records.length > 0) {
      await onBatch(records);
      recordCount += records.length;
      onProgress?.(recordCount, undefined);
    }

    iterations++;
    const nextCursor =
      typeof body.cursor === "string" && body.cursor.length > 0
        ? body.cursor
        : null;

    // End of profile when: empty page, missing next cursor, or Wise echoes
    // the same cursor (no forward progress — otherwise backfill never ends).
    if (
      page.length === 0 ||
      !nextCursor ||
      (cursor != null && nextCursor === cursor)
    ) {
      profileIndex++;
      cursor = undefined;
    } else {
      cursor = nextCursor;
    }

    if (profileIndex < multi.profileIds.length || cursor) {
      await pause(ctx, options);
    }

    if (iterations >= maxIterations) break;
  }

  return {
    totalProcessed: recordCount,
    hasMore: profileIndex < multi.profileIds.length,
    iterationsInChunk: iterations,
    metadata: {
      profileIds: multi.profileIds,
      profileIndex,
      cursor: cursor ?? null,
    },
  };
}

/** GET that answers Wise's strong customer authentication. */
function getWithSca(
  ctx: WiseFetchContext,
  path: string,
  params: Record<string, string | number>,
): Promise<{ data: unknown }> {
  const api = ctx.api();
  return sendWithSca(
    ctx.execute,
    ctx.scaPrivateKey(),
    headers => api.get(path, { params, ...(headers && { headers }) }),
    {
      noChallenge:
        "Wise refused the request with HTTP 403 and no SCA challenge (x-2fa-approval): " +
        "the API token itself may lack access to balance statements (a read-only token, or a user without access to the profile)",
      noKey:
        "Wise requires strong customer authentication for balance statements: add an SCA private key to this connection and register its public key in Wise (Settings → API tokens → Manage public keys)",
    },
  );
}

async function listStatementBalances(
  ctx: WiseFetchContext,
  profileId: string,
): Promise<StatementBalance[]> {
  const api = ctx.api();
  const response = await ctx.execute(() =>
    api.get(`/v4/profiles/${encodeURIComponent(profileId)}/balances`, {
      params: { types: "STANDARD" },
    }),
  );
  return rowsOf(response.data)
    .filter(balance => balance.id != null && balance.currency != null)
    .map(balance => ({
      id: String(balance.id),
      currency: String(balance.currency),
      start: (
        parseWiseDate(balance.creationTime) ?? new Date("2011-01-01T00:00:00Z")
      ).toISOString(),
    }));
}

/**
 * Every balance of every profile (one per currency), its statement in
 * windows of STATEMENT_WINDOW_DAYS from the balance's creation (or from
 * `since`, less an overlap) to now. One request per window.
 */
export async function fetchWiseBalanceStatementsChunk(
  ctx: WiseFetchContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  const { onBatch, onProgress, since, state } = options;
  const maxIterations = options.maxIterations ?? 10;
  const multi = await initMultiProfileState(ctx, state);
  let profileIndex = multi.profileIndex;
  let balances = Array.isArray(state?.metadata?.balances)
    ? (state.metadata.balances as StatementBalance[])
    : null;
  let balanceIndex =
    typeof state?.metadata?.balanceIndex === "number"
      ? state.metadata.balanceIndex
      : 0;
  let windowStart =
    typeof state?.metadata?.windowStart === "string"
      ? state.metadata.windowStart
      : null;
  let recordCount = state?.totalProcessed ?? 0;
  let iterations = 0;
  const now = new Date();
  const from =
    since instanceof Date
      ? new Date(since.getTime() - STATEMENT_OVERLAP_DAYS * DAY_MS)
      : null;

  while (profileIndex < multi.profileIds.length && iterations < maxIterations) {
    const profileId = multi.profileIds[profileIndex];
    if (!balances) {
      balances = await listStatementBalances(ctx, profileId);
      balanceIndex = 0;
      windowStart = null;
    }
    if (balanceIndex >= balances.length) {
      profileIndex++;
      balances = null;
      continue;
    }

    const balance = balances[balanceIndex];
    const created = new Date(balance.start);
    const start = windowStart
      ? new Date(windowStart)
      : from && from > created
        ? from
        : created;
    if (start >= now) {
      balanceIndex++;
      windowStart = null;
      continue;
    }
    const end = windowEnd(start, STATEMENT_WINDOW_DAYS, now);

    const response = await getWithSca(
      ctx,
      `/v1/profiles/${encodeURIComponent(profileId)}/balance-statements/${encodeURIComponent(balance.id)}/statement.json`,
      {
        currency: balance.currency,
        intervalStart: start.toISOString(),
        intervalEnd: end.toISOString(),
        type: "COMPACT",
      },
    );
    const body = (response.data ?? {}) as { transactions?: Row[] };
    const transactions = Array.isArray(body.transactions)
      ? body.transactions
      : [];
    const records = transactions.map(transaction =>
      toStatementRecord(transaction, balance, String(profileId)),
    );

    if (records.length > 0) {
      await onBatch(records);
      recordCount += records.length;
      onProgress?.(recordCount, undefined);
    }

    iterations++;
    if (end >= now) {
      balanceIndex++;
      windowStart = null;
    } else {
      windowStart = end.toISOString();
    }

    await pause(ctx, options);
  }

  return {
    totalProcessed: recordCount,
    hasMore: profileIndex < multi.profileIds.length,
    iterationsInChunk: iterations,
    metadata: {
      profileIds: multi.profileIds,
      profileIndex,
      balances,
      balanceIndex,
      windowStart,
    },
  };
}
