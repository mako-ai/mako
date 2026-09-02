/**
 * `connector.yaml`: the only file Mako reads without executing anything.
 *
 * It is deliberately tiny. Everything about a connector's behaviour — its
 * config fields, its entities, their schemas — comes from running `spec` and
 * `discover`, because a manifest that restates them is a manifest that drifts
 * from them.
 */
import yaml from "js-yaml";

/** The runtimes that exist. Only `node` runs today; the rest are named so a
 * folder declaring one gets a straight answer instead of a parse error. */
export const KNOWN_RUNTIMES = [
  "node",
  "declarative",
  "pypi",
  "image",
  "estuary",
] as const;
export const SUPPORTED_RUNTIMES = ["node"] as const;

export type ConnectorRuntime = (typeof KNOWN_RUNTIMES)[number];

export interface ConnectorFile {
  runtime: ConnectorRuntime;
  /** Entry file for the `node` runtime, relative to the folder. */
  entry: string;
  page?: { vendor?: string; category?: string; docs?: string };
}

export type ParseResult =
  | { ok: true; value: ConnectorFile }
  | { ok: false; reason: string };

const SLUG = /^[a-z][a-z0-9-]*$/;

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug) && slug.length <= 64;
}

/**
 * Parse and validate, returning a reason rather than throwing.
 *
 * Every refusal is phrased as the fix, because the reader is whoever just
 * pushed the folder and the message is all they will see.
 */
export function parseConnectorFile(contents: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = yaml.load(contents);
  } catch (error) {
    return {
      ok: false,
      reason: `connector.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (parsed === null || parsed === undefined) {
    return {
      ok: false,
      reason: "connector.yaml is empty; it needs at least `runtime: node`.",
    };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "connector.yaml must be a mapping, e.g. `runtime: node`.",
    };
  }

  const raw = parsed as Record<string, unknown>;
  const runtime = raw.runtime;
  if (typeof runtime !== "string") {
    return {
      ok: false,
      reason:
        "connector.yaml needs a `runtime`. For a hand-written connector use `runtime: node`.",
    };
  }
  if (!KNOWN_RUNTIMES.includes(runtime as ConnectorRuntime)) {
    return {
      ok: false,
      reason: `Unknown runtime "${runtime}". Known runtimes: ${KNOWN_RUNTIMES.join(", ")}.`,
    };
  }
  if (!SUPPORTED_RUNTIMES.includes(runtime as "node")) {
    return {
      ok: false,
      reason:
        `The "${runtime}" runtime is not available yet; today a connector must be \`runtime: node\`, ` +
        `written against @makoai/connector-sdk.`,
    };
  }

  const entry = raw.entry === undefined ? "connector.ts" : raw.entry;
  if (
    typeof entry !== "string" ||
    entry.includes("..") ||
    entry.startsWith("/")
  ) {
    return {
      ok: false,
      reason:
        "`entry` must be a file inside the connector folder, e.g. `connector.ts`.",
    };
  }

  const page = raw.page;
  if (
    page !== undefined &&
    (typeof page !== "object" || page === null || Array.isArray(page))
  ) {
    return {
      ok: false,
      reason: "`page` must be a mapping of vendor, category and docs.",
    };
  }

  return {
    ok: true,
    value: {
      runtime: runtime as ConnectorRuntime,
      entry,
      page: page as ConnectorFile["page"],
    },
  };
}

/**
 * Is a `SPEC` message usable?
 *
 * The credential form is built from `connectionSpecification`, so a spec
 * without one produces a connector nobody can enter a key for. Catching that
 * at push time is the difference between a clear failure and a form that
 * renders empty with no explanation.
 */
export function validateSpec(
  spec: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!spec || typeof spec !== "object") {
    return {
      ok: false,
      reason: "The connector's `spec` command emitted no SPEC message.",
    };
  }
  const connectionSpecification = (spec as Record<string, unknown>)
    .connectionSpecification;
  if (!connectionSpecification || typeof connectionSpecification !== "object") {
    return {
      ok: false,
      reason:
        "The spec has no `connectionSpecification`, so there would be no credential form. " +
        "Declare `config: { required, properties }` in defineConnector.",
    };
  }
  const properties = (connectionSpecification as Record<string, unknown>)
    .properties;
  // `properties` must be PRESENT, even if empty. It is the list
  // `applySchemaEncryption` encrypts by, so an absent one means no field is
  // known to be a secret and every value posted for this connector would be
  // stored in plaintext. `{}` is fine — a connector that needs no credential
  // has nothing to protect — but a missing key is a spec that did not say.
  if (
    properties === undefined ||
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return {
      ok: false,
      reason:
        "`connectionSpecification.properties` must be an object (use `{}` for a " +
        "connector that needs no credential). Without it no field can be " +
        "marked secret, and the credential would be stored in plaintext.",
    };
  }
  return { ok: true };
}
