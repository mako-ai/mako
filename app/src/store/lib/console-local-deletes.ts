/**
 * Consoles this window moved to the trash. The server announces every
 * deletion (`console.deleted`) to every window, this one included; the
 * banner it raises must say what happened here — "Moved to trash" — not
 * "deleted elsewhere".
 */
const deletedHere = new Set<string>();

/** This window is moving `consoleId` to the trash. */
export function markDeletedHere(consoleId: string): void {
  deletedHere.add(consoleId);
}

/** The delete did not happen after all (the request failed). */
export function unmarkDeletedHere(consoleId: string): void {
  deletedHere.delete(consoleId);
}

/** Whether this window trashed `consoleId` (answered once per deletion). */
export function takeDeletedHere(consoleId: string): boolean {
  return deletedHere.delete(consoleId);
}
