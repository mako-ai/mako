/**
 * Claap `recording_transcripts`: one row per recording and transcript
 * language, downloaded from the listing's signed link, or from the
 * transcript endpoint when the link fails. A port of
 * `api/src/connectors/claap/transcripts.ts`.
 */
import {
  extractClaapResult,
  formatClaapError,
  type ClaapClient,
} from "./client.ts";
import {
  CLAAP_DAILY_QUOTA_RESERVE,
  fetchClaapRecordingsPage,
  type ClaapReadContext,
} from "./recordings.ts";

export const CLAAP_TRANSCRIPTS_ENTITY = "recording_transcripts";

const TRANSCRIPT_PAGE_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A poll re-lists recordings created this long before `since`. */
const TRANSCRIPT_RECHECK_MS = 2 * DAY_MS;
const TRANSCRIPT_MAX_BYTES = 50_000_000;
export const TRANSCRIPT_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

type ClaapTranscriptSegment = {
  startedAt: number;
  endedAt: number;
  text: string;
  speaker?: string;
  languageCode?: string;
};

/** Segments from any of Claap's wrappings; per-word timings dropped. */
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

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${pad(minutes)}:${pad(secs)}`;
}

/** Claap's `format=text` layout, one line per segment. */
export function renderClaapTranscriptText(
  segments: ClaapTranscriptSegment[],
): string {
  return segments
    .map(segment => {
      const speaker = segment.speaker ? ` ${segment.speaker}:` : "";
      return `${formatTimestamp(segment.startedAt)}${speaker} ${segment.text}`;
    })
    .join("\n");
}

/** A host that is an IP literal in a private, loopback or link-local range. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) {
    return (
      host === "::1" ||
      host === "::" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80") ||
      host.startsWith("::ffff:")
    );
  }
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p))) {
    return false;
  }
  const [a, b] = parts.map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * A signed link, as `safeFetch` reads it in-process: https only, no
 * private-address host, at most 3 redirects (each checked), 50 MB and a
 * timeout. The link carries its own token; the API key is never sent.
 */
export async function downloadSignedUrl(
  url: string,
  timeoutMs = TRANSCRIPT_TIMEOUT_MS,
): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  let target = url;
  for (let hop = 0; ; hop++) {
    const parsed = new URL(target);
    if (parsed.protocol !== "https:") {
      throw new Error(`Refusing a non-https transcript link`);
    }
    if (isPrivateHost(parsed.hostname)) {
      throw new Error(`Refusing a transcript link to a private address`);
    }
    const response = await fetch(target, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || hop >= MAX_REDIRECTS) {
        throw new Error(`HTTP ${response.status} downloading transcript`);
      }
      target = new URL(location, target).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} downloading transcript`);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > TRANSCRIPT_MAX_BYTES) {
          await reader.cancel();
          throw new Error(`Transcript is over ${TRANSCRIPT_MAX_BYTES} bytes`);
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

export interface TranscriptDeps {
  api: ClaapClient;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  /** The connection's rate-limit delay, after each transcript. */
  rateLimitDelay: number;
  download(url: string): Promise<string>;
}

async function downloadTranscriptSegments(
  deps: TranscriptDeps,
  recordingId: string,
  langIso2: string,
  url: unknown,
): Promise<ClaapTranscriptSegment[]> {
  if (typeof url === "string" && url.startsWith("https://")) {
    try {
      const body = await deps.download(url);
      const segments = parseClaapTranscriptSegments(JSON.parse(body));
      if (segments) return segments;
      deps.log(
        `Claap transcript link returned no segments (${recordingId} ${langIso2})`,
      );
    } catch (error) {
      deps.log(
        `Claap transcript link failed; using the API endpoint (${recordingId} ${langIso2}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const response = await deps.api.get(
    `/v1/recordings/${encodeURIComponent(recordingId)}/transcript`,
    { lang: langIso2, format: "json" },
  );
  const segments = parseClaapTranscriptSegments(response.data);
  if (!segments) throw new Error("Claap transcript response has no segments");
  return segments;
}

/** Every transcript of one recording as rows; a failed download is a `failed` row. */
export async function fetchClaapRecordingTranscripts(
  deps: TranscriptDeps,
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

  for (const ref of recording.transcripts as Array<Record<string, unknown>>) {
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
        deps,
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
      const message = formatClaapError(error);
      deps.log(
        `Could not download Claap transcript (${recordingId} ${langIso2}): ${message}`,
      );
      rows.push({
        ...base,
        transcriptText: null,
        segments: null,
        segmentCount: null,
        charCount: null,
        fetchStatus: "failed",
        fetchError: message.slice(0, 500),
        fetchedAt: new Date().toISOString(),
      });
    }

    await deps.sleep(deps.rateLimitDelay);
  }
  return rows;
}

export interface TranscriptsState {
  cursor?: string | null;
  totalCount?: number;
  recordingsSeen?: number;
  totalProcessed?: number;
}

/**
 * `recording_transcripts`: each page of recordings is listed and its
 * transcripts downloaded in the same chunk, as the links expire after 24
 * hours. Near the daily quota reserve the chunk ends with `hasMore: true`
 * after the pages it read, or fails when it read none.
 */
export async function* readClaapTranscripts(
  ctx: ClaapReadContext,
  deps: TranscriptDeps,
  state: TranscriptsState,
  since: Date | undefined,
) {
  const createdAfter = since
    ? new Date(since.getTime() - TRANSCRIPT_RECHECK_MS)
    : undefined;
  let cursor = typeof state.cursor === "string" ? state.cursor : undefined;
  let totalCount = state.totalCount;
  let recordingsSeen = state.recordingsSeen ?? 0;
  let recordCount = state.totalProcessed ?? 0;
  let pages = 0;

  while (true) {
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
      ctx.log(message);
      // The last page yielded said `hasMore: true`: ending here ends the
      // chunk, and the next one resumes at `cursor`.
      if (pages > 0) return;
      throw new Error(message);
    }

    const rows: Record<string, unknown>[] = [];
    for (const recording of page.recordings) {
      rows.push(...(await fetchClaapRecordingTranscripts(deps, recording)));
    }
    recordCount += rows.length;
    recordingsSeen += page.recordings.length;
    cursor = page.pagination.nextCursor;
    pages++;

    if (!cursor) {
      yield {
        records: rows,
        state: {
          cursor: null,
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
        totalCount,
        recordingsSeen,
        totalProcessed: recordCount,
      },
      hasMore: true,
    };
  }
}
