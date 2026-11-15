/**
 * Pagination loops shared by the connectors. Each loop owns the mechanics
 * (advance, count, pause between pages, stop at the iteration budget); the
 * connector supplies how one page is fetched and maps the outcome onto its
 * own FetchState shape, so resumable state stays exactly as it was.
 */

export interface PageLoopCallbacks<T> {
  onBatch: (records: T[]) => Promise<void>;
  /** Called with the running total after every non-empty page. */
  onProgress?: (processed: number) => void;
  /** Pause between pages (connector `sleep` + its rate-limit delay). */
  pause: () => Promise<void>;
}

export interface OffsetPageResult<T> {
  records: T[];
  hasMore: boolean;
}

export interface OffsetLoopResult {
  /** Offset of the next page to request. */
  offset: number;
  totalProcessed: number;
  hasMore: boolean;
  /** Pages fetched that were followed by another one. */
  iterations: number;
}

/**
 * `_limit`/`_skip`-style pagination: request `pageSize` rows at `offset`,
 * hand them over, and while the API says there is more, advance by
 * `pageSize` and pause. Stops after `maxIterations` follow-up pages
 * (Infinity for a full drain).
 */
export async function paginateByOffset<T>(
  options: PageLoopCallbacks<T> & {
    fetchPage: (offset: number) => Promise<OffsetPageResult<T>>;
    pageSize: number;
    startOffset?: number;
    startCount?: number;
    maxIterations?: number;
  },
): Promise<OffsetLoopResult> {
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  let offset = options.startOffset ?? 0;
  let totalProcessed = options.startCount ?? 0;
  let hasMore = true;
  let iterations = 0;

  while (hasMore && iterations < maxIterations) {
    const page = await options.fetchPage(offset);
    if (page.records.length > 0) {
      await options.onBatch(page.records);
      totalProcessed += page.records.length;
      options.onProgress?.(totalProcessed);
    }

    hasMore = page.hasMore;
    if (hasMore) {
      offset += options.pageSize;
      iterations++;
      await options.pause();
    }
  }

  return { offset, totalProcessed, hasMore, iterations };
}

export interface CursorPageResult<T> {
  records: T[];
  /** Token for the next page; null/undefined/"" when this was the last. */
  next: string | null | undefined;
}

export interface CursorLoopResult {
  /**
   * Token for the next page; null when exhausted (undefined only when the
   * budget allowed no page at all and there was no start token).
   */
  cursor: string | null | undefined;
  totalProcessed: number;
  hasMore: boolean;
  /** Pages fetched (every one counts). */
  iterations: number;
}

/**
 * Next-token pagination: fetch the page at `cursor`, hand it over, follow
 * the returned token; pause between pages but not after the last. Stops
 * after `maxIterations` pages with `hasMore: true` and the token to resume
 * from.
 */
export async function paginateByCursor<T>(
  options: PageLoopCallbacks<T> & {
    fetchPage: (cursor: string | undefined) => Promise<CursorPageResult<T>>;
    startCursor?: string;
    startCount?: number;
    maxIterations: number;
  },
): Promise<CursorLoopResult> {
  let cursor = options.startCursor;
  let totalProcessed = options.startCount ?? 0;
  let iterations = 0;

  while (iterations < options.maxIterations) {
    const page = await options.fetchPage(cursor);
    if (page.records.length > 0) {
      await options.onBatch(page.records);
      totalProcessed += page.records.length;
      options.onProgress?.(totalProcessed);
    }

    cursor = page.next || undefined;
    iterations++;
    if (!cursor) {
      return { cursor: null, totalProcessed, hasMore: false, iterations };
    }
    await options.pause();
  }

  return { cursor, totalProcessed, hasMore: true, iterations };
}
