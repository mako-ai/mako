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

/** The part of a connection form a save sends besides its display name. */
export interface ConnectionConfigLike {
  type: string;
  connection: Record<string, unknown>;
}

/**
 * True when the form would save the same connection config it loaded, so
 * only the display name (or nothing) changed. Such a save skips the
 * pre-save test: the test proves the config reaches the database, and a new
 * name does not change that — a rename in the Edit dialog used to stop on
 * "Connection test failed … Save anyways" while the REST rename did not.
 *
 * The comparison forgives what the form adds on its own: a field the stored
 * config lacks reads back as `""` (text), `NaN` (an empty number field) or
 * `null`, and a number field may hold `5432` where the store had `"5432"`.
 * Anything else that differs, at any depth, counts as a change and is
 * tested as before.
 */
export function connectionConfigUnchanged(
  loaded: ConnectionConfigLike,
  submitted: ConnectionConfigLike,
): boolean {
  return (
    loaded.type === submitted.type &&
    sameConfigValue(loaded.connection, submitted.connection)
  );
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (typeof value === "number" && Number.isNaN(value))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameConfigValue(a: unknown, b: unknown): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  if (isBlank(a) || isBlank(b)) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameConfigValue(item, b[i]))
    );
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every(key => sameConfigValue(a[key], b[key]));
  }
  if (
    (typeof a === "number" && typeof b === "string") ||
    (typeof a === "string" && typeof b === "number")
  ) {
    return String(a) === String(b);
  }
  return Object.is(a, b);
}
