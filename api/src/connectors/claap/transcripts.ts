/**
 * Claap `recording_transcripts`: one row per recording × transcript language,
 * downloaded from the listing's signed link (or the transcript endpoint).
 */
import type { FetchState, ResumableFetchOptions } from "../base/BaseConnector";
import { DAY_MS } from "../base/incremental";
import { loggers } from "../../logging";
import { safeFetch } from "../../services/safe-fetch.service";
import {
  extractClaapResult,
  formatClaapApiError,
  type ClaapContext,
} from "./client";
import {
  CLAAP_DAILY_QUOTA_RESERVE,
  fetchClaapRecordingsPage,
} from "./recordings";

const logger = loggers.connector("claap");

export const CLAAP_TRANSCRIPTS_ENTITY = "recording_transcripts";

// Every recording on a page triggers one download per language, so transcript
// pages are kept small: each page is one batch (and one heartbeat) of roughly
// this many downloads.
const TRANSCRIPT_PAGE_LIMIT = 50;
// A poll re-lists recordings created this long before `since`, so transcripts
// that finish processing (or translations added) after the recording first
// appeared are still picked up, and failed downloads are retried.
const TRANSCRIPT_RECHECK_MS = 2 * DAY_MS;
const TRANSCRIPT_MAX_BYTES = 50_000_000;
const TRANSCRIPT_TIMEOUT_MS = 60_000;

type ClaapTranscriptRef = {
  langIso2?: unknown;
  isTranscript?: unknown;
  isActive?: unknown;
  url?: unknown;
};

type ClaapTranscriptSegment = {
  startedAt: number;
  endedAt: number;
  text: string;
  speaker?: string;
  languageCode?: string;
};

/**
 * Pull the segments out of a transcript document. The signed `url` download
 * and `GET /v1/recordings/{id}/transcript?format=json` may wrap them
 * differently, so accept `{ result: { transcript: { segments } } }`,
 * `{ transcript: { segments } }`, `{ segments }` and a bare array. Per-word
 * timings (`words`) are dropped: they multiply the size for no use downstream.
 */
export function parseClaapTranscriptSegments(
  document: unknown,
): ClaapTranscriptSegment[] | null {
  const unwrapped = extractClaapResult(document);
  const container =
    unwrapped && typeof unwrapped === "object" && "transcript" in unwrapped
      ? (unwrapped as { transcript: unknown }).transcript
      : unwrapped;
  const rawSegments = Array.isArray(container)
    ? container
    : container && typeof container === "object"
      ? (container as { segments?: unknown }).segments
      : undefined;
  if (!Array.isArray(rawSegments)) return null;

  const segments: ClaapTranscriptSegment[] = [];
  for (const raw of rawSegments) {
    if (!raw || typeof raw !== "object") continue;
    const segment = raw as Record<string, unknown>;
    if (typeof segment.text !== "string") continue;
    segments.push({
      startedAt: Number(segment.startedAt) || 0,
      endedAt: Number(segment.endedAt) || 0,
      text: segment.text,
      ...(typeof segment.speaker === "string" && { speaker: segment.speaker }),
      ...(typeof segment.languageCode === "string" && {
        languageCode: segment.languageCode,
      }),
    });
  }
  return segments;
}

function formatTranscriptTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${pad(minutes)}:${pad(secs)}`;
}

/**
 * Plain-text rendering in Claap's own `format=text` layout
 * (`02:17 speaker_1: Hello there!`), one line per segment, so the text needs
 * no second download.
 */
export function renderClaapTranscriptText(
  segments: ClaapTranscriptSegment[],
): string {
  return segments
    .map(segment => {
      const speaker = segment.speaker ? ` ${segment.speaker}:` : "";
      return `${formatTranscriptTimestamp(segment.startedAt)}${speaker} ${segment.text}`;
    })
    .join("\n");
}

/** Download a signed transcript link through the SSRF-guarded fetch. */
export async function downloadClaapSignedUrl(url: string): Promise<string> {
  const response = await safeFetch(url, {
    maxBytes: TRANSCRIPT_MAX_BYTES,
    timeoutMs: TRANSCRIPT_TIMEOUT_MS,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status} downloading transcript`);
  }
  return response.body.toString("utf8");
}

/**
 * The signed link from the listing first (it carries its own token, so the
 * API key is never sent to it); the transcript endpoint when the link is
 * missing, expired or unreadable.
 */
async function downloadTranscriptSegments(
  ctx: ClaapContext,
  recordingId: string,
  langIso2: string,
  url: unknown,
): Promise<ClaapTranscriptSegment[]> {
  if (typeof url === "string" && url.startsWith("https://")) {
    try {
      const body = await ctx.downloadSignedUrl(url);
      const segments = parseClaapTranscriptSegments(JSON.parse(body));
      if (segments) return segments;
      logger.warn("Claap transcript link returned no segments", {
        recordingId,
        langIso2,
      });
    } catch (error) {
      logger.warn("Claap transcript link failed; using the API endpoint", {
        recordingId,
        langIso2,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const api = ctx.api();
  const response = await ctx.execute(() =>
    api.get(`/v1/recordings/${encodeURIComponent(recordingId)}/transcript`, {
      params: { lang: langIso2, format: "json" },
    }),
  );
  const segments = parseClaapTranscriptSegments(response.data);
  if (!segments) {
    throw new Error("Claap transcript response has no segments");
  }
  return segments;
}

/**
 * Every transcript of one recording as rows. A failed download is still a
 * row (fetchStatus `failed`) so the gap is visible.
 */
export async function fetchClaapRecordingTranscripts(
  ctx: ClaapContext,
  recording: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const recordingId =
    typeof recording.id === "string" && recording.id.length > 0
      ? recording.id
      : undefined;
  if (!recordingId || !Array.isArray(recording.transcripts)) return [];

  const recordingCreatedAt =
    typeof recording.createdAt === "string" ? recording.createdAt : null;
  const rows: Record<string, unknown>[] = [];

  for (const ref of recording.transcripts as ClaapTranscriptRef[]) {
    const langIso2 =
      typeof ref?.langIso2 === "string" && ref.langIso2.trim().length > 0
        ? ref.langIso2.trim().toLowerCase()
        : undefined;
    if (!langIso2) continue;

    const base = {
      id: `${recordingId}:${langIso2}`,
      recordingId,
      langIso2,
      isTranscript: ref.isTranscript === true,
      isActive: ref.isActive === true,
      recordingCreatedAt,
    };

    try {
      const segments = await downloadTranscriptSegments(
        ctx,
        recordingId,
        langIso2,
        ref.url,
      );
      const transcriptText = renderClaapTranscriptText(segments);
      rows.push({
        ...base,
        transcriptText,
        segments,
        segmentCount: segments.length,
        charCount: transcriptText.length,
        fetchStatus: segments.length > 0 ? "ok" : "empty",
        fetchError: null,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn("Could not download Claap transcript", {
        recordingId,
        langIso2,
        error: formatClaapApiError(error),
      });
      rows.push({
        ...base,
        transcriptText: null,
        segments: null,
        segmentCount: null,
        charCount: null,
        fetchStatus: "failed",
        fetchError: formatClaapApiError(error).slice(0, 500),
        fetchedAt: new Date().toISOString(),
      });
    }

    await ctx.sleep(ctx.rateLimitDelay());
  }

  return rows;
}

/**
 * `recording_transcripts`: one row per recording × transcript language.
 * Claap's transcript links expire after 24 hours, so each page of recordings
 * is listed and its transcripts are downloaded straight away, in the same
 * chunk. Downloads that fail are still emitted (fetchStatus `failed`) so the
 * gap is visible; the next poll's overlap window retries them.
 */
export async function fetchClaapTranscriptsChunk(
  ctx: ClaapContext,
  options: ResumableFetchOptions,
): Promise<FetchState> {
  const { onBatch, onProgress, onLog, since, state } = options;
  const maxIterations = options.maxIterations ?? 10;
  const createdAfter = since
    ? new Date(since.getTime() - TRANSCRIPT_RECHECK_MS)
    : undefined;

  let cursor = (state?.metadata?.cursor as string | undefined) ?? undefined;
  let totalCount = state?.metadata?.totalCount as number | undefined;
  let recordingsSeen =
    (state?.metadata?.recordingsSeen as number | undefined) ?? 0;
  let recordCount = state?.totalProcessed ?? 0;
  let iterations = 0;

  while (iterations < maxIterations) {
    const page = await fetchClaapRecordingsPage(ctx, {
      cursor,
      since: createdAfter,
      limit: TRANSCRIPT_PAGE_LIMIT,
      includeAiFields: false,
    });
    totalCount ??= page.pagination.totalCount;

    if (
      page.dailyRemaining !== undefined &&
      page.dailyRemaining < CLAAP_DAILY_QUOTA_RESERVE
    ) {
      const message = `Claap daily API quota nearly used up (${page.dailyRemaining} calls left, reserve ${CLAAP_DAILY_QUOTA_RESERVE}); stopping transcript downloads until it refills`;
      onLog?.("warn", message);
      if (iterations > 0) {
        // Save the progress made in this chunk; the next chunk stops here.
        return {
          totalProcessed: recordCount,
          hasMore: true,
          iterationsInChunk: iterations,
          metadata: { cursor, totalCount, recordingsSeen },
        };
      }
      throw new Error(message);
    }

    const rows: Record<string, unknown>[] = [];
    for (const recording of page.recordings) {
      rows.push(...(await fetchClaapRecordingTranscripts(ctx, recording)));
    }
    if (rows.length > 0) {
      await onBatch(rows);
      recordCount += rows.length;
    }
    recordingsSeen += page.recordings.length;
    onProgress?.(recordingsSeen, totalCount);

    cursor = page.pagination.nextCursor;
    iterations++;

    if (!cursor) {
      return {
        totalProcessed: recordCount,
        hasMore: false,
        iterationsInChunk: iterations,
        metadata: { cursor: null, totalCount, recordingsSeen },
      };
    }
  }

  return {
    totalProcessed: recordCount,
    hasMore: true,
    iterationsInChunk: iterations,
    metadata: { cursor, totalCount, recordingsSeen },
  };
}
