import { TypeCoercion } from "../SchemaMappingTable";

export interface DbFlowFormProps {
  flowId?: string;
  isNew?: boolean;
  onSave?: () => void;
  onSaved?: (flowId: string) => void;
  onCancel?: () => void;
}

/**
 * Ref interface for DbFlowForm - methods exposed to parent components and AI agent
 * Uses nested field paths matching the API structure (e.g., "schedule.cron", "databaseSource.query")
 */
export interface DbFlowFormRef {
  /** Get all current form values */
  getFormState(): Record<string, unknown>;
  /** Set a single form field using nested path (e.g., "schedule.cron", "databaseSource.query") */
  setField(path: string, value: unknown): void;
  /** Set multiple form fields at once using nested paths */
  setMultipleFields(fields: Record<string, unknown>): void;
  /** Trigger query validation */
  validateQuery(): Promise<void>;
  /** Set type coercions (column mappings) for schema transformation */
  setTypeCoercions(coercions: TypeCoercion[]): void;
  /** Get current type coercions */
  getTypeCoercions(): TypeCoercion[];
  /** Navigate to a specific step */
  goToStep(step: number): void;
  /** Get current step */
  getCurrentStep(): number;
}

/**
 * Form data structure - MATCHES the API/database structure exactly
 * Uses nested objects, no more flat fields!
 */
export interface FormData {
  databaseSource: {
    connectionId: string;
    database?: string;
    query: string;
  };
  tableDestination: {
    connectionId: string;
    database?: string;
    schema?: string;
    tableName: string;
    createIfNotExists: boolean;
  };
  schedule: {
    enabled: boolean;
    cron?: string;
    timezone: string;
  };
  syncMode: "full" | "incremental";
  batchSize: number;
  incrementalConfig?: {
    trackingColumn: string;
    trackingType: "timestamp" | "numeric";
  };
  conflictConfig?: {
    keyColumns: string[];
    strategy: "update" | "ignore" | "replace" | "upsert";
  };
  paginationConfig?: {
    mode: "offset" | "keyset";
    keysetColumn?: string;
    keysetDirection?: "asc" | "desc";
  };
  // Type coercions - same shape as database/API, no conversion needed
  typeCoercions: TypeCoercion[];
  schemaMappingConfirmed: boolean;
}

export const STEPS = [
  { label: "Source", description: "Configure source database and query" },
  {
    label: "Destination",
    description: "Configure destination database and table",
  },
  { label: "Schema Mapping", description: "Review and confirm column types" },
  {
    label: "Sync Mode",
    description: "Configure sync behavior and conflict handling",
  },
  {
    label: "Schedule",
    description: "Set up automatic sync schedule (optional)",
  },
];

/**
 * Default form values
 */
export const DEFAULT_FORM_VALUES: FormData = {
  databaseSource: {
    connectionId: "",
    database: "",
    query: "",
  },
  tableDestination: {
    connectionId: "",
    database: "",
    schema: "",
    tableName: "",
    createIfNotExists: true,
  },
  schedule: {
    enabled: false,
    cron: "0 * * * *",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  },
  syncMode: "full",
  batchSize: 2000,
  incrementalConfig: undefined,
  conflictConfig: undefined,
  paginationConfig: {
    mode: "offset",
    keysetColumn: "",
    keysetDirection: "asc",
  },
  typeCoercions: [],
  schemaMappingConfirmed: false,
};
