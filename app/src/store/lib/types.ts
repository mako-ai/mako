/**
 * Shared Store Types
 *
 * Types used across multiple stores, extracted from the monolithic appStore.
 * These are the canonical definitions - do not duplicate elsewhere.
 */

/**
 * Console tab kinds
 */
export type TabKind =
  | "console"
  | "settings"
  | "connectors"
  | "members"
  | "flow-editor";

/**
 * Console access level
 */
export type ConsoleAccessLevel = "private" | "shared_read" | "shared_write";

/**
 * Console tab state
 */
export interface ConsoleTab {
  /** Client-generated ID, NEVER changes */
  id: string;
  /** Display title */
  title: string;
  /** Editor content */
  content: string;
  /** false = draft (auto-save enabled), true = saved (no auto-save) */
  isSaved: boolean;
  /** Hash of (content + connectionId + databaseId + databaseName) at last save */
  savedStateHash?: string;
  /** DatabaseConnection ID (MongoDB ObjectId) */
  connectionId?: string;
  /** Specific database ID (e.g., D1 UUID for cluster mode) */
  databaseId?: string;
  /** Human-readable database name (e.g., D1 database name) */
  databaseName?: string;
  /** Set after explicit save (display name in explorer) */
  filePath?: string;
  /** Tab type */
  kind?: TabKind;
  /** false/undefined = pristine (replaceable), true = dirty (persistent) */
  isDirty?: boolean;
  /** URL or path to icon, e.g., "/api/connectors/stripe/icon.svg" */
  icon?: string;
  /** Additional data for special tab types */
  metadata?: Record<string, unknown>;
  /** Access level: private, shared_read, shared_write */
  access?: ConsoleAccessLevel;
  /** User ID of the console owner */
  owner_id?: string;
  /** True if the current user can only read (not edit) this console */
  readOnly?: boolean;
}

/**
 * Chat session state
 */
export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  lastMessageAt?: Date;
  error?: string | null;
}

/**
 * Chat message
 */
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

/**
 * Left pane view options
 */
export type LeftPaneView =
  | "databases"
  | "consoles"
  | "connectors"
  | "flows"
  | "settings";

/**
 * Database explorer expanded state
 */
export interface DatabaseExplorerState {
  expandedServers: Set<string>;
  expandedDatabases: Set<string>;
  expandedCollectionGroups: Set<string>;
  expandedViewGroups: Set<string>;
  expandedNodes: Set<string>;
}

/**
 * Console explorer expanded state
 */
export interface ConsoleExplorerState {
  expandedFolders: Set<string>;
}

/**
 * View explorer expanded state
 */
export interface ViewExplorerState {
  expandedCollections: Set<string>;
}
