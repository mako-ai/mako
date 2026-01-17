import { useMemo } from "react";
import { useAppStore, useAppDispatch, ConsoleTab } from "./appStore";
import { apiClient } from "../lib/api-client";
import { generateObjectId } from "../utils/objectId";
import { ConsoleVersionManager } from "../utils/ConsoleVersionManager";
import { hashContent } from "../utils/hash";

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
 * Auto-save console content (debounced).
 * Shared implementation used by both hook and getState() versions.
 * Saves draft consoles to the database so they can be restored when
 * opening a chat from history.
 *
 * Called from three places in Console.tsx:
 * 1. handleEditorChange - user typing in editor
 * 2. acceptChanges - user accepts AI-suggested diff
 * 3. handleEditorDidMount - console created with content (e.g., by agent)
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

  // Skip if content hasn't changed since last save (avoid redundant API calls)
  const contentHash = hashContent(content);
  if (lastSavedContentHash.get(consoleId) === contentHash) {
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
    try {
      await apiClient.put(`/workspaces/${workspaceId}/consoles/${consoleId}`, {
        content,
        title,
        connectionId,
        databaseId,
        databaseName,
      });
      // Track successful save to avoid redundant future saves
      lastSavedContentHash.set(consoleId, contentHash);
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
    tab: Omit<ConsoleTab, "id"> & { id?: string },
  ): string => {
    const id = tab.id || generateObjectId(); // Use provided ID or generate new MongoDB ObjectId

    // Create version manager for console tabs
    if (tab.kind === undefined || tab.kind === "console") {
      versionManagers.set(id, new ConsoleVersionManager(id));
    }

    // Compute dbContentHash if content is provided (e.g., when loading from DB)
    const content = tab.content || tab.initialContent;
    const dbContentHash = tab.filePath ? hashContent(content) : undefined;

    dispatch({
      type: "OPEN_CONSOLE_TAB",
      payload: {
        id,
        title: tab.title,
        content,
        initialContent: tab.initialContent,
        dbContentHash,
        connectionId: tab.connectionId,
        databaseId: tab.databaseId,
        databaseName: tab.databaseName,
        filePath: tab.filePath,
        kind: (tab as any).kind || "console",
        icon: tab.icon,
        metadata: tab.metadata,
      },
    } as any);
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

    dispatch({ type: "CLOSE_CONSOLE_TAB", payload: { id } } as any);
  };

  const setActiveConsole = (id: string | null) =>
    dispatch({ type: "FOCUS_CONSOLE_TAB", payload: { id } } as any);

  const updateConsoleContent = (id: string, content: string) =>
    dispatch({
      type: "UPDATE_CONSOLE_CONTENT",
      payload: { id, content },
    } as any);

  const findTabByKind = (kind: TabKind) =>
    consoleTabs.find((t: any) => (t as any).kind === kind);

  const updateConsoleConnection = (id: string, connectionId?: string) => {
    dispatch({
      type: "UPDATE_CONSOLE_CONNECTION",
      payload: { id, connectionId },
    } as any);
  };

  const updateConsoleDatabase = (
    id: string,
    databaseId?: string,
    databaseName?: string,
  ) => {
    dispatch({
      type: "UPDATE_CONSOLE_DATABASE",
      payload: { id, databaseId, databaseName },
    } as any);
  };

  const updateConsoleFilePath = (id: string, filePath: string) => {
    dispatch({
      type: "UPDATE_CONSOLE_FILE_PATH",
      payload: { id, filePath },
    } as any);
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

  const updateConsoleSavedDatabase = (
    id: string,
    connectionId?: string,
    databaseId?: string,
    databaseName?: string,
  ) => {
    dispatch({
      type: "UPDATE_CONSOLE_SAVED_DATABASE",
      payload: { id, connectionId, databaseId, databaseName },
    } as any);
  };

  /**
   * Update initialContent to match current content after a successful save.
   * This resets the "unsaved changes" baseline so hasUnsavedChanges() returns
   * false until the user makes new edits.
   */
  const updateConsoleInitialContent = (id: string, initialContent: string) => {
    dispatch({
      type: "UPDATE_CONSOLE_INITIAL_CONTENT",
      payload: { id, initialContent },
    });
  };

  /**
   * Replace a tab's ID with a new ID.
   * Used when overwriting an existing console during conflict resolution.
   * This ensures future saves go to the correct console.
   */
  const replaceTabId = (oldId: string, newId: string) => {
    // IMPORTANT: Cancel any pending auto-save for newId FIRST.
    // If the user had the existing console open with unsaved edits, its auto-save
    // timer would still be running. Without canceling it, the timer would fire
    // ~2 seconds later and save the OLD content, silently undoing the user's
    // intentional overwrite. This race condition causes data loss.
    cancelAutoSave(newId);

    // Clean up version manager for newId if it exists (user had both tabs open)
    const existingVersionManager = versionManagers.get(newId);
    if (existingVersionManager) {
      existingVersionManager.cleanup();
      versionManagers.delete(newId);
    }

    // Transfer version manager from oldId to newId
    const versionManager = versionManagers.get(oldId);
    if (versionManager) {
      versionManagers.delete(oldId);
      versionManagers.set(newId, versionManager);
    }

    // Transfer auto-save state from oldId to newId
    const timer = draftSaveTimers.get(oldId);
    if (timer) {
      clearTimeout(timer);
      draftSaveTimers.delete(oldId);
    }
    const contentHash = lastSavedContentHash.get(oldId);
    if (contentHash) {
      lastSavedContentHash.delete(oldId);
      lastSavedContentHash.set(newId, contentHash);
    }

    // Update the store
    dispatch({
      type: "REPLACE_TAB_ID",
      payload: { oldId, newId },
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

  const saveConsole = async (
    workspaceId: string,
    tabId: string,
    content: string,
    currentPath?: string,
    connectionId?: string,
    databaseName?: string,
    databaseId?: string,
    isNew?: boolean,
  ): Promise<{
    success: boolean;
    path?: string;
    id?: string;
    error?: string;
    conflict?: {
      existingId: string;
      existingContent: string;
      existingName: string;
      existingLanguage?: "sql" | "javascript" | "mongodb";
      path: string;
    };
  }> => {
    try {
      let path = currentPath;
      if (!path) {
        // Caller should prompt for file name before invoking this in UI
        return { success: false, error: "Missing path" };
      }
      // Remove .js extension if present as backend doesn't expect it
      if (path.endsWith(".js")) {
        path = path.slice(0, -3);
      }

      if (isNew) {
        // POST - create new console (may return conflict if path exists)
        const response = await fetch(
          `/api/workspaces/${workspaceId}/consoles`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              id: tabId,
              path,
              content,
              connectionId,
              databaseName,
              databaseId,
            }),
          },
        );

        const res = await response.json();

        // Handle conflict (409) - return conflict data for UI to handle
        if (
          response.status === 409 &&
          res.error === "conflict" &&
          res.conflict
        ) {
          return { success: false, error: "conflict", conflict: res.conflict };
        }

        if (!response.ok) {
          return { success: false, error: res.error || "Save failed" };
        }

        return res.success
          ? { success: true, path, id: res.data?.id }
          : { success: false, error: res.error || "Save failed" };
      } else {
        // PUT - update existing console by ID
        const res = await apiClient.put<{
          success: boolean;
          data?: any;
          error?: string;
        }>(`/workspaces/${workspaceId}/consoles/${tabId}`, {
          content,
          connectionId,
          databaseName,
          databaseId,
        });
        return res.success
          ? { success: true, path }
          : { success: false, error: res.error || "Save failed" };
      }
    } catch (e: any) {
      return { success: false, error: e?.message || "Save failed" };
    }
  };

  /**
   * Check if a tab has unsaved local changes.
   * Returns true if the tab exists and has content different from initialContent.
   */
  const hasUnsavedChanges = (tabId: string): boolean => {
    const tab = tabs[tabId];
    if (!tab) return false;
    // Compare current content with initial content (content when tab was opened)
    return tab.content !== tab.initialContent;
  };

  /**
   * Get a tab by ID. Returns undefined if the tab doesn't exist.
   */
  const getTabById = (tabId: string): ConsoleTab | undefined => {
    return tabs[tabId];
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
    updateConsoleSavedDatabase,
    updateConsoleInitialContent,
    updateConsoleFilePath,
    updateConsoleTitle,
    updateConsoleDirty,
    updateConsoleIcon,
    getVersionManager,
    executeQuery,
    cancelQuery,
    saveConsole,
    replaceTabId,
    hasUnsavedChanges,
    getTabById,
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
          databaseId?: string; // Backward compatibility
          databaseName?: string;
          language?: string;
          id: string;
          path?: string;
          name?: string;
        }>(`/workspaces/${workspaceId}/consoles/content?id=${id}`);

        if (res.success) {
          addConsoleTab({
            id: res.id, // Should match requested ID
            title: res.name || res.path || "Console",
            content: res.content || "",
            initialContent: res.content || "",
            connectionId: res.connectionId,
            databaseId: res.databaseId,
            databaseName: res.databaseName,
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
    tab: Omit<ConsoleTab, "id"> & { id?: string },
  ): string => {
    const id = tab.id || generateObjectId(); // Use provided ID or generate new MongoDB ObjectId

    // Create version manager for console tabs
    if (tab.kind === undefined || tab.kind === "console") {
      versionManagers.set(id, new ConsoleVersionManager(id));
    }

    // Compute dbContentHash if content is provided (e.g., when loading from DB)
    const content = tab.content || tab.initialContent;
    const dbContentHash = tab.filePath ? hashContent(content) : undefined;

    dispatch({
      type: "OPEN_CONSOLE_TAB",
      payload: {
        id,
        title: tab.title,
        content,
        initialContent: tab.initialContent,
        dbContentHash,
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
    } as any);
  };

  const updateConsoleDatabase = (
    id: string,
    databaseId?: string,
    databaseName?: string,
  ) => {
    dispatch({
      type: "UPDATE_CONSOLE_DATABASE",
      payload: { id, databaseId, databaseName },
    } as any);
  };

  const updateConsoleFilePath = (id: string, filePath: string) => {
    dispatch({
      type: "UPDATE_CONSOLE_FILE_PATH",
      payload: { id, filePath },
    } as any);
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

  const updateConsoleSavedDatabase = (
    id: string,
    connectionId?: string,
    databaseId?: string,
    databaseName?: string,
  ) => {
    dispatch({
      type: "UPDATE_CONSOLE_SAVED_DATABASE",
      payload: { id, connectionId, databaseId, databaseName },
    } as any);
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
    activeConsoleId: activeTabId,
    addConsoleTab,
    findTabByKind,
    removeConsoleTab,
    updateConsoleContent,
    setActiveConsole,
    clearAllConsoles,
    updateConsoleConnection,
    updateConsoleDatabase,
    updateConsoleSavedDatabase,
    updateConsoleFilePath,
    updateConsoleTitle,
    updateConsoleDirty,
    updateConsoleIcon,
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
          databaseId?: string; // Backward compatibility
          databaseName?: string;
          language?: string;
          id: string;
          path?: string;
          name?: string;
        }>(`/workspaces/${workspaceId}/consoles/content?id=${id}`);

        if (res.success) {
          addConsoleTab({
            id: res.id,
            title: res.name || res.path || "Console",
            content: res.content || "",
            initialContent: res.content || "",
            connectionId: res.connectionId,
            databaseId: res.databaseId,
            databaseName: res.databaseName,
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
