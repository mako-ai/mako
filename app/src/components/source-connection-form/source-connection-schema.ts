/** `ws:acme` — a connector defined in the workspace repo (`connectors/acme/`). */
export const WORKSPACE_TYPE_PREFIX = "ws:";

export interface ConnectorFieldSchema {
  name: string;
  label: string;
  type:
    | "string"
    | "number"
    | "boolean"
    | "password"
    | "textarea"
    | "object_array"
    | "select";
  required?: boolean;
  default?: unknown;
  helperText?: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string | number | boolean }>;
  rows?: number;
  encrypted?: boolean;
  showIf?: {
    field: string;
    equals?: string | number | boolean | Array<string | number | boolean>;
    notEquals?: string | number | boolean | Array<string | number | boolean>;
  };
  itemFields?: ConnectorFieldSchema[];
}

export interface ConnectorSchemaResponse {
  fields: ConnectorFieldSchema[];
}

/**
 * Whether a top-level field's `showIf` holds. A field not filled in yet
 * counts as its schema default, so a cached schema (whose defaults were not
 * applied to the form) shows the same fields as a fresh one.
 */
export function isFieldShown(
  field: ConnectorFieldSchema,
  fields: ConnectorFieldSchema[],
  watch: (name: string) => unknown,
): boolean {
  if (!field.showIf) return true;
  const other = fields.find(f => f.name === field.showIf?.field);
  const value = watch(field.showIf.field) ?? other?.default;
  const { equals: eq, notEquals: ne } = field.showIf;
  const eqOk = Array.isArray(eq)
    ? eq.includes(value as string | number | boolean)
    : eq === undefined || value === eq;
  const neOk = Array.isArray(ne)
    ? !ne.includes(value as string | number | boolean)
    : ne === undefined || value !== ne;
  return eqOk && neOk;
}

export interface SourceConnectionFormProps {
  tabId?: string;
  variant?: "dialog" | "inline";
  open?: boolean;
  onClose?: () => void;
  onSubmit: (
    data: any,
  ) => void | Promise<{ success: boolean; isNew?: boolean } | void>;
  connector?: any | null;
  connectorTypes?: Array<{
    type: string;
    name: string;
    version: string;
    description: string;
    supportedEntities: string[];
  }>;
  errorMessage?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onTitleChange?: (title: string) => void;
}

export function generateDefaultValues(
  schema?: ConnectorSchemaResponse,
): Record<string, any> {
  if (!schema) return {};
  const defaults: Record<string, any> = {};
  schema.fields.forEach(f => {
    if (f.default !== undefined) {
      defaults[f.name] = f.default;
    } else if (f.type === "boolean") {
      defaults[f.name] = false;
    } else if (f.type === "object_array") {
      defaults[f.name] = [];
    } else {
      defaults[f.name] = "";
    }
  });
  return defaults;
}
