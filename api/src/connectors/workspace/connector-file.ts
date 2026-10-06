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
  /**
   * Previous folder slugs. A rename writes the old slug here so every
   * `SourceConnection.type = "ws:<old>"` keeps resolving to this
   * definition (api/src/rename). Lives in the file so a clone or a laptop
   * `git mv` that keeps it behaves exactly like a UI rename.
   */
  aliases: string[];
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

  const rawAliases = raw.aliases;
  if (
    rawAliases !== undefined &&
    (!Array.isArray(rawAliases) ||
      rawAliases.some(a => typeof a !== "string" || !isValidSlug(a)))
  ) {
    return {
      ok: false,
      reason:
        "`aliases` must be a list of previous folder slugs, e.g. `aliases: [acme]`.",
    };
  }
  const aliases = [...new Set((rawAliases as string[] | undefined) ?? [])];

  return {
    ok: true,
    value: {
      runtime: runtime as ConnectorRuntime,
      entry,
      page: page as ConnectorFile["page"],
      aliases,
    },
  };
}

/**
 * `connector.yaml` with `alias` added to its `aliases`, as text. The file
 * is the author's, so this is a line edit, never a re-dump: a missing
 * `aliases` key is appended; a block list (`aliases:` + `  - x` lines)
 * gets one more item at the same indent; a flow list (`aliases: [x]`)
 * gets `, alias` before the `]`. Every other byte — comments included —
 * is kept. Null when the file does not parse, or when its `aliases` is
 * written in a way this cannot extend in place (an anchor, a multi-line
 * flow list): a rename must not overwrite what it cannot read.
 */
export function withConnectorAlias(
  contents: string,
  alias: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = yaml.load(contents);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const doc = parsed as Record<string, unknown>;
  const existing = Array.isArray(doc.aliases)
    ? doc.aliases.filter((a): a is string => typeof a === "string")
    : null;
  if (existing && existing.includes(alias)) return contents;
  const nl = contents.includes("\r\n") ? "\r\n" : "\n";
  if (existing === null) {
    if (doc.aliases !== undefined) return null; // present but not a list
    const base =
      contents.endsWith("\n") || contents === ""
        ? contents
        : `${contents}${nl}`;
    return `${base}aliases:${nl}  - ${alias}${nl}`;
  }
  const lines = contents.split(nl);
  const keyAt = lines.findIndex(l => /^aliases:\s*(\[.*\])?\s*(#.*)?$/.test(l));
  if (keyAt < 0) return null;
  const flow = /^(aliases:\s*\[)(.*)(\]\s*(?:#.*)?)$/.exec(lines[keyAt]);
  if (flow) {
    const inner = flow[2].trim();
    lines[keyAt] =
      `${flow[1]}${inner ? `${inner}, ${alias}` : alias}${flow[3]}`;
    return lines.join(nl);
  }
  // Block list: items follow the key, each `<indent>- value`.
  let last = keyAt;
  let indent: string | null = null;
  for (let i = keyAt + 1; i < lines.length; i++) {
    const item = /^(\s+)-\s/.exec(lines[i]);
    if (!item || (indent !== null && item[1] !== indent)) break;
    indent = item[1];
    last = i;
  }
  if (indent === null) return null; // `aliases:` with items we could not see
  lines.splice(last + 1, 0, `${indent}- ${alias}`);
  return lines.join(nl);
}

/**
 * The YAML's identity for the content hash: the file with `aliases`
 * removed. A rename writes an alias and nothing else; hashing it would
 * make every rename look like new code (spec re-run, `verified` lost).
 * Returns the raw text when the file does not parse, so a broken yaml
 * still changes the hash and gets blocked with its reason.
 */
export function connectorFileIdentity(contents: string): string {
  let parsed: unknown;
  try {
    parsed = yaml.load(contents);
  } catch {
    return contents;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return contents;
  }
  const { aliases: _aliases, ...rest } = parsed as Record<string, unknown>;
  return yaml.dump(rest, { sortKeys: true, lineWidth: -1 });
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
