import { hashContent } from "./hash";

/**
 * Compute a hash of the console state for dirty state tracking.
 * This single hash replaces multiple saved* fields and enables
 * accurate detection of unsaved changes across all editable properties.
 *
 * When current state hash !== savedStateHash, the console has unsaved changes.
 */
export function computeConsoleStateHash(
  content: string,
  connectionId?: string,
  databaseId?: string,
  databaseName?: string,
): string {
  return hashContent(
    `${content}|${connectionId || ""}|${databaseId || ""}|${databaseName || ""}`,
  );
}
