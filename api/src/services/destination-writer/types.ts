/**
 * The destination writer's configuration, write options/results, and the
 * resumable chunk state of a database-source sync.
 */
import type { Db } from "mongodb";
import type {
  ITableDestination,
  ITypeCoercion,
} from "../../database/workspace-schema";
import type { ColumnDefinition } from "../../databases/driver";
import type { CursorValue, CursorValueType } from "../db-sync-pagination";

export interface DestinationConfig {
  // For MongoDB collections
  mongoDb?: Db;
  collectionName?: string;

  // For SQL tables
  tableDestination?: ITableDestination;

  // Common
  /** The flow's workspace: the destination is looked up in it only. */
  workspaceId: string;
  dataSourceId?: string;
  dataSourceName?: string;

  // Delete mode for connector webhook flows
  deleteMode?: "hard" | "soft";
}

export interface WriteOptions {
  // For upsert operations
  keyColumns?: string[];
  conflictStrategy?: "update" | "ignore" | "replace";

  // For full sync with staging
  useStaging?: boolean;
  stagingTableName?: string;

  // Type coercions to apply during table creation (overrides inferred types)
  typeCoercions?: ITypeCoercion[];

  // Pre-fetched schema from source database (more reliable than inferring from data)
  sourceSchema?: ColumnDefinition[];
}

export interface WriteResult {
  success: boolean;
  rowsWritten: number;
  error?: string;
}

/**
 * State for resumable chunked execution
 */
export interface DbSyncChunkState {
  offset: number;
  totalProcessed: number;
  hasMore: boolean;
  lastTrackingValue?: string;
  lastKeysetValue?: string; // For keyset pagination
  /** JS type `lastKeysetValue` was read as, so "00123" stays a string. */
  lastKeysetValueType?: CursorValueType;
  /** Key-column values of the last row: the keyset tiebreaker. */
  lastKeysetTiebreaker?: CursorValue[];
  estimatedTotal?: number;
  stagingPrepared?: boolean;
  sourceSchema?: ColumnDefinition[]; // Cached schema from source query (fetched once)
}

/**
 * Result of a single chunk execution
 */
export interface DbSyncChunkResult {
  state: DbSyncChunkState;
  rowsProcessed: number;
  completed: boolean;
  error?: string;
}
