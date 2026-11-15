export interface SyncFlowFormProps {
  flowId?: string;
  isNew?: boolean;
  onSave?: () => void;
  onSaved?: (
    flowId: string,
    options?: { showBackfillPanel?: boolean; notice?: string },
  ) => void;
  onCancel?: () => void;
  /** New-sync flow only: user picked "Database query" as the source. */
  onSwitchToDbSync?: () => void;
}

export interface EntityLayoutConfig {
  entity: string;
  label?: string;
  partitionField: string;
  partitionGranularity: "day" | "hour" | "month" | "year";
  clusterFields: string[];
  enabled?: boolean;
}

export interface TransferQuery {
  name: string;
  query: string;
  data_path?: string;
  total_count_path?: string;
  has_next_page_path?: string;
  cursor_path?: string;
  batch_size?: number;
}

export interface TransferQueryField {
  name: keyof TransferQuery;
  label: string;
  type: "string" | "number" | "textarea";
  required?: boolean;
  default?: string | number;
  placeholder?: string;
  helperText?: string;
  rows?: number;
}

export interface FormData {
  dataSourceId: string;
  destinationDatabaseId: string;
  destinationDatabaseName?: string;
  tableDestination?: {
    tablePrefix?: string;
    schema?: string;
  };
  // Trigger set
  scheduleEnabled: boolean;
  scheduleCron: string;
  scheduleTimezone: string;
  webhookEnabled: boolean;
  webhookSecret?: string;
  // Sync configuration
  syncMode: "full" | "incremental";
  writeMode: "append_dedup" | "append" | "overwrite";
  deleteMode?: "hard" | "soft";
  backfillScheduleEnabled?: boolean;
  backfillScheduleCron?: string;
  backfillScheduleTimezone?: string;
  // Entities
  entityFilter: string[];
  entityLayouts?: EntityLayoutConfig[];
  queries: TransferQuery[];
}

export const SYNC_ENGINE_PERMISSION_ERROR =
  "The sync was saved, but changing the sync engine requires the workspace Owner or Admin role. Ask an admin to upgrade your role, then save again.";

export const SYSTEM_ENTITY_FIELDS = ["_syncedAt", "_dataSourceId", "id"];

export const CDC_CAPABLE_TYPES = [
  "bigquery",
  "postgresql",
  "clickhouse",
  "mongodb",
  "mysql",
];

/**
 * Airbyte-style per-entity incremental badge — mirrors backend
 * `IncrementalMode` (BaseConnector.getIncrementalCapabilities). Shown in the
 * Entities table regardless of the currently-selected Sync Mode so users can
 * see stream-level capability before deciding.
 */
export const INCREMENTAL_MODE_BADGE: Record<
  string,
  { label: string; color: "success" | "info" | "warning" | "default" }
> = {
  native: { label: "Incremental", color: "success" },
  "client-filter": { label: "Incremental (full scan)", color: "info" },
  "created-anchor": { label: "New records only", color: "warning" },
  none: { label: "Full re-pull only", color: "default" },
};

export const STEPS = [
  { label: "Source", description: "Where the data comes from" },
  { label: "Destination", description: "Where the data is written" },
  {
    label: "Sync Configuration",
    description: "Sync mode and delete behavior",
  },
  { label: "Entities", description: "What data is synced" },
  {
    label: "Triggers",
    description:
      "How the sync is triggered — schedule, webhook, or periodic reconcile",
  },
];
