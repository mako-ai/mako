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
import {
  MAKO_SYSTEM_FIELDS,
  type ConnectorEntitySchema,
  type ConnectorFieldSchema as EngineFieldSchema,
  type ConnectorLogicalType,
} from "../base/BaseConnector";

/**
 * A field in the credential form.
 *
 * Structurally the shape `app/src/components/ConnectorForm.tsx` renders and
 * `routes/source-connections.ts` encrypts by. Declared here rather than imported because
 * the API cannot import from the app.
 */
export interface FormFieldSchema {
  name: string;
  label: string;
  type:
    | "string"
    | "number"
    | "boolean"
    | "password"
    | "textarea"
    | "select"
    | "object_array";
  required?: boolean;
  default?: unknown;
  helperText?: string;
  placeholder?: string;
  options?: Array<{ label: string; value: string | number | boolean }>;
  rows?: number;
  encrypted?: boolean;
  /** The fields of one item, for an `object_array`. */
  itemFields?: FormFieldSchema[];
  /** Shown only while the sibling `field` holds one of `equals`. */
  showIf?: { field: string; equals: unknown[] };
}

export interface FormSchema {
  fields: FormFieldSchema[];
  /**
   * The flow form's query list, for a connector whose entities are each
   * flow's own queries (`spec.mako.queryEntities.source: "flow"`), in the
   * shape the GraphQL folder's query form has.
   */
  transferQueries?: {
    label: string;
    required: boolean;
    fields: FormFieldSchema[];
  };
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
  if (!connectionSpecification || typeof connectionSpecification !== "object") {
    throw new Error(
      "The connector's spec has no `connectionSpecification`, so its secret " +
        "fields cannot be identified. Refusing to build a credential form " +
        "that would store every value in plaintext.",
    );
  }
  const properties = connectionSpecification.properties;
  // `properties: {}` is legitimate — a connector that needs no credential —
  // and yields an empty form with nothing to encrypt. A MISSING or unreadable
  // `properties` is not: it is indistinguishable from a spec whose fields
  // failed to parse, and answering it with an empty field list is what stores
  // an API key unencrypted.
  if (properties === undefined || properties === null) {
    throw new Error(
      "The connector's `connectionSpecification` has no `properties`. " +
        "Declare `config: { required, properties }` in defineConnector; an " +
        "absent field list cannot be told apart from an unreadable one.",
    );
  }
  if (typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error(
      "`connectionSpecification.properties` must be an object mapping field " +
        "names to their JSON Schema.",
    );
  }
  const required = new Set<string>(
    Array.isArray(connectionSpecification?.required)
      ? connectionSpecification.required
      : [],
  );

  return { fields: propertiesToFields(properties, required) };
}

/**
 * A whole spec -> the form schema the API serves: the credential form, plus
 * `transferQueries` when the connector's entities are each flow's queries.
 */
export function specToForm(spec: JsonSchema | undefined): FormSchema {
  const form = connectionSpecificationToForm(spec?.connectionSpecification);
  const queries = spec?.mako?.queryEntities;
  if (queries?.source === "flow" && queries.form?.items?.properties) {
    const items = queries.form.items;
    form.transferQueries = {
      label: String(queries.form.label ?? "Queries"),
      required: queries.form.required === true,
      fields: propertiesToFields(
        items.properties,
        new Set(Array.isArray(items.required) ? items.required : []),
      ),
    };
  }
  return form;
}

/** JSON Schema properties -> form fields, in `order`, then declaration order. */
function propertiesToFields(
  properties: Record<string, JsonSchema>,
  required: Set<string>,
): FormFieldSchema[] {
  const entries = Object.entries(properties);
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
    if (property?.multiline === true) {
      field.rows =
        typeof property.rows === "number" && property.rows > 0
          ? property.rows
          : 4;
    }
    if (secret) field.encrypted = true;
    // A field shown only while another has a value (REST's request body).
    if (property?.showIf && typeof property.showIf === "object") {
      field.showIf = property.showIf;
    }
    if (field.type === "object_array") {
      const items = property.items ?? {};
      field.itemFields = propertiesToFields(
        (items.properties ?? {}) as Record<string, JsonSchema>,
        new Set(Array.isArray(items.required) ? items.required : []),
      );
    }
    fields.push(field);
  }
  return fields;
}

function formFieldType(
  property: JsonSchema,
  secret: boolean,
): FormFieldSchema["type"] {
  // A multi-line secret (a service-account JSON, a headers object) is an
  // encrypted textarea: `encrypted` decides encryption, the type only how
  // it is typed in.
  if (secret) return property?.multiline === true ? "textarea" : "password";
  if (Array.isArray(property?.enum)) return "select";
  if (
    normalizeType(property?.type) === "array" &&
    normalizeType(property?.items?.type) === "object"
  ) {
    return "object_array";
  }
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
 *
 * Mako's 8 system columns (`_syncedAt`, `is_deleted`, `deleted_at`, the
 * `_mako_*` ordering columns, the data source id and name) are merged in, as
 * every in-process connector's schema spreads `MAKO_SYSTEM_FIELDS`. A
 * connector cannot declare them over the wire, and without them a boxed run
 * landed `_syncedAt` as a string and left `is_deleted` unset. A stream field
 * with a system column's name is overridden, as in-process.
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
  for (const [name, field] of Object.entries(MAKO_SYSTEM_FIELDS)) {
    fields[name] = { ...field };
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
