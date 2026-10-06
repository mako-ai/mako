/**
 * Words for the "this console changed elsewhere" banner (see
 * ConsoleRemoteUpdateBanner).
 */
import type { ConsoleTab } from "../store/lib/types";

/**
 * The banner's sentence. Who changed it decides the words: the user
 * themselves (another window or tab of theirs), the agent, someone else, or
 * nobody known — never "updated another collaborator" (the old grammar),
 * and never "another collaborator" for the person's own change.
 */
export function remoteUpdateMessage(
  remoteUpdate: NonNullable<ConsoleTab["remoteUpdate"]>,
  currentUserId?: string | null,
): string {
  const by = remoteUpdate.updatedBy;
  if (remoteUpdate.kind === "deleted") {
    if (by && currentUserId && by === currentUserId) {
      return "This console was deleted in another window.";
    }
    if (by === "agent") return "This console was deleted by the agent.";
    return by
      ? "This console was deleted by another collaborator."
      : "This console was deleted elsewhere.";
  }
  const who =
    by && currentUserId && by === currentUserId
      ? "in another window"
      : by === "agent"
        ? "by the agent"
        : by
          ? "by another collaborator"
          : "elsewhere";
  return `This console was updated ${who} — your unsaved changes are based on an older copy.`;
}
