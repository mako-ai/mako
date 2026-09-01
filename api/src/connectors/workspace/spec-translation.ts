/**
 * Two translations between the wire and the engine.
 *
 * The wire is JSON Schema (a connector's `spec` describes its config, its
 * `discover` describes each stream). The engine speaks two older, narrower
 * vocabularies: the form schema the credential UI renders, and
 * `ConnectorEntitySchema`, whose logical types every destination adapter
 * already knows how to write. Neither of those changes here — a sandboxed
 * connector has to arrive speaking them, or nothing downstream would work.
 */
import type {
  ConnectorEntitySchema,
  ConnectorFieldSchema as EngineFieldSchema,
  ConnectorLogicalType,
} from "../base/BaseConnector";

/**
 * A field in the credential form.
 *
 * Structurally the shape `app/src/components/ConnectorForm.tsx` renders and
 * `routes/sources.ts` encrypts by. Declared here rather than imported because
 * the API cannot import from the app.
 */
export interface FormFieldSchema {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "password" | "textarea" | "select";
  required?: boolean;
  default?: unknown;
  helperText?: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string | number | boolean }>;
  rows?: number;
  encrypted?: boolean;
}

export interface FormSchema {
  fields: FormFieldSchema[];
}

type JsonSchema = Record<string, any>;

/**
 * A label for a field whose spec gives no title.
 *
 * Sentence case, consistently: `api_base_url` and `maxRetries` must not come
 * out as "Api base url" and "Max Retries" in the same form, which is what
 * splitting without normalising produces.
 */
const titleCase = (name: string): string =>
  name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^./, c => c.toUpperCase());

/**
 * `spec.connectionSpecification` -> the credential form.
 *
 * This is what makes a workspace connector usable at all: without it there is
 * no way to type an API key. `airbyte_secret` is the flag that decides
 * encryption, so getting it wrong stores a credential in plaintext — which is
 * why an unreadable spec must produce an error, never an empty field list.
 */
export function connectionSpecificationToForm(
  connectionSpecification: JsonSchema | undefined,
): FormSchema {
  const properties = connectionSpecification?.properties;
  if (!properties || typeof properties !== "object") {
    return { fields: [] };
  }
  const required = new Set<string>(
    Array.isArray(connectionSpecification?.required)
      ? connectionSpecification.required
      : [],
  );

  const entries = Object.entries(properties as Record<string, JsonSchema>);
  // `order` is how a spec author controls the form; falling back to
  // declaration order keeps a spec without it stable rather than alphabetised.
  entries.sort(([, a], [, b]) => {
    const orderA =
      typeof a?.order === "number" ? a.order : Number.MAX_SAFE_INTEGER;
    const orderB =
      typeof b?.order === "number" ? b.order : Number.MAX_SAFE_INTEGER;
    return orderA - orderB;
  });

  const fields: FormFieldSchema[] = [];
  for (const [name, property] of entries) {
    const secret =
      property?.airbyte_secret === true || property?.secret === true;
    const field: FormFieldSchema = {
      name,
      label: property?.title ? String(property.title) : titleCase(name),
      type: formFieldType(property, secret),
      required: required.has(name),
    };
    if (property?.description) field.helperText = String(property.description);
    if (property?.default !== undefined) field.default = property.default;
    if (Array.isArray(property?.examples) && property.examples.length > 0) {
      field.placeholder = String(property.examples[0]);
    }
    if (Array.isArray(property?.enum)) {
      field.options = property.enum.map((value: string | number | boolean) => ({
        label: String(value),
        value,
      }));
    }
    if (property?.multiline === true) field.rows = 4;
    if (secret) field.encrypted = true;
    fields.push(field);
  }
  return { fields };
}

function formFieldType(
  property: JsonSchema,
  secret: boolean,
): FormFieldSchema["type"] {
  if (secret) return "password";
  if (Array.isArray(property?.enum)) return "select";
  if (property?.multiline === true) return "textarea";
  const type = normalizeType(property?.type);
  if (type === "boolean") return "boolean";
  if (type === "integer" || type === "number") return "number";
  return "string";
}

/** JSON Schema allows `type: ["null", "string"]`; the meaningful one is wanted. */
function normalizeType(type: unknown): string | undefined {
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    return type.find(t => t !== "null") as string | undefined;
  }
  return undefined;
}

/**
 * A stream's `json_schema` -> the engine's typed entity schema.
 *
 * `unknownFieldPolicy: "string"` is not a default chosen for convenience. A
 * large share of real connector catalogs declare `additionalProperties: true`
 * or no properties at all, and a stream that arrives with fields the schema
 * never mentioned must land as columns rather than fail the sync.
 */
export function jsonSchemaToEntitySchema(
  entity: string,
  stream: JsonSchema | undefined,
): ConnectorEntitySchema {
  const jsonSchema = stream?.json_schema ?? {};
  const properties = (jsonSchema?.properties ?? {}) as Record<
    string,
    JsonSchema
  >;
  const required = new Set<string>(
    Array.isArray(jsonSchema?.required) ? jsonSchema.required : [],
  );

  const fields: Record<string, EngineFieldSchema> = {};
  for (const [name, property] of Object.entries(properties)) {
    fields[name] = {
      type: logicalType(property),
      nullable: isNullable(property, required.has(name)),
      required: required.has(name),
    };
  }

  return {
    entity,
    fields,
    unknownFieldPolicy: "string",
    keyColumns: primaryKeyOf(stream),
  };
}

/** Airbyte's key is an array of paths; Mako's is an array of column names. */
export function primaryKeyOf(
  stream: JsonSchema | undefined,
): string[] | undefined {
  const key = stream?.source_defined_primary_key ?? stream?.primary_key;
  if (!Array.isArray(key) || key.length === 0) return undefined;
  const columns = key
    .map((path: unknown) =>
      Array.isArray(path) ? path[path.length - 1] : path,
    )
    .filter((column: unknown): column is string => typeof column === "string");
  return columns.length > 0 ? columns : undefined;
}

export function logicalType(
  property: JsonSchema | undefined,
): ConnectorLogicalType {
  const type = normalizeType(property?.type);
  const format = property?.format;
  // A date-time string is a timestamp to every destination adapter; leaving it
  // a string is how a warehouse ends up unable to partition by it.
  if (type === "string" && (format === "date-time" || format === "date")) {
    return "timestamp";
  }
  if (type === "integer") return "integer";
  if (type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "object" || type === "array") return "json";
  if (type === "string") return "string";
  // No usable type: `{}` means "anything" in JSON Schema, and json is the only
  // logical type that can hold anything without losing it.
  return "json";
}

function isNullable(
  property: JsonSchema | undefined,
  required: boolean,
): boolean {
  const type = property?.type;
  if (Array.isArray(type)) return type.includes("null");
  return !required;
}
