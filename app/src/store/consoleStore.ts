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
  | "sync-job-editor";

// Store version managers for each console tab
const versionManagers = new Map<string, ConsoleVersionManager>();

// Selector helpers
const selectConsoleState = (state: any) => state.consoles;

export const useConsoleStore = () => {
  const dispatch = useAppDispatch();
  const { tabs, activeTabId } = useAppStore(selectConsoleState);

  // Helper: convert Record to array for backward compatibility
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
    databaseId: string,
    query: string,
    options?: Record<string, any>,
  ): Promise<{ success: boolean; data?: any; error?: string }> => {
    try {
      const res = await apiClient.post<{
        success: boolean;
        data: any;
        error?: string;
      }>(`/workspaces/${workspaceId}/databases/${databaseId}/execute`, {
        query,
        options,
      });
      return res.success
        ? { success: true, data: (res as any).data }
        : { success: false, error: (res as any).error || "Execution failed" };
    } catch (e: any) {
      return { success: false, error: e?.message || "Execution failed" };
    }
  };

  const saveConsole = async (
    workspaceId: string,
    tabId: string,
    content: string,
    currentPath?: string,
    connectionId?: string,
    databaseName?: string,
    isNew?: boolean,
  ): Promise<{
    success: boolean;
    path?: string;
    id?: string;
    error?: string;
  }> => {
    try {
      let path = currentPath;
      const method: "POST" | "PUT" = isNew ? "POST" : "PUT";
      let endpoint: string;
      if (!path) {
        // Caller should prompt for file name before invoking this in UI
        return { success: false, error: "Missing path" };
      }
      // Remove .js extension if present as backend doesn't expect it
      if (path.endsWith(".js")) {
        path = path.slice(0, -3);
      }

      if (method === "POST") {
        endpoint = `/workspaces/${workspaceId}/consoles`;
      } else {
        endpoint = `/workspaces/${workspaceId}/consoles/${path}`;
      }

      if (method === "POST") {
        const res = await apiClient.post<{
          success: boolean;
          data?: { id: string };
          error?: string;
        }>(endpoint, {
          id: tabId,
          path,
          content,
          connectionId,
          databaseName,
        });
        return res.success
          ? { success: true, path, id: (res as any).data?.id }
          : { success: false, error: (res as any).error || "Save failed" };
      } else {
        const res = await apiClient.put<{
          success: boolean;
          data?: any;
          error?: string;
        }>(endpoint, { content, connectionId, databaseName });
        return res.success
          ? { success: true, path }
          : { success: false, error: (res as any).error || "Save failed" };
      }
    } catch (e: any) {
      return { success: false, error: e?.message || "Save failed" };
    }
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
    updateConsoleFilePath,
    updateConsoleTitle,
    updateConsoleDirty,
    updateConsoleIcon,
    getVersionManager,
    executeQuery: executeQuery,
    saveConsole: saveConsole,
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
            connectionId: res.connectionId || res.databaseId,
            databaseId: res.databaseId, // For backward compatibility
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
    updateConsoleFilePath,
    updateConsoleTitle,
    updateConsoleDirty,
    updateConsoleIcon,
    getVersionManager,
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
            connectionId: res.connectionId || res.databaseId,
            databaseId: res.databaseId, // For backward compatibility
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
