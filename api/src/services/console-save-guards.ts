/**
 * Optimistic-concurrency guards for console writes (PUT /consoles/:id).
 *
 * Two independent counters protect a SavedConsole document:
 *   - `version`        — bumped by EXPLICIT saves only (checkpoint history);
 *   - `draftRevision`  — bumped by every draft write: autosaves, agent
 *                        modify_console / set_console_connection, run
 *                        artifacts, renames.
 *
 * Explicit saves must check BOTH (a stale window's Cmd+S would otherwise
 * pass the version guard and silently revert agent edits / other tabs'
 * autosaves, which bump only draftRevision). Draft autosaves check only
 * draftRevision.
 *
 * Guards are applied atomically inside the Mongo update filter — never as a
 * read-then-write check. While any guard is active the write must NOT
 * upsert: a mismatch would insert a duplicate document instead of failing.
 *
 * Pure module (no imports) so the matrix is unit-testable standalone:
 *   pnpm --filter api exec tsx src/services/console-save-guards.test.ts
 */

export interface ConsoleWriteGuardInput {
  /** Identity filter ({_id, workspaceId}) the guard conditions extend. */
  baseFilter: Record<string, unknown>;
  /**
   * Whether the document already exists. Guards only engage for existing
   * documents — first-time upserts have nothing to conflict with.
   */
  docExists: boolean;
  /** Client's optimistic version base (explicit saves). */
  expectedVersion?: number;
  /** Client's draft revision base (autosaves AND explicit saves). */
  expectedDraftRevision?: number;
}

export interface ConsoleWriteGuard {
  /** Filter to use in findOneAndUpdate. */
  filter: Record<string, unknown>;
  /**
   * True when at least one guard condition is present — the caller must set
   * `upsert: false` and treat a null update result as a 409 conflict.
   */
  guardActive: boolean;
}

/**
 * Documents created before the counters existed have no field at all; they
 * count as 1 so old docs aren't permanently unguardable.
 */
function legacyAwareEquals(
  expected: number,
): number | { $in: Array<number | null> } {
  return expected === 1 ? { $in: [1, null] } : expected;
}

function isValidExpectation(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 1;
}

export function buildConsoleWriteGuard(
  input: ConsoleWriteGuardInput,
): ConsoleWriteGuard {
  const useVersionGuard =
    input.docExists && isValidExpectation(input.expectedVersion);
  const useDraftGuard =
    input.docExists && isValidExpectation(input.expectedDraftRevision);

  const filter: Record<string, unknown> = { ...input.baseFilter };
  if (useVersionGuard) {
    filter.version = legacyAwareEquals(input.expectedVersion as number);
  }
  if (useDraftGuard) {
    filter.draftRevision = legacyAwareEquals(
      input.expectedDraftRevision as number,
    );
  }

  return { filter, guardActive: useVersionGuard || useDraftGuard };
}
