import { useConsoleStore } from "../../store/consoleStore";
import { useUIStore } from "../../store/uiStore";

/**
 * Focus a console referenced in the chat (a tool card's title): its open tab,
 * or open it from the server. On mobile the console lives behind the View
 * tab, so surface it so tapping a console reference ("view SQL") shows the
 * query.
 */
export async function openConsoleFromChat(
  consoleId: string,
  { isMobile, workspaceId }: { isMobile: boolean; workspaceId?: string },
): Promise<void> {
  const store = useConsoleStore.getState();
  if (isMobile) {
    useUIStore.getState().setMobileConsolePane("query");
    useUIStore.getState().setMobileTab("view");
  }
  if (store.tabs[consoleId]) {
    store.setActiveTab(consoleId);
    return;
  }
  if (!workspaceId) return;
  try {
    await store.openConsoleFromServer(workspaceId, consoleId);
  } catch {
    /* ignore focus failures */
  }
}
