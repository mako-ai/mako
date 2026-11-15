import type React from "react";
import type { ConsoleModification } from "../../hooks/useMonacoConsole";

export interface DatabaseConnection {
  id: string;
  connectionId?: string; // Optional for backward compatibility
  name: string;
  description: string;
  database: string;
  databaseName?: string;
  type: string;
  active: boolean;
  lastConnectedAt?: string;
  isClusterMode?: boolean; // Optional for backward compatibility
  displayName: string;
  hostKey: string;
  hostName: string;
}

export interface ConsoleProps {
  consoleId: string;
  initialContent: string;
  title?: string;
  onExecute: (
    content: string,
    connectionId?: string,
    databaseId?: string, // Sub-database ID for cluster mode (e.g., D1 UUID)
  ) => void;
  onCancel?: () => void;
  onSave?: (content: string, currentPath?: string) => Promise<boolean>;
  /** Save the current buffer as a NEW console at a chosen path (original untouched). */
  onSaveAsCopy?: (content: string) => void;
  /** Move/rename the current console to a new path. */
  onRenameMove?: (content: string, currentPath?: string) => void;
  isExecuting: boolean;
  isCancelling?: boolean;
  isSaving?: boolean;
  onContentChange?: (content: string) => void;
  databases?: DatabaseConnection[];
  // Current database selection (from store, single source of truth)
  connectionId?: string;
  databaseId?: string; // D1 database UUID for cluster mode
  databaseName?: string; // D1 database human-readable name for cluster mode
  // Callbacks for database changes
  onDatabaseChange?: (connectionId: string) => void;
  onDatabaseNameChange?: (
    databaseId: string | undefined,
    databaseName: string | undefined,
  ) => void;
  filePath?: string;
  /** Receives the History button, so a popover can anchor to it. */
  onHistoryClick?: (anchor: HTMLElement) => void;
  /**
   * When false, the history button is rendered but disabled (e.g. for
   * unsaved drafts that have no versions yet). Defaults to true so existing
   * callers that already gate via `onHistoryClick` keep working.
   */
  historyAvailable?: boolean;
  /** Opens the unified ShareDialog for this console. */
  onShareClick?: () => void;
  /** When false, the share button renders disabled (unsaved drafts). */
  shareAvailable?: boolean;
  enableVersionControl?: boolean;
  schedule?: {
    cron: string;
    timezone: string;
  };
  onCreateSchedule?: () => void;
  onUpdateSchedule?: () => void;
  /**
   * Surface this console UI is rendering. "console" (default) is a saved query
   * console; "data-source" reuses the same toolbar/editor for an app
   * data binding (run/save/connection are identical; callers supply
   * `headerExtras` for surface-specific controls like materialization).
   */
  variant?: "console" | "data-source";
  /** Extra controls rendered inline in the left toolbar group. */
  headerExtras?: React.ReactNode;
}

export interface ConsoleRef {
  getCurrentContent: () => {
    content: string;
    fileName?: string;
    language?: string;
  };
  applyModification: (modification: ConsoleModification) => void;
  /**
   * Quietly replace the editor content with the server-authoritative copy
   * (realtime sync). Unlike applyModification it does not fire
   * onContentChange (no dirty flag, no autosave echo), does not flash and
   * does not steal focus — the store is updated by the realtime layer.
   */
  setRemoteContent: (content: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  showDiff: (modification: ConsoleModification) => void;
  /**
   * Show an agent (modify_console) edit as a reviewable Accept/Reject diff.
   * The proposed content is the server-authoritative copy; the editor keeps
   * the pre-agent baseline until the user resolves the review.
   */
  showRemoteDiff: (proposedContent: string) => void;
  focus: () => void;
}
