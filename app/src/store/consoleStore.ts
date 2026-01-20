import { useMemo } from "react";
import { useAppStore, useAppDispatch, ConsoleTab } from "./appStore";
import { apiClient } from "../lib/api-client";
import { generateObjectId } from "../utils/objectId";
import { ConsoleVersionManager } from "../utils/ConsoleVersionManager";
import { computeConsoleStateHash } from "../utils/stateHash";

export type TabKind =
  | "console"
  | "settings"
  | "connectors"
  | "members"
  | "flow-editor";

// Store version managers for each console tab
const versionManagers = new Map<string, ConsoleVersionManager>();

// Debounce timers for draft console saves (per console ID)
const draftSaveTimers = new Map<string, NodeJS.Timeout>();
// Track last saved content hash to avoid redundant API calls
const lastSavedContentHash = new Map<string, string>();
const DRAFT_SAVE_DEBOUNCE_MS = 2000; // 2 seconds debounce

/**
 * Cancel any pending auto-save for a console.
 * Called when a console is closed to prevent orphan saves.
 */
const cancelAutoSave = (consoleId: string): void => {
  const timer = draftSaveTimers.get(consoleId);
  if (timer) {
    clearTimeout(timer);
    draftSaveTimers.delete(consoleId);
  }
  lastSavedContentHash.delete(consoleId);
};

/**
 * Check if a console should auto-save.
 * Returns false if the console is already explicitly saved (isSaved=true).
 */
const shouldAutoSave = (consoleId: string): boolean => {
  const state = useAppStore.getState();
  const tab = state.consoles.tabs[consoleId];
  // Only auto-save draft consoles (isSaved=false)
  // Once explicitly saved, user controls saving via Cmd+S
  return tab ? !tab.isSaved : true;
};

/**
 * Auto-save console content (debounced).
 * Only saves draft consoles (isSaved=false) to the database.
 * Once a console is explicitly saved (isSaved=true), auto-save is disabled.
 *
 * Called from Console.tsx when content changes.
 */
const autoSaveConsoleImpl = (
  workspaceId: string,
  consoleId: string,
  content: string,
  title?: string,
  connectionId?: string,
  databaseId?: string,
  databaseName?: string,
): void => {
  // Skip empty content or placeholder content
  if (!content?.trim() || content === "loading...") return;

  // Skip if console is already explicitly saved (user controls saving)
  if (!shouldAutoSave(consoleId)) return;

  // Skip if content hasn't changed since last save (avoid redundant API calls)
  const stateHash = computeConsoleStateHash(
    content,
    connectionId,
    databaseId,
    databaseName,
  );
  if (lastSavedContentHash.get(consoleId) === stateHash) {
    return;
  }

  // Clear existing timer for this console
  const existingTimer = draftSaveTimers.get(consoleId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set new debounced timer
  const timer = setTimeout(async () => {
    draftSaveTimers.delete(consoleId);
    // Re-check shouldAutoSave in case isSaved changed during debounce
    if (!shouldAutoSave(consoleId)) return;

    try {
      await apiClient.put(`/workspaces/${workspaceId}/consoles/${consoleId}`, {
        content,
        title,
        connectionId,
        databaseId,
        databaseName,
        // isSaved is NOT passed - this is an auto-save (draft)
      });
      // Track successful save to avoid redundant future saves
      lastSavedContentHash.set(consoleId, stateHash);
    } catch (e) {
      // Silently fail - auto-saves are best effort
      console.debug("[AutoSave] Failed to save console:", e);
    }
  }, DRAFT_SAVE_DEBOUNCE_MS);

  draftSaveTimers.set(consoleId, timer);
};

// Selector helpers
const selectConsoleState = (state: any) => state.consoles;

export const useConsoleStore = () => {
  const dispatch = useAppDispatch();
  const { tabs, activeTabId } = useAppStore(selectConsoleState);

  // Memoize to prevent new array reference on every render
  // This is critical to avoid infinite re-render loops in consumers
  const consoleTabs: ConsoleTab[] = useMemo(() => Object.values(tabs), [tabs]);

  const addConsoleTab = (
    tab: Omit<ConsoleTab, "id" | "isSaved"> & {
      id?: string;
      isSaved?: boolean;
    },
  ): string => {
    const id = tab.id || generateObjectId(); // Use provided ID or generate new MongoDB ObjectId

    // Create version manager for console tabs
    if (tab.kind === undefined || tab.kind === "console") {
      versionManagers.set(id, new ConsoleVersionManager(id));
    }

    // Compute savedStateHash if this is a saved console (has filePath)
    const content = tab.content || "";
    const savedStateHash = tab.filePath
      ? computeConsoleStateHash(
          content,
          tab.connectionId,
          tab.databaseId,
          tab.databaseName,
        )
      : undefined;

    dispatch({
      type: "OPEN_CONSOLE_TAB",
      payload: {
        id,
        title: tab.title,
        content,
        isSaved: tab.isSaved ?? !!tab.filePath, // Saved if has filePath
        savedStateHash,
        connectionId: tab.connectionId,
        databaseId: tab.databaseId,
        databaseName: tab.databaseName,
        filePath: tab.filePath,
        kind: (tab as any).kind || "console",
        icon: tab.icon,
        metadata: tab.metadata,
      },
    });
    return id;
  };

  const removeConsoleTab = (id: string) => {
    // Clean up version manager
    const versionManager = versionManagers.get(id);
    if (versionManager) {
      versionManager.cleanup();
      versionManagers.delete(id);
    }

    // Cancel any pending auto-save for this console
    cancelAutoSave(id);

    dispatch({ type: "CLOSE_CONSOLE_TAB", payload: { id } });
  };

  const setActiveConsole = (id: string | null) =>
    dispatch({ type: "FOCUS_CONSOLE_TAB", payload: { id } });

  const updateConsoleContent = (id: string, content: string) =>
    dispatch({
      type: "UPDATE_CONSOLE_CONTENT",
      payload: { id, content },
    });

  const findTabByKind = (kind: TabKind) =>
    consoleTabs.find((t: any) => (t as any).kind === kind);

  const updateConsoleConnection = (id: string, connectionId?: string) => {
    dispatch({
      type: "UPDATE_CONSOLE_CONNECTION",
      payload: { id, connectionId },
    });
  };

  const updateConsoleDatabase = (
    id: string,
    databaseId?: string,
    databaseName?: string,
  ) => {
    dispatch({
      type: "UPDATE_CONSOLE_DATABASE",
      payload: { id, databaseId, databaseName },
    });
  };

  const updateConsoleFilePath = (id: string, filePath: string) => {
    dispatch({
      type: "UPDATE_CONSOLE_FILE_PATH",
      payload: { id, filePath },
    });
  };

  const updateConsoleTitle = (id: string, title: string) => {
    dispatch({
      type: "UPDATE_CONSOLE_TITLE",
      payload: { id, title },
    });
  };

  const updateConsoleDirty = (id: string, isDirty: boolean) => {
    dispatch({
      type: "UPDATE_CONSOLE_DIRTY",
      payload: { id, isDirty },
    });
  };

  const updateConsoleIcon = (id: string, icon: string) => {
    dispatch({
      type: "UPDATE_CONSOLE_ICON",
      payload: { id, icon },
    });
  };

  /**
   * Update the saved state after a successful explicit save.
   * Sets isSaved=true and updates savedStateHash for dirty tracking.
   */
  const updateSavedState = (
    id: string,
    isSaved: boolean,
    savedStateHash: string,
  ) => {
    dispatch({
      type: "UPDATE_CONSOLE_SAVED_STATE",
      payload: { id, isSaved, savedStateHash },
    });
  };

  const clearAllConsoles = () => {
    consoleTabs.forEach(tab => removeConsoleTab(tab.id));
  };

  const getVersionManager = (
    consoleId: string,
  ): ConsoleVersionManager | null => {
    return versionManagers.get(consoleId) || null;
  };

  const executeQuery = async (
    workspaceId: string,
    connectionId: string,
    query: string,
    options?: {
      databaseName?: string;
      databaseId?: string;
      executionId?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ success: boolean; data?: any; error?: string }> => {
    try {
      const res = await apiClient.post<{
        success: boolean;
        data: any;
        error?: string;
      }>(
        `/workspaces/${workspaceId}/execute`,
        {
          connectionId,
          query,
          databaseId: options?.databaseId,
          databaseName: options?.databaseName,
          executionId: options?.executionId,
        },
        { signal: options?.signal },
      );
      return res.success
        ? { success: true, data: (res as any).data }
        : { success: false, error: (res as any).error || "Execution failed" };
    } catch (e: any) {
      if (e?.name === "AbortError") {
        return { success: false, error: "Query cancelled" };
      }
      return { success: false, error: e?.message || "Execution failed" };
    }
  };

  const cancelQuery = async (
    workspaceId: string,
    executionId: string,
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await apiClient.post<{ success: boolean; error?: string }>(
        `/workspaces/${workspaceId}/execute/cancel`,
        { executionId },
      );
      return res;
    } catch (e: any) {
      return { success: false, error: e?.message || "Cancel failed" };
    }
  };

  /**
   * Save console to the backend.
   * Always uses the same ID (ID never changes).
   *
   * For explicit save (first save or Cmd+S): Pass isSaved=true and path
   * The backend will check for path conflicts and return 409 if exists.
   */
  const saveConsole = async (
    workspaceId: string,
    tabId: string,
    content: string,
    path: string,
    connectionId?: string,
    databaseName?: string,
    databaseId?: string,
  ): Promise<{
    success: boolean;
    path?: string;
    error?: string;
    conflict?: {
      existingId: string;
      existingContent: string;
      existingName: string;
      existingLanguage?: "sql" | "javascript" | "mongodb";
      path: string;
    };
  }> => {
    // Guard against saving placeholder content
    if (!content?.trim() || content === "loading...") {
      return {
        success: false,
        error: "Cannot save empty or placeholder content",
      };
    }

    try {
      // Remove .js extension if present as backend doesn't expect it
      const cleanPath = path.endsWith(".js") ? path.slice(0, -3) : path;

      // Always PUT to the same ID with isSaved=true for explicit save
      const response = await fetch(
        `/api/workspaces/${workspaceId}/consoles/${tabId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            content,
            path: cleanPath,
            connectionId,
            databaseName,
            databaseId,
            isSaved: true, // Explicit save
          }),
        },
      );

      const res = await response.json();

      // Handle conflict (409) - return conflict data for UI to handle
      if (response.status === 409 && res.error === "conflict" && res.conflict) {
        return { success: false, error: "conflict", conflict: res.conflict };
      }

      if (!response.ok) {
        return { success: false, error: res.error || "Save failed" };
      }

      return res.success
        ? { success: true, path: cleanPath }
        : { success: false, error: res.error || "Save failed" };
    } catch (e: any) {
      return { success: false, error: e?.message || "Save failed" };
    }
  };

  /**
   * Delete a console by ID.
   * Used when overwriting a console at a conflicting path.
   */
  const deleteConsole = async (
    workspaceId: string,
    consoleId: string,
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      const res = await apiClient.delete<{ success: boolean; error?: string }>(
        `/workspaces/${workspaceId}/consoles/${consoleId}`,
      );
      return res;
    } catch (e: any) {
      return { success: false, error: e?.message || "Delete failed" };
    }
  };

  return {
    consoleTabs,
    tabs, // Expose raw tabs object for direct ID-based access
    activeConsoleId: activeTabId,
    addConsoleTab,
    findTabByKind,
    removeConsoleTab,
    updateConsoleContent,
    setActiveConsole,
    clearAllConsoles,
    updateConsoleConnection,
    updateConsoleDatabase,
    updateConsoleFilePath,
    updateConsoleTitle,
    updateConsoleDirty,
    updateConsoleIcon,
    updateSavedState,
    getVersionManager,
    executeQuery,
    cancelQuery,
    saveConsole,
    deleteConsole,
    autoSaveConsole: autoSaveConsoleImpl,
    loadConsole: async (id: string, workspaceId: string) => {
      // Check if console is already loaded
      const existing = consoleTabs.find(t => t.id === id);
      if (existing) {
        setActiveConsole(id);
        return;
      }

      try {
        // Fetch from API
        const res = await apiClient.get<{
          success: boolean;
          content: string;
          connectionId?: string;
          databaseId?: string;
          databaseName?: string;
          language?: string;
          id: string;
          path?: string;
          name?: string;
          isSaved?: boolean;
        }>(`/workspaces/${workspaceId}/consoles/content?id=${id}`);

        if (res.success) {
          const content = res.content || "";
          const filePath = res.path || res.name;
          addConsoleTab({
            id: res.id, // Should match requested ID
            title: res.name || res.path || "Console",
            content,
            isSaved: res.isSaved ?? !!filePath, // Saved if has path
            connectionId: res.connectionId,
            databaseId: res.databaseId,
            databaseName: res.databaseName,
            filePath,
            kind: "console",
          });
          setActiveConsole(res.id);
        }
      } catch (e) {
        console.error("Failed to load console", e);
      }
    },
  };
};

// Provide getState for legacy direct access
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – attach property dynamically
useConsoleStore.getState = () => {
  const global = useAppStore.getState();
  const dispatch = global.dispatch;
  const tabs = global.consoles.tabs;
  const activeTabId = global.consoles.activeTabId;

  const consoleTabs: ConsoleTab[] = Object.values(tabs);

  const addConsoleTab = (
    tab: Omit<ConsoleTab, "id" | "isSaved"> & {
      id?: string;
      isSaved?: boolean;
    },
  ): string => {
    const id = tab.id || generateObjectId(); // Use provided ID or generate new MongoDB ObjectId

    // Create version manager for console tabs
    if (tab.kind === undefined || tab.kind === "console") {
      versionManagers.set(id, new ConsoleVersionManager(id));
    }

    // Compute savedStateHash if this is a saved console (has filePath)
    const content = tab.content || "";
    const savedStateHash = tab.filePath
      ? computeConsoleStateHash(
          content,
          tab.connectionId,
          tab.databaseId,
          tab.databaseName,
        )
      : undefined;

    dispatch({
      type: "OPEN_CONSOLE_TAB",
      payload: {
        id,
        title: tab.title,
        content,
        isSaved: tab.isSaved ?? !!tab.filePath, // Saved if has filePath
        savedStateHash,
        connectionId: tab.connectionId,
        databaseId: tab.databaseId,
        databaseName: tab.databaseName,
        filePath: tab.filePath,
        kind: (tab as any).kind || "console",
        icon: tab.icon,
        metadata: tab.metadata,
      },
    });
    return id;
  };

  const removeConsoleTab = (id: string) => {
    // Clean up version manager
    const versionManager = versionManagers.get(id);
    if (versionManager) {
      versionManager.cleanup();
      versionManagers.delete(id);
    }

    // Cancel any pending auto-save for this console
    cancelAutoSave(id);

    dispatch({ type: "CLOSE_CONSOLE_TAB", payload: { id } });
  };

  const setActiveConsole = (id: string | null) =>
    dispatch({ type: "FOCUS_CONSOLE_TAB", payload: { id } });

  const updateConsoleContent = (id: string, content: string) =>
    dispatch({
      type: "UPDATE_CONSOLE_CONTENT",
      payload: { id, content },
    });

  const findTabByKind = (kind: TabKind) =>
    consoleTabs.find((t: any) => (t as any).kind === kind);

  const updateConsoleConnection = (id: string, connectionId?: string) => {
    dispatch({
      type: "UPDATE_CONSOLE_CONNECTION",
      payload: { id, connectionId },
    });
  };

  const updateConsoleDatabase = (
    id: string,
    databaseId?: string,
    databaseName?: string,
  ) => {
    dispatch({
      type: "UPDATE_CONSOLE_DATABASE",
      payload: { id, databaseId, databaseName },
    });
  };

  const updateConsoleFilePath = (id: string, filePath: string) => {
    dispatch({
      type: "UPDATE_CONSOLE_FILE_PATH",
      payload: { id, filePath },
    });
  };

  const updateConsoleTitle = (id: string, title: string) => {
    dispatch({
      type: "UPDATE_CONSOLE_TITLE",
      payload: { id, title },
    });
  };

  const updateConsoleDirty = (id: string, isDirty: boolean) => {
    dispatch({
      type: "UPDATE_CONSOLE_DIRTY",
      payload: { id, isDirty },
    });
  };

  const updateConsoleIcon = (id: string, icon: string) => {
    dispatch({
      type: "UPDATE_CONSOLE_ICON",
      payload: { id, icon },
    });
  };

  const updateSavedState = (
    id: string,
    isSaved: boolean,
    savedStateHash: string,
  ) => {
    dispatch({
      type: "UPDATE_CONSOLE_SAVED_STATE",
      payload: { id, isSaved, savedStateHash },
    });
  };

  const clearAllConsoles = () => {
    consoleTabs.forEach(tab => removeConsoleTab(tab.id));
  };

  const getVersionManager = (
    consoleId: string,
  ): ConsoleVersionManager | null => {
    return versionManagers.get(consoleId) || null;
  };

  return {
    consoleTabs,
    tabs,
    activeConsoleId: activeTabId,
    addConsoleTab,
    findTabByKind,
    removeConsoleTab,
    updateConsoleContent,
    setActiveConsole,
    clearAllConsoles,
    updateConsoleConnection,
    updateConsoleDatabase,
    updateConsoleFilePath,
    updateConsoleTitle,
    updateConsoleDirty,
    updateConsoleIcon,
    updateSavedState,
    getVersionManager,
    autoSaveConsole: autoSaveConsoleImpl,
    loadConsole: async (id: string, workspaceId: string) => {
      const existing = consoleTabs.find(t => t.id === id);
      if (existing) {
        setActiveConsole(id);
        return;
      }

      try {
        const res = await apiClient.get<{
          success: boolean;
          content: string;
          connectionId?: string;
          databaseId?: string;
          databaseName?: string;
          language?: string;
          id: string;
          path?: string;
          name?: string;
          isSaved?: boolean;
        }>(`/workspaces/${workspaceId}/consoles/content?id=${id}`);

        if (res.success) {
          const content = res.content || "";
          const filePath = res.path || res.name;
          addConsoleTab({
            id: res.id,
            title: res.name || res.path || "Console",
            content,
            isSaved: res.isSaved ?? !!filePath,
            connectionId: res.connectionId,
            databaseId: res.databaseId,
            databaseName: res.databaseName,
            filePath,
            kind: "console",
          });
          setActiveConsole(res.id);
        }
      } catch (e) {
        console.error("Failed to load console", e);
      }
    },
  };
};
