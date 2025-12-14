import { IDatabaseConnection } from "../database/workspace-schema";

export interface DatabaseTreeNode {
  id: string;
  label: string;
  kind: string;
  hasChildren?: boolean;
  icon?: string; // optional icon key or inline svg name
  metadata?: any;
}

export interface DatabaseDriverMetadata {
  type: string;
  displayName: string;
  consoleLanguage: "sql" | "mongodb" | "javascript" | string;
  icon?: string;
}

export interface DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata;
  getTreeRoot(database: IDatabaseConnection): Promise<DatabaseTreeNode[]>;
  getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]>;
  executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: any,
  ): Promise<{
    success: boolean;
    data?: any;
    error?: string;
    rowCount?: number;
  }>;

  /**
   * Optional: cancel an in-flight query started via executeQuery that was provided an executionId.
   * Implementations should return { success: false, error: "Query not found or already completed" }
   * when the executionId is unknown.
   */
  cancelQuery?(
    executionId: string,
  ): Promise<{ success: boolean; error?: string }>;
}
