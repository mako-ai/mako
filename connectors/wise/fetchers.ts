/**
 * Wise reads, one generator per entity: the in-process fetchers
 * (`api/src/connectors/wise/fetchers.ts`) as SDK `read`s.
 *
 * Every list is per profile, so each read walks `profileIds` in order and
 * resumes from `profileIndex` plus the entity's own page position. The
 * state is the in-process `FetchState.metadata`, key for key, and each
 * yielded batch is one in-process iteration (one request, or one profile
 * for balances), so a chunk of N pages ends where the in-process chunk of
 * N iterations ends.
 */
import { type Params, type WiseClient, sendWithSca } from "./client.ts";
import { parseWiseDate, toStatementRecord, withStringId } from "./records.ts";

const TRANSFER_PAGE_LIMIT = 100;
const RECIPIENT_PAGE_LIMIT = 100;
const ACTIVITY_PAGE_LIMIT = 50;
const STATEMENT_WINDOW_DAYS = 90;
const STATEMENT_OVERLAP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export type WiseProfile = { id: number | string; [key: string]: unknown };
type Row = Record<string, unknown>;
type State = Record<string, unknown>;

export interface ReadBatch {
  records: Row[];
  state: State;
  hasMore: boolean;
}

/** What a read needs. Built per `read` call, as in-process per chunk. */
export interface WiseReadContext {
  api: WiseClient;
  /** `config.profile_id` as stored. */
  configuredProfileId: unknown;
  /** `config.sca_private_key` as stored. */
  scaPrivateKey: unknown;
  /** `__page_size` (the in-process `batchSize` or `sync_batch_size`). */
  pageSize: unknown;
  /** The pause between pages (`__rate_limit_delay_ms`, default 200 ms). */
  pause(): Promise<void>;
  since?: Date;
}

/** The in-process `clampPageSize(requested, sync_batch_size ?? 100, max)`. */
function clampPageSize(requested: unknown, max: number): number {
  const n = Number(requested);
  const size = Number.isFinite(n) && n > 0 ? n : 100;
  return Math.min(Math.max(size, 1), max);
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const rowsOf = (data: unknown): Row[] =>
  Array.isArray(data) ? (data as Row[]) : [];

/** `GET /v2/profiles`, once per read (in-process: once per connector). */
export function profileLister(api: WiseClient, configured: unknown) {
  let cached: WiseProfile[] | null = null;
  const list = async (): Promise<WiseProfile[]> => {
    if (cached) return cached;
    const data = await api.get("/v2/profiles");
    cached = Array.isArray(data) ? (data as WiseProfile[]) : [];
    return cached;
  };
  const resolveIds = async (): Promise<string[]> => {
    if (configured != null && String(configured).trim().length > 0) {
      return [String(configured).trim()];
    }
    return (await list()).map(p => String(p.id)).filter(id => id.length > 0);
  };
  return { list, resolveIds };
}

async function initMulti(
  ctx: WiseReadContext,
  state: State,
  resolveIds: () => Promise<string[]>,
): Promise<{ profileIds: string[]; profileIndex: number }> {
  const existing = state.profileIds;
  if (Array.isArray(existing) && existing.length > 0) {
    return {
      profileIds: existing.map(String),
      profileIndex:
        typeof state.profileIndex === "number" ? state.profileIndex : 0,
    };
  }
  return { profileIds: await resolveIds(), profileIndex: 0 };
}

export async function* readProfiles(
  ctx: WiseReadContext,
): AsyncGenerator<ReadBatch> {
  const lister = profileLister(ctx.api, ctx.configuredProfileId);
  let profiles = await lister.list();
  const configured = ctx.configuredProfileId;
  if (configured != null && String(configured).trim().length > 0) {
    const wanted = String(configured).trim();
    profiles = profiles.filter(profile => String(profile.id) === wanted);
  }
  yield {
    records: profiles.map(profile => withStringId(profile as Row)),
    state: {},
    hasMore: false,
  };
}

export async function* readBalances(
  ctx: WiseReadContext,
  state: State,
): AsyncGenerator<ReadBatch> {
  const lister = profileLister(ctx.api, ctx.configuredProfileId);
  const multi = await initMulti(ctx, state, lister.resolveIds);
  let profileIndex = multi.profileIndex;
  const position = () => ({ profileIds: multi.profileIds, profileIndex });
  if (profileIndex >= multi.profileIds.length) {
    yield { records: [], state: position(), hasMore: false };
    return;
  }
  while (profileIndex < multi.profileIds.length) {
    const profileId = multi.profileIds[profileIndex];
    const data = await ctx.api.get(
      `/v4/profiles/${encodeURIComponent(profileId)}/balances`,
      { types: "STANDARD" },
    );
    const records = rowsOf(data).map(balance =>
      withStringId({ ...balance, profileId: String(profileId) }),
    );
    profileIndex++;
    await ctx.pause();
    yield {
      records,
      state: position(),
      hasMore: profileIndex < multi.profileIds.length,
    };
  }
}

export async function* readTransfers(
  ctx: WiseReadContext,
  state: State,
): AsyncGenerator<ReadBatch> {
  const lister = profileLister(ctx.api, ctx.configuredProfileId);
  const multi = await initMulti(ctx, state, lister.resolveIds);
  let profileIndex = multi.profileIndex;
  let offset = typeof state.offset === "number" ? state.offset : 0;
  const limit = clampPageSize(ctx.pageSize, TRANSFER_PAGE_LIMIT);
  const position = () => ({
    profileIds: multi.profileIds,
    profileIndex,
    offset,
  });
  if (profileIndex >= multi.profileIds.length) {
    yield { records: [], state: position(), hasMore: false };
    return;
  }
  while (profileIndex < multi.profileIds.length) {
    const profileId = multi.profileIds[profileIndex];
    const params: Params = { profile: profileId, limit, offset };
    if (ctx.since) params.createdDateStart = isoDay(ctx.since);
    const page = rowsOf(await ctx.api.get("/v1/transfers", params));
    const records = page.map(transfer =>
      withStringId({
        ...transfer,
        profile_id:
          transfer.business ?? transfer.profile_id ?? Number(profileId),
      }),
    );
    if (page.length < limit) {
      profileIndex++;
      offset = 0;
    } else {
      offset += page.length;
    }
    const hasMore = profileIndex < multi.profileIds.length;
    if (hasMore) await ctx.pause();
    yield { records, state: position(), hasMore };
  }
}

export async function* readRecipients(
  ctx: WiseReadContext,
  state: State,
): AsyncGenerator<ReadBatch> {
  const lister = profileLister(ctx.api, ctx.configuredProfileId);
  const multi = await initMulti(ctx, state, lister.resolveIds);
  let profileIndex = multi.profileIndex;
  let seekPosition =
    typeof state.seekPosition === "number" ||
    typeof state.seekPosition === "string"
      ? state.seekPosition
      : undefined;
  const size = clampPageSize(ctx.pageSize, RECIPIENT_PAGE_LIMIT);
  const position = () => ({
    profileIds: multi.profileIds,
    profileIndex,
    seekPosition: seekPosition ?? null,
  });
  if (profileIndex >= multi.profileIds.length) {
    yield { records: [], state: position(), hasMore: false };
    return;
  }
  while (profileIndex < multi.profileIds.length) {
    const profileId = multi.profileIds[profileIndex];
    const params: Params = { profile: profileId, size };
    if (seekPosition != null) params.seekPosition = seekPosition;
    const body = ((await ctx.api.get("/v2/accounts", params)) ?? {}) as {
      content?: Row[];
      seekPositionForNext?: number | string | null;
    };
    const page = Array.isArray(body.content) ? body.content : [];
    const records = page.map(account => withStringId(account));
    const nextSeek = body.seekPositionForNext;
    // End of profile: an empty page, no next seek, or the same seek echoed.
    // A short page is not the end: Wise caps `size` below the one asked for.
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
      await ctx.pause();
    }
    yield {
      records,
      state: position(),
      hasMore: profileIndex < multi.profileIds.length,
    };
  }
}

export async function* readActivities(
  ctx: WiseReadContext,
  state: State,
): AsyncGenerator<ReadBatch> {
  const lister = profileLister(ctx.api, ctx.configuredProfileId);
  const multi = await initMulti(ctx, state, lister.resolveIds);
  let profileIndex = multi.profileIndex;
  let cursor = typeof state.cursor === "string" ? state.cursor : undefined;
  const size = clampPageSize(ctx.pageSize, ACTIVITY_PAGE_LIMIT);
  const position = () => ({
    profileIds: multi.profileIds,
    profileIndex,
    cursor: cursor ?? null,
  });
  if (profileIndex >= multi.profileIds.length) {
    yield { records: [], state: position(), hasMore: false };
    return;
  }
  while (profileIndex < multi.profileIds.length) {
    const profileId = multi.profileIds[profileIndex];
    // Wise answers `cursor`; the next request sends it as `nextCursor`.
    const params: Params = { size };
    if (cursor) params.nextCursor = cursor;
    if (ctx.since) params.since = ctx.since.toISOString();
    const body = ((await ctx.api.get(
      `/v1/profiles/${encodeURIComponent(profileId)}/activities`,
      params,
    )) ?? {}) as { activities?: Row[]; cursor?: string | null };
    const page = Array.isArray(body.activities) ? body.activities : [];
    const records = page.map(activity =>
      withStringId({ ...activity, profileId: String(profileId) }),
    );
    const nextCursor =
      typeof body.cursor === "string" && body.cursor.length > 0
        ? body.cursor
        : null;
    // End of profile: an empty page, no cursor, or the same cursor echoed.
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
    if (profileIndex < multi.profileIds.length || cursor) await ctx.pause();
    yield {
      records,
      state: position(),
      hasMore: profileIndex < multi.profileIds.length,
    };
  }
}

type StatementBalance = { id: string; currency: string; start: string };

export const SCA_MESSAGES = {
  noChallenge:
    "Wise refused the request with HTTP 403 and no SCA challenge (x-2fa-approval): " +
    "the API token itself may lack access to balance statements (a read-only token, or a user without access to the profile)",
  noKey:
    "Wise requires strong customer authentication for balance statements: add an SCA private key to this connection and register its public key in Wise (Settings → API tokens → Manage public keys)",
};

async function listStatementBalances(
  ctx: WiseReadContext,
  profileId: string,
): Promise<StatementBalance[]> {
  const data = await ctx.api.get(
    `/v4/profiles/${encodeURIComponent(profileId)}/balances`,
    { types: "STANDARD" },
  );
  return rowsOf(data)
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
 * Every balance of every profile, its statement in 90-day windows from the
 * balance's creation (or from `since` less 7 days) to now, one request per
 * window, answering Wise's SCA challenge.
 */
export async function* readBalanceStatements(
  ctx: WiseReadContext,
  state: State,
): AsyncGenerator<ReadBatch> {
  const lister = profileLister(ctx.api, ctx.configuredProfileId);
  const multi = await initMulti(ctx, state, lister.resolveIds);
  let profileIndex = multi.profileIndex;
  let balances = Array.isArray(state.balances)
    ? (state.balances as StatementBalance[])
    : null;
  let balanceIndex =
    typeof state.balanceIndex === "number" ? state.balanceIndex : 0;
  let windowStart =
    typeof state.windowStart === "string" ? state.windowStart : null;
  const now = new Date(Date.now());
  const from = ctx.since
    ? new Date(ctx.since.getTime() - STATEMENT_OVERLAP_DAYS * DAY_MS)
    : null;
  const position = () => ({
    profileIds: multi.profileIds,
    profileIndex,
    balances,
    balanceIndex,
    windowStart,
  });

  while (profileIndex < multi.profileIds.length) {
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
    const end = new Date(
      Math.min(start.getTime() + STATEMENT_WINDOW_DAYS * DAY_MS, now.getTime()),
    );
    const path = `/v1/profiles/${encodeURIComponent(profileId)}/balance-statements/${encodeURIComponent(balance.id)}/statement.json`;
    const params: Params = {
      currency: balance.currency,
      intervalStart: start.toISOString(),
      intervalEnd: end.toISOString(),
      type: "COMPACT",
    };
    const body = ((await sendWithSca(
      ctx.scaPrivateKey,
      headers => ctx.api.get(path, params, headers),
      SCA_MESSAGES,
    )) ?? {}) as { transactions?: Row[] };
    const transactions = Array.isArray(body.transactions)
      ? body.transactions
      : [];
    const records = transactions.map(transaction =>
      toStatementRecord(transaction, balance, String(profileId)),
    );
    if (end >= now) {
      balanceIndex++;
      windowStart = null;
    } else {
      windowStart = end.toISOString();
    }
    await ctx.pause();
    yield {
      records,
      state: position(),
      hasMore: profileIndex < multi.profileIds.length,
    };
  }
  // The walk ended between requests (a profile with no balances left, or
  // only windows past now): the in-process chunk returns here too.
  yield { records: [], state: position(), hasMore: false };
}
