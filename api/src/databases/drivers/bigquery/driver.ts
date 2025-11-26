import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import { databaseConnectionService } from "../../../services/database-connection.service";

export class BigQueryDatabaseDriver implements DatabaseDriver {
  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "bigquery",
      displayName: "BigQuery",
      consoleLanguage: "sql",
    } as any;
  }

  async getTreeRoot(database: IDatabaseConnection): Promise<DatabaseTreeNode[]> {
    const datasets =
      await databaseConnectionService.listBigQueryDatasets(database);
    return datasets.map<DatabaseTreeNode>(ds => ({
      id: ds,
      label: ds,
      kind: "dataset",
      hasChildren: true,
      metadata: { datasetId: ds },
    }));
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    if (parent.kind !== "dataset") return [];
    const datasetId = parent.metadata?.datasetId || parent.id;
    const items = await databaseConnectionService.listBigQueryTables(
      database,
      datasetId,
    );
    const groups: Record<string, true> = {};
    for (const it of items) {
      const [, tableIdRaw] = it.name.split(".");
      const base = (tableIdRaw || "").replace(/_(\d{8})$/, "_");
      groups[base] = true;
    }
    return Object.keys(groups)
      .sort((a, b) => a.localeCompare(b))
      .map<DatabaseTreeNode>(base => ({
        id: `${datasetId}.${base}`,
        label: base,
        kind: "table",
        hasChildren: false,
        metadata: { datasetId, tableGroup: base },
      }));
  }

  async executeQuery(database: IDatabaseConnection, query: string, options?: any) {
    return databaseConnectionService.executeQuery(database, query, options);
  }
}
