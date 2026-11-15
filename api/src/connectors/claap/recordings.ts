/**
 * Claap `recordings`: list pages, each recording re-read from the detail
 * endpoint (list items carry no AI output), with the workspace's daily
 * quota checkpointed mid-page.
 */
import axios from "axios";
import type { FetchState, ResumableFetchOptions } from "../base/BaseConnector";
import { DAY_MS } from "../base/incremental";
import { loggers } from "../../logging";
import {
  extractClaapResult,
  formatClaapApiError,
  readDailyRemaining,
  type ClaapContext,
} from "./client";

const logger = loggers.connector("claap");

const MAX_PAGE_LIMIT = 100;

// Claap enforces a per-workspace daily quota shared by every key. Stop before
// it runs dry so other integrations of the workspace keep working; the run
// resumes from its checkpoint once the rolling window has refilled.
export const CLAAP_DAILY_QUOTA_RESERVE = 500;

// List items carry no AI output (aiFields, keyTakeaways, outlines,
// actionItems), companies or analytics, so every listed recording is re-read
// from `GET /v1/recordings/{id}`. One detail call per recording: pages stay
// small so each page is one batch of roughly this many calls.
const RECORDINGS_PAGE_LIMIT = 50;
// Claap allows 3 requests per second per workspace.
const DETAIL_MIN_INTERVAL_MS = 350;
// Every poll re-reads each recording in the window, one call per recording,
// so the window is capped well below the daily quota.
const RECORDINGS_LOOKBACK_MAX_DAYS = 7;

export type ClaapListRecordingsResult = {
  recordings: Record<string, unknown>[];
  pagination: {
    nextCursor?: string;
    totalCount?: number;
  };
  dailyRemaining?: number;
};

function parseListRecordingsResponse(
  data: unknown,
  headers?: unknown,
): ClaapListRecordingsResult {
  const result = (data as { result?: ClaapListRecordingsResult })?.result;
  return {
    recordings: Array.isArray(result?.recordings) ? result.recordings : [],
    pagination: result?.pagination ?? {},
    dailyRemaining: readDailyRemaining(headers),
  };
}

/** One page of `GET /v1/recordings`, oldest first. */
export async function fetchClaapRecordingsPage(
  ctx: ClaapContext,
  options: {
    cursor?: string;
    since?: Date;
    limit?: number;
    includeAiFields?: boolean;
  },
): Promise<ClaapListRecordingsResult> {
  const api = ctx.api();
  const params: Record<string, string | number | boolean> = {
    limit: Math.min(options.limit ?? ctx.batchSize(), MAX_PAGE_LIMIT),
    sort: "created_asc",
  };
  if (options.includeAiFields ?? true) {
    // Opt into Claap's new AI output structure (`aiFields`). Without this the
    // API returns the legacy `insightTemplates`, which stops being populated
    // as of 2026-06-26.
    params.returnAiFields = true;
  }

  if (options.cursor) {
    params.cursor = options.cursor;
  }
  if (options.since) {
    params.createdAfter = options.since.toISOString();
  }

  const response = await ctx.execute(() =>
    api.get("/v1/recordings", { params }),
  );

  return parseListRecordingsResponse(response.data, response.headers);
}

function recordingsLookbackMs(ctx: ClaapContext): number {
  const days = Number(ctx.recordingsLookbackDays());
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.min(days, RECORDINGS_LOOKBACK_MAX_DAYS) * DAY_MS;
}

// A chunk where every detail read was skipped is treated as a failure, not
// an empty success: it is what an API shape change or a wrong endpoint looks
// like, and a green run would hide it.
function assertSomethingEmitted(detailCalls: number, emitted: number): void {
  if (detailCalls > 0 && emitted === 0) {
    throw new Error(
      `None of the ${detailCalls} Claap recording(s) read in this chunk could be written (all deleted or without aiFields)`,
    );
  }
}

async function fetchRecordingDetail(
  ctx: ClaapContext,
  recordingId: string,
): Promise<{
  recording?: Record<string, unknown>;
  notFound?: boolean;
  missingAiFields?: boolean;
  error?: string;
  dailyRemaining?: number;
}> {
  const api = ctx.api();
  try {
    const response = await ctx.execute(() =>
      api.get(`/v1/recordings/${encodeURIComponent(recordingId)}`, {
        params: { returnAiFields: true },
      }),
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
    // A Ready recording must carry `aiFields` (an empty array is fine):
    // without the key the MERGE would null the stored AI output. Other
    // states (Empty, Uploaded, Failed) have no AI output to lose.
    if (recording.state === "Ready" && !Array.isArray(recording.aiFields)) {
      return { missingAiFields: true, dailyRemaining };
    }
    return { recording, dailyRemaining };
  } catch (error) {
    return {
      notFound: axios.isAxiosError(error) && error.response?.status === 404,
      error: formatClaapApiError(error).slice(0, 500),
      dailyRemaining: axios.isAxiosError(error)
        ? readDailyRemaining(error.response?.headers)
        : undefined,
    };
  }
}

/**
 * `recordings`: list a page, then re-read every recording on it from the
 * detail endpoint and emit only the detail object. A list item is never
 * written: it lacks the AI output, and the destination MERGE nulls every
 * absent key, so upserting it would blank those columns.
 *
 * Only a 404 (recording deleted) or a Ready recording without `aiFields` is
 * skipped. Any other detail failure throws after emitting the rows read so
 * far: the poll anchor is MAX(_syncedAt), so a skipped recording would never
 * be listed again. A chunk that read details but emitted nothing throws too.
 *
 * Detail calls spend the workspace's daily quota one per recording, so the
 * chunk checkpoints mid-page (`cursor` of the page plus `pageOffset`) when
 * the reserve is reached, and resumes there. The checkpoint carries
 * `createdAfter`: a resumed chunk gets no `since`, and listing without it
 * would restart from the oldest recording.
 */
export async function fetchClaapRecordingsChunk(
  ctx: ClaapContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  const { onBatch, onProgress, onLog, since, state } = options;
  const maxIterations = options.maxIterations ?? 10;
  const savedCreatedAfter = state?.metadata?.createdAfter;
  const createdAfter =
    typeof savedCreatedAfter === "string"
      ? new Date(savedCreatedAfter)
      : since
        ? new Date(since.getTime() - recordingsLookbackMs(ctx))
        : undefined;
  const createdAfterIso = createdAfter?.toISOString() ?? null;
  const detailDelay = Math.max(
    options.rateLimitDelay ?? ctx.rateLimitDelay(),
    DETAIL_MIN_INTERVAL_MS,
  );

  let cursor = (state?.metadata?.cursor as string | undefined) ?? undefined;
  let pageOffset = (state?.metadata?.pageOffset as number | undefined) ?? 0;
  let totalCount = state?.metadata?.totalCount as number | undefined;
  let recordingsSeen =
    (state?.metadata?.recordingsSeen as number | undefined) ?? 0;
  let recordCount = state?.totalProcessed ?? 0;
  let iterations = 0;
  let detailCalls = 0;
  let emittedInChunk = 0;

  while (iterations < maxIterations) {
    const pageCursor = cursor;
    const page = await fetchClaapRecordingsPage(ctx, {
      cursor: pageCursor,
      since: createdAfter,
      limit: Math.min(
        options.batchSize ?? ctx.batchSize(),
        RECORDINGS_PAGE_LIMIT,
      ),
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

      const detail = await fetchRecordingDetail(ctx, recordingId);
      detailCalls++;
      quotaLeft =
        detail.dailyRemaining ??
        (quotaLeft !== undefined ? quotaLeft - 1 : undefined);
      if (detail.recording) {
        rows.push(detail.recording);
      } else if (detail.notFound || detail.missingAiFields) {
        // TODO(claap): a 404 here means the recording was deleted between
        // the list and the detail call. Backfill batches are upsert-only
        // (an id-only tombstone would null every column), so deleted
        // recordings are not propagated yet.
        skipped.push(recordingId);
        logger.warn("Skipping Claap recording", {
          recordingId,
          notFound: detail.notFound === true,
          missingAiFields: detail.missingAiFields === true,
        });
      } else {
        if (rows.length > 0) await onBatch(rows);
        throw new Error(
          `Could not read Claap recording ${recordingId}: ${detail.error ?? "unknown error"}`,
        );
      }
      await ctx.sleep(detailDelay);
    }

    if (rows.length > 0) {
      await onBatch(rows);
      recordCount += rows.length;
      emittedInChunk += rows.length;
    }
    if (skipped.length > 0) {
      onLog?.(
        "warn",
        `Skipped ${skipped.length} Claap recording(s): deleted (404) or Ready without aiFields`,
        { recordingIds: skipped },
      );
    }
    onProgress?.(recordingsSeen, totalCount);

    if (stoppedAt !== undefined) {
      const message = `Claap daily API quota nearly used up (${quotaLeft} calls left, reserve ${CLAAP_DAILY_QUOTA_RESERVE}); stopping recording reads until it refills`;
      onLog?.("warn", message);
      if (detailCalls === 0) throw new Error(message);
      assertSomethingEmitted(detailCalls, emittedInChunk);
      // Save the progress made in this chunk; the next chunk resumes on
      // this page, at the first recording not yet read.
      return {
        totalProcessed: recordCount,
        hasMore: true,
        iterationsInChunk: iterations + 1,
        metadata: {
          cursor: pageCursor ?? null,
          pageOffset: stoppedAt,
          createdAfter: createdAfterIso,
          totalCount,
          recordingsSeen,
        },
      };
    }

    pageOffset = 0;
    cursor = page.pagination.nextCursor;
    iterations++;

    if (!cursor) {
      assertSomethingEmitted(detailCalls, emittedInChunk);
      return {
        totalProcessed: recordCount,
        hasMore: false,
        iterationsInChunk: iterations,
        metadata: {
          cursor: null,
          pageOffset: 0,
          createdAfter: createdAfterIso,
          totalCount,
          recordingsSeen,
        },
      };
    }
  }

  assertSomethingEmitted(detailCalls, emittedInChunk);
  return {
    totalProcessed: recordCount,
    hasMore: true,
    iterationsInChunk: iterations,
    metadata: {
      cursor,
      pageOffset: 0,
      createdAfter: createdAfterIso,
      totalCount,
      recordingsSeen,
    },
  };
}
