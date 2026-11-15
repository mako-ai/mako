import type { AxiosInstance } from "axios";
import type { CloseSyncLog } from "./client";
import type { CloseCustomFieldCache } from "./custom-fields";

/**
 * What the Close fetchers need from the connector. Every member is read on
 * use (never captured), so a client or `sleep` stubbed on the connector
 * instance is the one the fetchers call.
 */
export interface CloseFetchContext {
  api(): AxiosInstance;
  sleep(ms: number): Promise<void>;
  /** The connection's sync batch size setting. */
  batchSize(): number;
  /** The connection's rate-limit delay setting. */
  rateLimitDelay(): number;
  log: CloseSyncLog;
}

/** The Search API fetcher also plans custom-field selectors. */
export interface CloseSearchContext extends CloseFetchContext {
  customFields: CloseCustomFieldCache;
  /**
   * Per-request budget of `custom.cf_*` selectors. Starts at
   * CLOSE_SEARCH_CUSTOM_SELECTOR_BATCH and only ever shrinks, when Close
   * answers a field selection with HTTP 400.
   */
  selectorBudget(): number;
  setSelectorBudget(size: number): void;
}
