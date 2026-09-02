/**
 * The wire: Airbyte's protocol, unchanged.
 *
 * A connector process writes JSON Lines on stdout and nothing else. The
 * format is not ours and deliberately so — every connector corpus worth
 * importing already emits it, which is what lets a later runtime run a
 * foreign connector instead of translating one. Nobody writing a Mako
 * connector sees this file; the SDK does the talking.
 */

/** Message types we emit. Airbyte defines more; we never need them. */
export const SPEC = "SPEC";
export const CONNECTION_STATUS = "CONNECTION_STATUS";
export const CATALOG = "CATALOG";
export const RECORD = "RECORD";
export const STATE = "STATE";
export const LOG = "LOG";
export const TRACE = "TRACE";

/**
 * Shorthand a connector author writes -> the JSON Schema the wire carries.
 *
 * `null` is in every type union on purpose: a source that omits a field is
 * the normal case, and a schema that forbids null turns "this row had no
 * middle name" into a validation failure at the destination.
 */
const SHORTHAND = {
  string: { type: ["null", "string"] },
  integer: { type: ["null", "integer"] },
  number: { type: ["null", "number"] },
  boolean: { type: ["null", "boolean"] },
  timestamp: { type: ["null", "string"], format: "date-time" },
  json: { type: ["null", "object", "array"] },
};

export function fieldToJsonSchema(field) {
  if (typeof field === "string") {
    const mapped = SHORTHAND[field];
    if (!mapped) {
      throw new Error(
        `Unknown field type "${field}". Use one of ${Object.keys(SHORTHAND).join(", ")}, or a JSON Schema object.`,
      );
    }
    return { ...mapped };
  }
  if (field && typeof field === "object") return field;
  throw new Error(`A field must be a type name or a JSON Schema object, got ${typeof field}`);
}

/** `{ id: "string" }` -> a JSON Schema object for a whole stream. */
export function schemaToJsonSchema(schema) {
  if (!schema || typeof schema !== "object") {
    // No declared schema is legal: the destination infers from the rows and
    // unknown fields land as strings. Say so explicitly rather than emitting
    // a schema that claims the stream has no fields.
    return { type: "object", additionalProperties: true, properties: {} };
  }
  if (schema.type === "object" && schema.properties) return schema;
  const properties = {};
  for (const [name, field] of Object.entries(schema)) {
    properties[name] = fieldToJsonSchema(field);
  }
  return { type: "object", additionalProperties: true, properties };
}

const write = line => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

export function emitSpec(spec) {
  write({ type: SPEC, spec });
}

export function emitConnectionStatus(status, message) {
  write({
    type: CONNECTION_STATUS,
    connectionStatus: message ? { status, message } : { status },
  });
}

export function emitCatalog(streams) {
  write({ type: CATALOG, catalog: { streams } });
}

export function emitRecord(stream, data, emittedAt = Date.now()) {
  write({ type: RECORD, record: { stream, data, emitted_at: emittedAt } });
}

/**
 * Stream state, plus the one thing Airbyte's protocol cannot say.
 *
 * Mako's engine calls a connector for a bounded chunk and asks "is there
 * more?" (`FetchState.hasMore`). Airbyte has no word for it: a source reads
 * until it is done. `mako.hasMore` is that word, namespaced so a stock
 * Airbyte consumer ignores it and a stock Airbyte source simply never sets
 * it — for those, "the process exited" means done.
 */
export function emitState(stream, streamState, { hasMore } = {}) {
  const state = {
    type: "STREAM",
    stream: { stream_descriptor: { name: stream }, stream_state: streamState ?? {} },
  };
  if (hasMore !== undefined) state.mako = { hasMore };
  write({ type: STATE, state });
}

export function emitLog(level, message) {
  write({ type: LOG, log: { level, message } });
}

/** A failure the runner could not hide, in the shape Airbyte reserves for it. */
export function emitTraceError(message, stackTrace, failureType = "system_error") {
  write({
    type: TRACE,
    trace: {
      type: "ERROR",
      emitted_at: Date.now(),
      error: { message, stack_trace: stackTrace, failure_type: failureType },
    },
  });
}
