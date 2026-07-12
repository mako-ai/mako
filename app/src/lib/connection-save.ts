/**
 * Pure helpers for the connection save-with-verification flow, shared by
 * CreateDatabaseDialog and unit tests. Keeping the response-to-outcome mapping
 * here makes the core contract (a failed pre-save test opens the "Save anyways"
 * modal; a success marks the connection verified) testable without mounting the
 * dialog or the zustand store.
 */

export interface SaveResponseLike {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Cloud API: the pre-save connection test ran and passed. */
  verified?: boolean;
  /** "connection_test_failed" when verifyBeforeSave blocked the save. */
  code?: string;
}

export type PersistOutcome =
  | { outcome: "saved"; verified: boolean; data?: { _id?: string } }
  | { outcome: "test_failed"; error?: string }
  | { outcome: "error"; error?: string };

/**
 * Map a cloud `saveDatabase` response to a persist outcome.
 * - `connection_test_failed` -> the record was NOT created; offer edit/save-anyways.
 * - other failures -> a real save error (inline).
 * - success -> saved, carrying whether connectivity was verified.
 */
export function interpretCloudSaveResponse(
  res: SaveResponseLike,
): PersistOutcome {
  if (!res.success) {
    if (res.code === "connection_test_failed") {
      return { outcome: "test_failed", error: res.error };
    }
    return { outcome: "error", error: res.error };
  }
  return {
    outcome: "saved",
    verified: res.verified ?? false,
    data: res.data as { _id?: string } | undefined,
  };
}
