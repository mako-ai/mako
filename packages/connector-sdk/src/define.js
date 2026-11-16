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
