import type { ConnectorLogicalType } from "./BaseConnector";

export interface OutboundFieldSchema {
  type: ConnectorLogicalType;
  required?: boolean;
  writable: boolean;
  label?: string;
  enumValues?: { value: string; label: string }[];
}

export interface OutboundEntitySchema {
  entity: string;
  fields: Record<string, OutboundFieldSchema>;
  matchableFields: string[];
}

export interface OutboundFieldDiff {
  field: string;
  before: unknown;
  after: unknown;
  willOverwrite: boolean;
}

export interface OutboundRejectedField {
  field: string;
  reason: string;
}

export interface OutboundWriteOutcome {
  sourcePk: string;
  status: "created" | "updated" | "skipped" | "failed" | "ambiguous";
  remoteId?: string;
  fieldDiffs?: OutboundFieldDiff[];
  rejectedFields?: OutboundRejectedField[];
  matchCount?: number;
  retryable?: boolean;
  error?: string;
}

export interface OutboundConnector {
  supportsOutbound(): boolean;
  resolveOutboundSchema(entity: string): Promise<OutboundEntitySchema>;
  writeBatch(params: {
    entity: string;
    records: {
      sourcePk: string;
      payload: Record<string, unknown>;
      remoteId?: string;
    }[];
    writeMode: "create" | "update" | "upsert";
    updateFieldStrategy: "overwrite" | "fill_empty" | "ignore";
    match: {
      lookupColumn: string;
      remoteField: string;
      onMultiple: "skip" | "update_first" | "fail";
    };
    dryRun: boolean;
  }): Promise<{ results: OutboundWriteOutcome[] }>;
}

export function isOutboundConnector(
  connector: unknown,
): connector is OutboundConnector {
  return (
    typeof connector === "object" &&
    connector !== null &&
    typeof (connector as OutboundConnector).supportsOutbound === "function" &&
    typeof (connector as OutboundConnector).resolveOutboundSchema ===
      "function" &&
    typeof (connector as OutboundConnector).writeBatch === "function" &&
    (connector as OutboundConnector).supportsOutbound()
  );
}
