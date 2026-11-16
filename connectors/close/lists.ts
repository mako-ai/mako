/**
 * Close entities read from plain list endpoints with `_limit`/`_skip`
 * pagination: users, groups, lookup tables and custom fields. A port of the
 * chunk path in `api/src/connectors/close/list-fetchers.ts`.
 *
 * Read state is `{ offset }`, the in-process `FetchState.offset`: the offset
 * of the next page while there is more, the offset of the last page after it.
 */
import type { ReadBatch } from "@makoai/connector-sdk";
import type { CloseClient } from "./client.ts";
import { CLOSE_CUSTOM_FIELD_ENDPOINTS } from "./catalog.ts";

type ListBody = { data?: unknown[]; has_more?: boolean };

export interface ListRead {
  api: CloseClient;
  endpoint: string;
  pageSize: number;
  /** Pause between pages: the connection's rate-limit delay. */
  pause: () => Promise<void>;
  startOffset: number;
  extraParams?: Record<string, string>;
  /** `/user/` takes no `_order_by`; the lookups take none either. */
}

/** One batch per page, as `paginateByOffset` counts them. */
export async function* readOffsetList(
  options: ListRead,
): AsyncGenerator<ReadBatch> {
  let offset = options.startOffset;
  let first = true;
  while (true) {
    if (!first) await options.pause();
    first = false;
    const body = await options.api.get<ListBody>(options.endpoint, {
      _limit: options.pageSize,
      _skip: offset,
      ...(options.extraParams ?? {}),
    });
    const records = body?.data || [];
    const hasMore = body?.has_more || false;
    if (hasMore) offset += options.pageSize;
    yield { records, state: { offset }, hasMore };
    if (!hasMore) return;
  }
}

/**
 * Every custom field of every type, each tagged with its type, in one batch:
 * the in-process connector reads all 4 endpoints in a single chunk. An
 * endpoint that fails is skipped, as in-process.
 */
export async function readAllCustomFields(
  api: CloseClient,
  log: (message: string) => void,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const { endpoint, type } of CLOSE_CUSTOM_FIELD_ENDPOINTS) {
    try {
      const body = await api.get<ListBody>(endpoint);
      for (const field of (body?.data || []) as Record<string, unknown>[]) {
        out.push({ ...field, custom_field_type: type });
      }
    } catch (error) {
      log(
        `Error fetching ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return out;
}
