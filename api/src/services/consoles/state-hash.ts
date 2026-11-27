/**
 * The saved-state hash a console tab compares against to decide whether it
 * is dirty (Save enabled, autosave eligibility).
 */
import type { ISavedConsole } from "../../database/workspace-schema";
import type { SavedConsoleRecord } from "../../repositories/consoles-charts";
import { savedConsoleStateFromRepo } from "../../apps/workspace-consoles.service";

// IMPORTANT: this MUST stay byte-for-byte compatible with the client hash so
// the server-computed baseline equals what the client would compute for the
// same snapshot. Mirror of `hashContent` in `app/src/utils/hash.ts` and
// `computeConsoleStateHash` in `app/src/utils/stateHash.ts`. The two packages
// can't share code (no common import path), so any change to the algorithm
// here must be made in lockstep with those files or Save will misdetect dirt.
export function hashContent(content: string): string {
  let hash = 0;
  if (content.length === 0) return "0";

  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }

  return Math.abs(hash).toString(16);
}

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

/**
 * Hash of the last explicitly saved state — read from the console's file at
 * HEAD (git is the history; snapshot rows are no longer written).
 */
export async function getLatestConsoleSavedStateHash(
  row:
    | Pick<ISavedConsole, "workspaceId" | "path">
    | Pick<SavedConsoleRecord, "workspaceId" | "path">,
): Promise<string | undefined> {
  const saved = await savedConsoleStateFromRepo(row);
  if (!saved) return undefined;
  return computeConsoleStateHash(
    saved.code,
    saved.connectionId,
    saved.databaseId,
    saved.databaseName,
  );
}
