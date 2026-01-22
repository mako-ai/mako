/**
 * Domain Store Utilities
 *
 * Standard patterns and helpers for creating domain stores.
 * All domain stores should follow these patterns for consistency.
 */

/**
 * Standard loading/error state shape.
 * All stores that make API calls should include this.
 */
export interface AsyncState {
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
}

/**
 * Helper to create initial async state
 */
export const createAsyncState = (): AsyncState => ({
  loading: {},
  error: {},
});

/**
 * Helper to set loading state (for use with immer)
 */
export const setLoading =
  (key: string, value: boolean) =>
  (state: AsyncState): void => {
    state.loading[key] = value;
  };

/**
 * Helper to set error state (for use with immer)
 */
export const setError =
  (key: string, error: string | null) =>
  (state: AsyncState): void => {
    state.error[key] = error;
  };

/**
 * Helper to clear loading and error for a key
 */
export const clearAsyncState =
  (key: string) =>
  (state: AsyncState): void => {
    delete state.loading[key];
    delete state.error[key];
  };

/**
 * Standard API response type
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Wrapper for async operations with loading/error handling
 *
 * @example
 * ```typescript
 * await withAsyncState(
 *   set,
 *   'loadConsole',
 *   async () => {
 *     const res = await apiClient.get(...);
 *     set(s => { s.data = res.data; });
 *   }
 * );
 * ```
 */
export async function withAsyncState<T>(
  set: (fn: (state: AsyncState) => void) => void,
  key: string,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  set(state => {
    state.loading[key] = true;
    state.error[key] = null;
  });

  try {
    const result = await operation();
    set(state => {
      state.loading[key] = false;
    });
    return result;
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : "An error occurred";
    set(state => {
      state.loading[key] = false;
      state.error[key] = errorMessage;
    });
    return undefined;
  }
}

/**
 * Check if a specific operation is loading
 */
export const isLoading = (state: AsyncState, key: string): boolean =>
  !!state.loading[key];

/**
 * Get error for a specific operation
 */
export const getError = (state: AsyncState, key: string): string | null =>
  state.error[key] ?? null;
