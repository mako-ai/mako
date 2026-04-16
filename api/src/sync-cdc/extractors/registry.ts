import type {
  IDatabaseConnection,
  IIncrementalConfig,
} from "../../database/workspace-schema";
import { BigQueryBulkExtractor } from "./bigquery";

export interface BulkExtraction {
  rows: AsyncIterable<Record<string, unknown>>;
  totalRows?: number;
  maxTrackingValue?: string | null;
  cleanup: () => Promise<void>;
}

export interface BulkExtractor {
  extract(params: {
    connection: IDatabaseConnection;
    query: string;
    syncMode: "full" | "incremental";
    incrementalConfig?: IIncrementalConfig;
    trackingColumn?: string;
  }): Promise<BulkExtraction>;
}

export function resolveBulkExtractor(
  sourceType: string,
): BulkExtractor | undefined {
  const normalized = sourceType.toLowerCase();
  switch (normalized) {
    case "bigquery":
      return new BigQueryBulkExtractor();
    default:
      return undefined;
  }
}
