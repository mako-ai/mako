/**
 * Schema store types: connections, the explorer tree, autocomplete schemas
 * and the store surface.
 */
// ============================================================================
// Types
// ============================================================================

/** Database connection/server */
/** One principal allowed to write through a connection. */
export interface ConnectionWriter {
  /** `user:<id>` or `workflow:<name>`. */
  principal: string;
  /** Absent: anywhere. `schema` or `schema.table`. */
  where?: string | null;
  addedBy?: string | null;
  addedAt?: string | null;
}

/** Who wrote through a connection lately (last 30 days). */
export interface ConnectionRecentWriter {
  principal: string;
  count: number;
  lastAt: string;
  targets: string[];
  /** Places written lately that the list, as it is now, does not cover. */
  uncovered: string[];
}

export interface ConnectionWriters {
  writers: ConnectionWriter[];
  canEdit: boolean;
  recent: ConnectionRecentWriter[];
}

export interface Connection {
  id: string;
  connectionId?: string;
  name: string;
  description: string;
  database: string;
  databaseName?: string;
  type: string;
  active: boolean;
  lastConnectedAt?: string;
  isClusterMode?: boolean;
  isDemo?: boolean;
  /** True when served by the Mako Local Agent on this machine. */
  isLocal?: boolean;
  displayName: string;
  hostKey: string;
  hostName: string;
}

/** Tree node for databases, datasets, schemas, tables, etc. */
export interface TreeNode {
  id: string;
  label: string;
  kind: string;
  hasChildren?: boolean;
  icon?: string;
  metadata?: Record<string, unknown>;
}

export interface DatabaseCollectionInfo {
  name: string;
  type: string;
  options?: {
    capped?: boolean;
    [key: string]: unknown;
  };
  info?: unknown;
}

export interface DatabaseViewInfo {
  name: string;
  type: string;
  options: {
    viewOn?: string;
    pipeline?: unknown[];
    [key: string]: unknown;
  };
  info?: unknown;
}

/** Column information for autocomplete */
export interface ColumnInfo {
  name: string;
  type: string;
}

/** Autocomplete schema structure: dataset/schema -> table -> columns */
export type AutocompleteSchema = Record<string, Record<string, ColumnInfo[]>>;

// ============================================================================
// Store Types
// ============================================================================

export interface SchemaState {
  // === Data ===
  /** workspaceId -> Connection[] */
  connections: Record<string, Connection[]>;

  /** connectionId -> nodeKey -> TreeNode[] (tree structure) */
  treeNodes: Record<string, Record<string, TreeNode[]>>;

  /** connectionId -> AutocompleteSchema (pre-loaded full schema for smaller databases) */
  autocompleteSchemas: Record<string, AutocompleteSchema>;

  /** connectionId:schemaId:tableId -> ColumnInfo[] */
  columns: Record<string, ColumnInfo[]>;

  // === Loading/Error State ===
  loading: Record<string, boolean>;
  error: Record<string, string | null>;

  // === Ensure Methods (return cached or fetch) ===
  ensureConnections: (workspaceId: string) => Promise<Connection[]>;
  ensureTreeRoot: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<TreeNode[]>;
  ensureTreeChildren: (
    workspaceId: string,
    connectionId: string,
    node: { id: string; kind: string; metadata?: Record<string, unknown> },
  ) => Promise<TreeNode[]>;
  ensureAutocompleteSchema: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<AutocompleteSchema | null>;
  ensureColumns: (
    workspaceId: string,
    connectionId: string,
    schemaId: string,
    tableId: string,
  ) => Promise<ColumnInfo[]>;

  // === Refresh Methods (force re-fetch) ===
  refreshConnections: (workspaceId: string) => Promise<Connection[]>;
  /** Who may write through a connection (access/connection-writes.ts). */
  getConnectionWriters: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<ConnectionWriters>;
  setConnectionWriters: (
    workspaceId: string,
    connectionId: string,
    writers: { principal: string; where?: string }[],
  ) => Promise<void>;
  refreshTreeRoot: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<TreeNode[]>;
  refreshConnection: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<void>;

  // === Background Pre-loading ===
  preloadConnectionsAndDatabases: (workspaceId: string) => Promise<void>;

  // === Utility Methods ===
  getSchemaForAutocomplete: (connectionId: string) => AutocompleteSchema | null;
  clearConnectionData: (workspaceId: string) => void;
  deleteConnection: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<void>;
  /** Provision the onboarding demo database (throws on failure). */
  createDemoDatabase: (workspaceId: string) => Promise<void>;
  testConnection: (
    workspaceId: string,
    payload: {
      type: string;
      connection: Record<string, unknown>;
      /**
       * Set when testing an edit of a saved connection: the form holds
       * sentinels in place of its secrets, and the API resolves them from
       * the stored row.
       */
      connectionId?: string;
    },
    options?: { local?: boolean },
  ) => Promise<{ success: boolean; error?: string }>;
  fetchDatabase: (
    workspaceId: string,
    databaseId: string,
  ) => Promise<unknown | null>;
  saveDatabase: (
    workspaceId: string,
    payload: Record<string, unknown>,
    databaseId?: string,
    options?: { local?: boolean; verifyBeforeSave?: boolean },
  ) => Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
    // Set by the cloud API when verifyBeforeSave is requested: the connection
    // test ran before persisting.
    verified?: boolean;
    // "connection_test_failed" when verifyBeforeSave rejected the save because
    // the pre-save connection test did not succeed (record NOT created).
    code?: string;
  }>;
  fetchCollections: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<DatabaseCollectionInfo[]>;
  fetchCollectionInfo: (
    workspaceId: string,
    connectionId: string,
    collectionName: string,
  ) => Promise<unknown | null>;
  fetchViews: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<DatabaseViewInfo[]>;

  // === Console Template ===
  fetchConsoleTemplate: (
    workspaceId: string,
    connectionId: string,
    node?: { id: string; kind: string; metadata?: Record<string, unknown> },
  ) => Promise<{ language: string; template: string } | null>;

  // === Table Definition (DDL) ===
  fetchTableDefinition: (
    workspaceId: string,
    connectionId: string,
    params: { schema: string; table: string; database?: string },
  ) => Promise<{ definition?: string; error?: string }>;

  // === Table Existence Check ===
  checkTableExists: (
    workspaceId: string,
    connectionId: string,
    tableName: string,
    options?: { schema?: string; database?: string },
  ) => Promise<{
    exists: boolean;
    columns: Array<{ name: string; type: string; nullable?: boolean }>;
    supported?: boolean;
    error?: string;
  }>;
}

// ============================================================================
// Store Implementation
// ============================================================================
