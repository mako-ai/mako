/**
 * Deterministic tool-call input repair for the agent chat loop.
 *
 * Some models (and some provider gateways) emit tool-call arguments with
 * nested values JSON-STRINGIFIED instead of inline — e.g.
 *
 *   { "commands": "[\"build --select tag:nightly\"]" }   // array as a string
 *   { "prNumber": "42" }                                 // number as a string
 *   { "enabled": "true" }                                // boolean as a string
 *
 * The AI SDK validates inputs against each tool's zod schema, so these calls
 * fail with InvalidToolInputError and the tool never runs — the model retries
 * with the same encoding and the turn dead-ends (observed on dbt_create_job's
 * `commands` array and the PR tools' `prNumber`).
 *
 * `repairStringifiedToolInputs` plugs into streamText's
 * `experimental_repairToolCall` hook and fixes this WITHOUT a second LLM
 * call: it walks the tool's JSON Schema and, wherever the schema expects an
 * array/object but got a string, parses it; numeric/boolean strings are
 * coerced likewise. The repaired call is re-validated by the SDK through the
 * normal path, so this can never bypass schema validation — if the repaired
 * input is still invalid the original error surfaces as before.
 */

import {
  NoSuchToolError,
  type JSONSchema7,
  type ToolCallRepairFunction,
  type ToolSet,
} from "ai";
import { loggers } from "../logging";

const logger = loggers.agent();

/** Subset of JSON Schema we walk; `true`/`false` schemas carry no type info. */
type SchemaNode = JSONSchema7 | boolean | undefined;

function schemaTypes(schema: SchemaNode): string[] {
  if (schema === undefined || typeof schema === "boolean") return [];
  if (Array.isArray(schema.type)) return schema.type;
  return schema.type ? [schema.type] : [];
}

function subSchemas(schema: SchemaNode): JSONSchema7[] {
  if (schema === undefined || typeof schema === "boolean") return [];
  const variants = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ];
  return variants.filter(
    (variant): variant is JSONSchema7 => typeof variant === "object",
  );
}

function expectsType(schema: SchemaNode, type: string): boolean {
  if (schemaTypes(schema).includes(type)) return true;
  return subSchemas(schema).some(variant => expectsType(variant, type));
}

/** Find the anyOf/oneOf/allOf variant that declares the wanted type, if any. */
function variantOfType(schema: SchemaNode, type: string): SchemaNode {
  if (schemaTypes(schema).includes(type)) return schema;
  return subSchemas(schema).find(variant => expectsType(variant, type));
}

function tryParseJson(text: string): { ok: boolean; value?: unknown } {
  const trimmed = text.trim();
  // Cheap guard: only attempt on things that even look like JSON containers.
  if (!/^[[{]/.test(trimmed)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Recursively coerce `value` toward what `schema` expects. Only performs
 * unambiguous, lossless conversions (string → parsed JSON container, numeric
 * string → number, "true"/"false" → boolean); anything else is returned
 * unchanged and left to normal schema validation.
 */
export function coerceValueToSchema(
  value: unknown,
  schema: SchemaNode,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (expectsType(schema, "array") || expectsType(schema, "object")) {
      const parsed = tryParseJson(value);
      if (parsed.ok && Array.isArray(parsed.value)) {
        return coerceValueToSchema(parsed.value, variantOfType(schema, "array"));
      }
      if (
        parsed.ok &&
        typeof parsed.value === "object" &&
        parsed.value !== null
      ) {
        return coerceValueToSchema(
          parsed.value,
          variantOfType(schema, "object"),
        );
      }
    }
    if (
      (expectsType(schema, "number") || expectsType(schema, "integer")) &&
      !expectsType(schema, "string") &&
      value.trim() !== "" &&
      Number.isFinite(Number(value))
    ) {
      return Number(value);
    }
    if (expectsType(schema, "boolean") && !expectsType(schema, "string")) {
      if (value === "true") return true;
      if (value === "false") return false;
    }
    return value;
  }

  if (Array.isArray(value)) {
    const arraySchema = variantOfType(schema, "array");
    const items =
      arraySchema === undefined || typeof arraySchema === "boolean"
        ? undefined
        : arraySchema.items;
    // Tuple schemas (items as array) are not used by our tools; only walk the
    // homogeneous single-schema form.
    const itemSchema =
      items !== undefined && !Array.isArray(items) ? items : undefined;
    return value.map(item => coerceValueToSchema(item, itemSchema));
  }

  if (typeof value === "object") {
    const objectSchema = variantOfType(schema, "object");
    if (objectSchema === undefined || typeof objectSchema === "boolean") {
      return value;
    }
    const properties = objectSchema.properties ?? {};
    const additional =
      typeof objectSchema.additionalProperties === "object"
        ? objectSchema.additionalProperties
        : undefined;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const propertySchema = properties[key];
      result[key] = coerceValueToSchema(
        entry,
        propertySchema !== undefined ? propertySchema : additional,
      );
    }
    return result;
  }

  return value;
}

/**
 * `experimental_repairToolCall` hook: repair InvalidToolInputError calls by
 * coercing the raw input toward the tool's JSON Schema. Returns null (keep
 * the original error) when the tool is unknown, the input isn't JSON, or
 * coercion changes nothing.
 */
export const repairStringifiedToolInputs: ToolCallRepairFunction<
  ToolSet
> = async ({ toolCall, error, inputSchema }) => {
  if (NoSuchToolError.isInstance(error)) return null;

  let raw: unknown;
  try {
    raw = toolCall.input ? (JSON.parse(toolCall.input) as unknown) : {};
  } catch {
    return null;
  }

  const schema = await inputSchema({ toolName: toolCall.toolName });
  const coerced = coerceValueToSchema(raw, schema);
  const repairedInput = JSON.stringify(coerced);
  if (repairedInput === JSON.stringify(raw)) return null;

  logger.warn("Repaired stringified tool-call input", {
    toolName: toolCall.toolName,
    toolCallId: toolCall.toolCallId,
  });

  return { ...toolCall, input: repairedInput };
};
