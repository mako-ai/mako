/**
 * `defineConnector`: what a connector author writes.
 *
 * The shape is Mako's existing connector contract, `BaseConnector`, with one
 * method per thing the engine needs — can I connect, what is in there, give me
 * the next chunk. It is deliberately not a new contract: the connectors that
 * run production today implement exactly these, and everything that makes a
 * sync correct (backfill locks, idempotent change ingest, retries,
 * materialization) lives in the engine, not here.
 */
import { schemaToJsonSchema } from "./protocol.js";
import { createHttp } from "./http.js";
import { paginate } from "./paginate.js";

const SLUG = /^[a-z][a-z0-9-]*$/;
// Entity names become table names, and Airbyte's own streams use snake_case
// (`payment_intents`, `balance_transactions`). Hyphens stay legal too. A
// sub-entity is `parent:Type`, the form Mako's engine already uses for Close
// activities (`activities:Call`, table `call_activities`).
const ENTITY_NAME = /^[a-z][a-z0-9_-]*(:[A-Za-z][A-Za-z0-9]*)?$/;
// What a read does with `state.mako.since`, in Mako's words (IncrementalMode).
const INCREMENTAL_MODES = ["native", "client-filter", "created-anchor"];

/**
 * How Mako checks a webhook's signature, as data. Mako verifies every
 * delivery in its API, with the flow's signing secret, before anything is
 * stored: the secret never reaches a box, so no connector code can check a
 * signature. A connector says which scheme its vendor uses instead.
 *
 * - `scheme`: only `hmac-sha256` for now.
 * - `secretEncoding`: how the stored secret becomes the HMAC key.
 * - `signedPayload`: the parts signed, in order. `body` is the raw request
 *   body, `header:<name>` a request header, `literal:<text>` fixed text.
 * - `signatureHeader`: the header carrying the signature, in
 *   `signatureEncoding`, after an optional `signaturePrefix` (`sha256=`).
 */
export const WEBHOOK_VERIFICATION_SCHEMES = ["hmac-sha256"];
const SECRET_ENCODINGS = ["hex", "base64", "utf8"];
const SIGNATURE_ENCODINGS = ["hex", "base64"];
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

export function validateWebhookVerification(verification) {
  if (!verification || typeof verification !== "object") {
    return ["webhooks.verification must be an object"];
  }
  const problems = [];
  const v = verification;
  if (!WEBHOOK_VERIFICATION_SCHEMES.includes(v.scheme)) {
    problems.push(`webhooks.verification.scheme must be one of ${WEBHOOK_VERIFICATION_SCHEMES.join(", ")}`);
  }
  if (!SECRET_ENCODINGS.includes(v.secretEncoding)) {
    problems.push(`webhooks.verification.secretEncoding must be one of ${SECRET_ENCODINGS.join(", ")}`);
  }
  if (!SIGNATURE_ENCODINGS.includes(v.signatureEncoding)) {
    problems.push(`webhooks.verification.signatureEncoding must be one of ${SIGNATURE_ENCODINGS.join(", ")}`);
  }
  if (typeof v.signatureHeader !== "string" || !HEADER_NAME.test(v.signatureHeader)) {
    problems.push("webhooks.verification.signatureHeader must be a lowercase header name");
  }
  if (v.signaturePrefix !== undefined && (typeof v.signaturePrefix !== "string" || v.signaturePrefix.length > 32)) {
    problems.push("webhooks.verification.signaturePrefix must be a short string");
  }
  if ((v.timestampHeader === undefined) !== (v.toleranceSeconds === undefined)) {
    problems.push("webhooks.verification.timestampHeader and toleranceSeconds go together");
  } else if (v.timestampHeader !== undefined) {
    if (typeof v.timestampHeader !== "string" || !HEADER_NAME.test(v.timestampHeader)) {
      problems.push("webhooks.verification.timestampHeader must be a lowercase header name");
    }
    if (!Number.isSafeInteger(v.toleranceSeconds) || v.toleranceSeconds < 1 || v.toleranceSeconds > 86400) {
      problems.push("webhooks.verification.toleranceSeconds must be a whole number from 1 to 86400");
    }
  }
  const parts = v.signedPayload;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 8) {
    problems.push("webhooks.verification.signedPayload must list 1 to 8 parts");
    return problems;
  }
  if (!parts.includes("body")) {
    problems.push('webhooks.verification.signedPayload must include "body"');
  }
  for (const part of parts) {
    const ok =
      part === "body" ||
      (typeof part === "string" && part.startsWith("header:") && HEADER_NAME.test(part.slice(7))) ||
      (typeof part === "string" && part.startsWith("literal:") && part.length <= 72);
    if (!ok) {
      problems.push(
        `webhooks.verification.signedPayload part ${JSON.stringify(part)} must be "body", "header:<name>" or "literal:<text>"`,
      );
    }
  }
  return problems;
}

export function defineConnector(definition) {
  const problems = validateDefinition(definition);
  if (problems.length > 0) {
    throw new Error(
      `Invalid connector definition:\n  - ${problems.join("\n  - ")}`,
    );
  }

  const entities = definition.entities;

  return {
    __makoConnector: 1,
    definition,

    /** `spec`: identity plus the JSON Schema of the config form. */
    spec() {
      return {
        documentationUrl: definition.documentationUrl,
        connectionSpecification: {
          $schema: "http://json-schema.org/draft-07/schema#",
          title: definition.title ?? definition.name,
          type: "object",
          required: definition.config?.required ?? [],
          properties: definition.config?.properties ?? {},
          additionalProperties: false,
        },
        // Namespaced so a stock Airbyte consumer ignores it. Mako reads it to
        // name the connector and pick its icon without executing anything else.
        mako: {
          name: definition.name,
          version: definition.version,
          entities: Object.fromEntries(
            Object.entries(entities).map(([name, entity]) => [
              name,
              {
                label: entity.label,
                description: entity.description,
                // How a destination should lay the table out, and how far
                // `state.mako.since` narrows a read. Mako reads both from the spec
                // it indexes, without running the connector.
                ...(entity.layout ? { layout: entity.layout } : {}),
                ...(entity.incremental ? { incremental: entity.incremental } : {}),
              },
            ]),
          ),
          // Webhooks, as data Mako reads without running the connector: how
          // to verify a delivery, and the events the connector handles.
          ...(definition.webhooks
            ? {
                webhooks: {
                  verification: definition.webhooks.verification,
                  ...(definition.webhooks.events ? { events: [...definition.webhooks.events] } : {}),
                },
              }
            : {}),
        },
      };
    },

    /**
     * `check`: does this credential work?
     *
     * A connector may return false or throw; both are a failed check. Throwing
     * is better because the vendor's message survives into the UI, which is
     * the difference between "check failed" and "401: this key was revoked".
     */
    async check(ctx) {
      if (!definition.check) return { status: "SUCCEEDED" };
      const result = await definition.check(ctx);
      if (result === false)
        return { status: "FAILED", message: "Connection test returned false" };
      return { status: "SUCCEEDED" };
    },

    /**
     * `discover`: the streams and their schemas.
     *
     * Static by default, from what the author declared. An entity may also
     * define `discoverSchema(ctx)` for an API whose fields are per-account,
     * which is the case Mako's own custom-field connectors need.
     */
    async discover(ctx) {
      const streams = [];
      for (const [name, entity] of Object.entries(entities)) {
        const schema = entity.discoverSchema
          ? await entity.discoverSchema(ctx)
          : entity.schema;
        const stream = {
          name,
          json_schema: schemaToJsonSchema(schema),
          supported_sync_modes: entity.cursorField
            ? ["full_refresh", "incremental"]
            : ["full_refresh"],
        };
        if (entity.primaryKey)
          stream.source_defined_primary_key = entity.primaryKey.map(k => [k]);
        if (entity.cursorField) {
          stream.source_defined_cursor = true;
          stream.default_cursor_field = [entity.cursorField];
        }
        streams.push(stream);
      }
      return streams;
    },

    /**
     * `webhook`: a batch of stored, already verified deliveries in, one
     * outcome per event out, in order. Mako hands the batch to a box; the
     * handler maps each event to change records, re-fetching what a partial
     * payload lacks with `ctx` (the connection's credential, never the
     * webhook secret). Mako filters, stamps and writes the records.
     */
    async handleWebhooks(ctx, events) {
      if (!definition.webhooks) {
        throw new Error(`The connector "${definition.name}" declares no webhooks.`);
      }
      const outcomes = await definition.webhooks.handleBatch(ctx, events);
      return checkWebhookOutcomes(events, outcomes);
    },
    hasWebhooks: () => Boolean(definition.webhooks),

    entityNames: () => Object.keys(entities),
    entity: name => entities[name],
  };
}

/** The engine's table name for an entity (`activities:Call` -> `call_activities`). */
export function tableNameOf(name) {
  if (!name.includes(":")) return name;
  const [parent, type] = name.split(":");
  return `${type.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}_${parent}`;
}

const WEBHOOK_OUTCOMES = ["records", "unmapped", "extract_failed", "skipped", "deferred"];

/**
 * A handler's answer, checked before it is written: one outcome per event,
 * in the batch's order, each naming its own event. Mako checks it again on
 * its side; this is where an author learns about the mistake.
 */
function checkWebhookOutcomes(events, outcomes) {
  if (!Array.isArray(outcomes)) {
    throw new Error("webhooks.handleBatch must return an array, one outcome per event");
  }
  if (outcomes.length !== events.length) {
    throw new Error(`webhooks.handleBatch returned ${outcomes.length} outcomes for ${events.length} events`);
  }
  return outcomes.map((outcome, i) => {
    const eventId = events[i]?.eventId;
    if (!outcome || outcome.eventId !== eventId) {
      throw new Error(
        `webhooks.handleBatch outcome ${i} must name event ${JSON.stringify(eventId)}, in the batch's order`,
      );
    }
    if (!WEBHOOK_OUTCOMES.includes(outcome.outcome)) {
      throw new Error(`webhooks.handleBatch outcome for ${eventId} must be one of ${WEBHOOK_OUTCOMES.join(", ")}`);
    }
    if (outcome.outcome === "records" && !Array.isArray(outcome.records)) {
      throw new Error(`webhooks.handleBatch outcome for ${eventId} has no records array`);
    }
    return outcome;
  });
}

function validateDefinition(definition) {
  const problems = [];
  if (!definition || typeof definition !== "object")
    return ["the definition must be an object"];
  if (!definition.name || !SLUG.test(definition.name)) {
    problems.push(
      `name must be a lowercase slug like "acme-crm" (got ${JSON.stringify(definition.name)})`,
    );
  }
  if (!definition.version) problems.push('version is required, e.g. "1.0.0"');

  const properties = definition.config?.properties;
  if (properties && typeof properties !== "object")
    problems.push("config.properties must be an object");
  for (const required of definition.config?.required ?? []) {
    if (!properties?.[required]) {
      problems.push(
        `config.required lists "${required}" but config.properties has no such field`,
      );
    }
  }

  if (definition.webhooks !== undefined) {
    const webhooks = definition.webhooks;
    if (!webhooks || typeof webhooks !== "object") {
      problems.push("webhooks must be an object");
    } else {
      if (typeof webhooks.handleBatch !== "function") {
        problems.push("webhooks.handleBatch(ctx, events) must be a function");
      }
      problems.push(...validateWebhookVerification(webhooks.verification));
      if (
        webhooks.events !== undefined &&
        (!Array.isArray(webhooks.events) || webhooks.events.some(e => typeof e !== "string"))
      ) {
        problems.push("webhooks.events must be an array of event names");
      }
    }
  }

  const entities = definition.entities;
  if (
    !entities ||
    typeof entities !== "object" ||
    Object.keys(entities).length === 0
  ) {
    problems.push("at least one entity is required");
    return problems;
  }
  // The engine names a table `parent:Type` -> `type_parent` (snake_case,
  // lowercase; `getEntityTableName`). Two entities that land on one table
  // would overwrite each other, so they are refused here.
  const tables = new Map();
  for (const name of Object.keys(entities)) {
    const table = tableNameOf(name);
    if (tables.has(table)) {
      problems.push(
        `entities "${tables.get(table)}" and "${name}" would both write to table "${table}"`,
      );
    } else {
      tables.set(table, name);
    }
  }
  for (const [name, entity] of Object.entries(entities)) {
    if (!ENTITY_NAME.test(name)) {
      problems.push(
        `entity "${name}" must be lowercase letters, digits, "_" or "-", optionally followed by ":SubType"`,
      );
    }
    if (typeof entity?.read !== "function") {
      problems.push(`entity "${name}" needs a read(ctx, state) generator`);
    }
    if (entity?.incremental && !INCREMENTAL_MODES.includes(entity.incremental)) {
      problems.push(
        `entity "${name}": incremental must be one of ${INCREMENTAL_MODES.join(", ")}`,
      );
    }
    if (entity?.primaryKey && !Array.isArray(entity.primaryKey)) {
      problems.push(
        `entity "${name}": primaryKey must be an array of field names`,
      );
    }
    // A declared cursor that is not in the declared schema is a typo that
    // otherwise surfaces as an incremental sync that silently re-reads
    // everything, forever.
    if (
      entity?.cursorField &&
      entity.schema &&
      !entity.schema[entity.cursorField]
    ) {
      problems.push(
        `entity "${name}": cursorField "${entity.cursorField}" is not a field in its schema`,
      );
    }
  }
  return problems;
}

/** The `ctx` every connector method receives. */
export function createContext({ config, state, log, entity }) {
  const http = createHttp({
    ...(config?.__http ?? {}),
    log: message => log("INFO", message),
  });
  return {
    config,
    state: state ?? {},
    entity,
    http,
    paginate,
    log: message =>
      log(
        "INFO",
        typeof message === "string" ? message : JSON.stringify(message),
      ),
    createHttp: options =>
      createHttp({ log: message => log("INFO", message), ...options }),
  };
}
