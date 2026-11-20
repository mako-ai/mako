/**
 * Claap `recordings`: list pages, each recording re-read from the detail
 * endpoint (list items carry no AI output), with the workspace's daily
 * quota checkpointed mid-page. A port of
 * `api/src/connectors/claap/recordings.ts`.
 */
import {
  ClaapHttpError,
  extractClaapResult,
  formatClaapError,
  readDailyRemaining,
  type ClaapClient,
} from "./client.ts";

const MAX_PAGE_LIMIT = 100;

/** Stop this far before the workspace's daily quota runs out. */
export const CLAAP_DAILY_QUOTA_RESERVE = 500;
/** One detail call per recording: pages stay at 50. */
const RECORDINGS_PAGE_LIMIT = 50;
/** Claap allows 3 requests per second per workspace. */
export const DETAIL_MIN_INTERVAL_MS = 350;
const RECORDINGS_LOOKBACK_MAX_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClaapReadContext {
  api: ClaapClient;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  /** `__page_size`, else 100. */
  batchSize: number;
  /** `__rate_limit_delay_ms`, else 200. */
  rateLimitDelay: number;
  /** `config.recordings_lookback_days` as stored. */
  recordingsLookbackDays: unknown;
}

export type ClaapListRecordingsResult = {
  recordings: Record<string, unknown>[];
  pagination: { nextCursor?: string; totalCount?: number };
  dailyRemaining?: number;
};

/** One page of `GET /v1/recordings`, oldest first. */
export async function fetchClaapRecordingsPage(
  ctx: ClaapReadContext,
  options: {
    cursor?: string;
    since?: Date;
    limit?: number;
    includeAiFields?: boolean;
  },
): Promise<ClaapListRecordingsResult> {
  const params: Record<string, string | number | boolean> = {
    limit: Math.min(options.limit ?? ctx.batchSize, MAX_PAGE_LIMIT),
    sort: "created_asc",
  };
  if (options.includeAiFields ?? true) params.returnAiFields = true;
  if (options.cursor) params.cursor = options.cursor;
  if (options.since) params.createdAfter = options.since.toISOString();

  const response = await ctx.api.get("/v1/recordings", params);
  const result = (response.data as { result?: ClaapListRecordingsResult })
    ?.result;
  return {
    recordings: Array.isArray(result?.recordings) ? result.recordings : [],
    pagination: result?.pagination ?? {},
    dailyRemaining: readDailyRemaining(response.headers),
  };
}

function lookbackMs(ctx: ClaapReadContext): number {
  const days = Number(ctx.recordingsLookbackDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.min(days, RECORDINGS_LOOKBACK_MAX_DAYS) * DAY_MS;
}

function assertSomethingEmitted(detailCalls: number, emitted: number): void {
  if (detailCalls > 0 && emitted === 0) {
    throw new Error(
      `None of the ${detailCalls} Claap recording(s) read in this chunk could be written (all deleted or without aiFields)`,
    );
  }
}

export interface RecordingDetail {
  recording?: Record<string, unknown>;
  notFound?: boolean;
  missingAiFields?: boolean;
  error?: string;
  dailyRemaining?: number;
}

/** `GET /v1/recordings/{id}?returnAiFields=true`. */
export async function fetchRecordingDetail(
  api: ClaapClient,
  recordingId: string,
): Promise<RecordingDetail> {
  try {
    const response = await api.get(
      `/v1/recordings/${encodeURIComponent(recordingId)}`,
      { returnAiFields: true },
    );
    const dailyRemaining = readDailyRemaining(response.headers);
    const result = extractClaapResult(response.data);
    const candidate =
      result && typeof result === "object" && "recording" in result
        ? (result as { recording: unknown }).recording
        : result;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      (candidate as { id?: unknown }).id !== recordingId
    ) {
      return {
        error: "Claap recording response has no matching recording",
        dailyRemaining,
      };
    }
    const recording = candidate as Record<string, unknown>;
    // A Ready recording without `aiFields` would null the stored AI output.
    if (recording.state === "Ready" && !Array.isArray(recording.aiFields)) {
      return { missingAiFields: true, dailyRemaining };
    }
    return { recording, dailyRemaining };
  } catch (error) {
    return {
      notFound: error instanceof ClaapHttpError && error.status === 404,
      error: formatClaapError(error).slice(0, 500),
      dailyRemaining:
        error instanceof ClaapHttpError
          ? readDailyRemaining(error.headers)
          : undefined,
    };
  }
}

export interface RecordingsState {
  cursor?: string | null;
  pageOffset?: number;
  createdAfter?: string | null;
  totalCount?: number;
  recordingsSeen?: number;
  totalProcessed?: number;
}

/**
 * `recordings`: list a page, re-read every recording on it from the detail
 * endpoint, and emit only the detail objects.
 *
 * Only a 404 or a Ready recording without `aiFields` is skipped. Any other
 * detail failure fails the chunk, which retries from its last state. A
 * chunk that read details but emitted nothing fails too,
 * including one the runner stops at its page limit.
 *
 * Near the daily quota reserve the chunk checkpoints mid-page (the page's
 * cursor plus `pageOffset`) and ends with `hasMore: true`. The checkpoint
 * carries `createdAfter`, so a resumed chunk lists from the same anchor.
 */
export async function* readClaapRecordings(
  ctx: ClaapReadContext,
  state: RecordingsState,
  since: Date | undefined,
) {
  const createdAfter =
    typeof state.createdAfter === "string"
      ? new Date(state.createdAfter)
      : since
        ? new Date(since.getTime() - lookbackMs(ctx))
        : undefined;
  const createdAfterIso = createdAfter?.toISOString() ?? null;
  const detailDelay = Math.max(ctx.rateLimitDelay, DETAIL_MIN_INTERVAL_MS);

  let cursor = typeof state.cursor === "string" ? state.cursor : undefined;
  let pageOffset = typeof state.pageOffset === "number" ? state.pageOffset : 0;
  let totalCount = state.totalCount;
  let recordingsSeen = state.recordingsSeen ?? 0;
  let recordCount = state.totalProcessed ?? 0;
  let detailCalls = 0;
  let emittedInChunk = 0;
  // True until this generator ends on its own: the runner stopping it at
  // its page limit still gets the end-of-chunk check.
  let stoppedByRunner = true;

  try {
    while (true) {
      const pageCursor = cursor;
      const page = await fetchClaapRecordingsPage(ctx, {
        cursor: pageCursor,
        since: createdAfter,
        limit: Math.min(ctx.batchSize, RECORDINGS_PAGE_LIMIT),
      });
      totalCount ??= page.pagination.totalCount;
      let quotaLeft = page.dailyRemaining;

      const rows: Record<string, unknown>[] = [];
      const skipped: string[] = [];
      let stoppedAt: number | undefined;

      for (let index = pageOffset; index < page.recordings.length; index++) {
        if (quotaLeft !== undefined && quotaLeft < CLAAP_DAILY_QUOTA_RESERVE) {
          stoppedAt = index;
          break;
        }
        const listItem = page.recordings[index];
        const recordingId =
          typeof listItem.id === "string" && listItem.id.length > 0
            ? listItem.id
            : undefined;
        recordingsSeen++;
        if (!recordingId) continue;

        const detail = await fetchRecordingDetail(ctx.api, recordingId);
        detailCalls++;
        quotaLeft =
          detail.dailyRemaining ??
          (quotaLeft !== undefined ? quotaLeft - 1 : undefined);
        if (detail.recording) {
          rows.push(detail.recording);
        } else if (detail.notFound || detail.missingAiFields) {
          skipped.push(recordingId);
        } else {
          stoppedByRunner = false;
          throw new Error(
            `Could not read Claap recording ${recordingId}: ${detail.error ?? "unknown error"}`,
          );
        }
        await ctx.sleep(detailDelay);
      }

      recordCount += rows.length;
      emittedInChunk += rows.length;
      if (skipped.length > 0) {
        ctx.log(
          `Skipped ${skipped.length} Claap recording(s): deleted (404) or Ready without aiFields: ${skipped.join(", ")}`,
        );
      }

      if (stoppedAt !== undefined) {
        const message = `Claap daily API quota nearly used up (${quotaLeft} calls left, reserve ${CLAAP_DAILY_QUOTA_RESERVE}); stopping recording reads until it refills`;
        ctx.log(message);
        stoppedByRunner = false;
        if (detailCalls === 0) throw new Error(message);
        assertSomethingEmitted(detailCalls, emittedInChunk);
        yield {
          records: rows,
          state: {
            cursor: pageCursor ?? null,
            pageOffset: stoppedAt,
            createdAfter: createdAfterIso,
            totalCount,
            recordingsSeen,
            totalProcessed: recordCount,
          },
          hasMore: true,
        };
        return;
      }

      pageOffset = 0;
      cursor = page.pagination.nextCursor;

      if (!cursor) {
        stoppedByRunner = false;
        assertSomethingEmitted(detailCalls, emittedInChunk);
        yield {
          records: rows,
          state: {
            cursor: null,
            pageOffset: 0,
            createdAfter: createdAfterIso,
            totalCount,
            recordingsSeen,
            totalProcessed: recordCount,
          },
          hasMore: false,
        };
        return;
      }

      yield {
        records: rows,
        state: {
          cursor,
          pageOffset: 0,
          createdAfter: createdAfterIso,
          totalCount,
          recordingsSeen,
          totalProcessed: recordCount,
        },
        hasMore: true,
      };
    }
  } catch (error) {
    stoppedByRunner = false;
    throw error;
  } finally {
    if (stoppedByRunner) assertSomethingEmitted(detailCalls, emittedInChunk);
  }
}
