/**
 * Generates self-contained pagination helper code that runs inside the sandbox.
 * Uses native `fetch` — must not import Node-specific modules.
 *
 * The helper auto-detects common response shapes when custom extractors
 * are not provided, and supports cursor, offset, and link-based pagination.
 */

export type PaginationMode = "cursor" | "offset" | "link";

export interface PaginateOptions {
  initialUrl: string;
  mode?: PaginationMode;
  init?: RequestInit;
  pageSize?: number;
  cursorParam?: string;
  offsetParam?: string;
  limitParam?: string;
  getItems?: (payload: any) => unknown[];
  getNextCursor?: (payload: any) => string | null | undefined;
  getNextOffset?: (
    payload: any,
    currentOffset: number,
    pageSize: number,
  ) => number | null | undefined;
  getNextLink?: (response: Response, payload: any) => string | null | undefined;
}

export function getPaginateHelperCode(): string {
  return PAGINATE_HELPER_SOURCE;
}

export const PAGINATE_HELPER_SOURCE = String.raw`
async function* paginate(options) {
  const mode = options.mode || "cursor";
  const pageSize = options.pageSize || 100;
  const cursorParam = options.cursorParam || "cursor";
  const offsetParam = options.offsetParam || "offset";
  const limitParam = options.limitParam || "limit";

  const getItems =
    options.getItems ||
    ((payload) => {
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.data)) return payload.data;
      if (Array.isArray(payload?.items)) return payload.items;
      if (Array.isArray(payload?.results)) return payload.results;
      if (Array.isArray(payload?.records)) return payload.records;
      return [];
    });

  const getNextCursor =
    options.getNextCursor ||
    ((payload) =>
      payload?.nextCursor ??
      payload?.next_cursor ??
      payload?.cursor ??
      payload?.paging?.next_cursor ??
      payload?.meta?.next_cursor ??
      null);

  const getNextOffset =
    options.getNextOffset ||
    ((_payload, currentOffset, currentPageSize) => currentOffset + currentPageSize);

  const getNextLink =
    options.getNextLink ||
    ((response, payload) => {
      if (typeof payload?.next === "string" && payload.next) return payload.next;
      if (typeof payload?.next_url === "string" && payload.next_url) return payload.next_url;
      if (typeof payload?.paging?.next === "string") return payload.paging.next;

      const linkHeader = response.headers.get("link");
      if (!linkHeader) return null;
      const match = linkHeader.match(/<([^>]+)>;\s*rel="?next"?/i);
      return match ? match[1] : null;
    });

  let page = 0;
  let nextCursor = null;
  let nextOffset = 0;
  let nextUrl = options.initialUrl;
  let hasMore = true;

  while (hasMore && nextUrl) {
    page += 1;

    const url = new URL(nextUrl);
    if (mode === "cursor") {
      url.searchParams.set(limitParam, String(pageSize));
      if (nextCursor) url.searchParams.set(cursorParam, String(nextCursor));
    } else if (mode === "offset") {
      url.searchParams.set(limitParam, String(pageSize));
      url.searchParams.set(offsetParam, String(nextOffset));
    }

    const response = await fetch(url.toString(), options.init || {});
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error("Pagination request failed with status " + response.status + ": " + errorBody);
    }

    const payload = await response.json();
    const items = getItems(payload);

    if (!Array.isArray(items)) {
      throw new Error("paginate() expected getItems() to return an array");
    }

    if (mode === "cursor") {
      nextCursor = getNextCursor(payload) ?? null;
      hasMore = items.length > 0 && Boolean(nextCursor);
      if (!hasMore) nextUrl = null;
    } else if (mode === "offset") {
      const candidate = getNextOffset(payload, nextOffset, pageSize);
      nextOffset = typeof candidate === "number" && Number.isFinite(candidate)
        ? candidate
        : nextOffset + pageSize;
      hasMore = items.length === pageSize;
      if (!hasMore) nextUrl = null;
    } else {
      const link = getNextLink(response, payload);
      nextUrl = link || null;
      hasMore = Boolean(nextUrl);
    }

    yield { page, items, payload, response, nextCursor, nextOffset, hasMore };

    if (mode !== "link" && !hasMore) break;
  }
}
`;
