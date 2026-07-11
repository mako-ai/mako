import type { ConsoleTab } from "../store/lib/types";

export function confirmAppV2FileTabClose(
  tab: ConsoleTab | undefined,
  confirmDiscard: (message: string) => boolean,
): boolean {
  if (tab?.kind !== "app-v2-file" || !tab.isDirty) return true;
  return confirmDiscard(
    `Discard unsaved changes to "${tab.title || "this file"}"?`,
  );
}

export function confirmAppV2RemoteLoad(
  dirty: boolean,
  confirmDiscard: (message: string) => boolean,
): boolean {
  if (!dirty) return true;
  return confirmDiscard(
    "Load the remote version and discard your unsaved local edits?",
  );
}
