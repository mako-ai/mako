/* eslint-disable no-process-exit -- standalone CLI exit codes */
/**
 * ONE-OFF exploitation check. Written, never run by the author.
 *
 * Question: does any stored Google credential have a `type` other than
 * `service_account`, or a foreign `token_uri`, or a `credential_source`?
 * google-auth-library follows an `external_account` file's credential_source
 * (a local file or a URL) and POSTs what it reads to its `token_url`. A tenant
 * who could save such a JSON could read server files and send them out.
 *
 *   pnpm --filter api exec tsx src/scripts/check-google-credential-types.ts --dry-run
 *   pnpm --filter api exec tsx src/scripts/check-google-credential-types.ts --i-understand-this-decrypts
 *   --workspace <id>          only that workspace (24-hex or UUID)
 *   --source pg|mongo         where connections are read (default pg)
 *
 * Environment (process only; no .env file is loaded):
 *   POSTGRES_URL      Postgres, the default source (connections are pg_only).
 *   DATABASE_URL      Mongo, only with --source mongo (the frozen copy).
 *   ENCRYPTION_KEY    the API's own key (not needed with --dry-run).
 *
 * It only reads. It decrypts each candidate in memory, parses it and keeps
 * three facts: the `type` string (mapped to a fixed list, else "other"), the
 * HOSTNAME of `token_uri`, and whether `credential_source` exists. Nothing
 * else leaves the function that classifies. Output is aggregate rows:
 *
 *   workspaceId  workspace  kind  connType  class  detail  cred_source
 *   count  firstCreated  lastUpdated  ids
 *
 * `ids` (connection _id values) is filled for every class except ok.
 *
 * Classes: ok, bad_type, bad_token_uri, has_credential_source, unparseable,
 * undecryptable. A connection with several credential fields shows its worst
 * class. JS strings cannot be wiped; the script drops every reference to the
 * decrypted text and overwrites the parsed object's fields right after use.
 *
 * `--dry-run` decrypts nothing. It counts candidates per workspace and type.
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import mongoose from "mongoose";
import { decryptString } from "../services/crypto.service";
import { DatabaseConnection } from "../database/models/database-connections";
import { SourceConnection } from "../database/models/source-connections";
import { Workspace } from "../database/models/workspace";
import { closePgConnections, getPgDb } from "../database/pg/client";
import { parseEntityId, toWireId } from "../database/pg/id-codec";
import {
  databaseConnections,
  sourceConnections,
} from "../database/pg/schema/connections";
import { workspaces } from "../database/pg/schema/workspaces";

/** The one decrypt call site; a test swaps it to count calls. */
export const deps = { decrypt: decryptString };

export type CredentialClass =
  | "ok"
  | "bad_type"
  | "bad_token_uri"
  | "has_credential_source"
  | "unparseable"
  | "undecryptable"
  | "string_config_unparsed"
  | "candidate"; // dry run only

/** Worst first. A connection reports the first class found in its fields. */
const SEVERITY: CredentialClass[] = [
  "bad_type",
  "has_credential_source",
  "bad_token_uri",
  "unparseable",
  "undecryptable",
  "string_config_unparsed",
  "ok",
];

/** `type` values of Google credential files. Anything else prints as "other". */
const KNOWN_TYPES = new Set([
  "service_account",
  "external_account",
  "external_account_authorized_user",
  "authorized_user",
  "impersonated_service_account",
  "gdch_service_account",
]);

/** Hosts Google's own key files carry as `token_uri`, over https. */
const GOOGLE_TOKEN_HOSTS = new Set([
  "oauth2.googleapis.com",
  "accounts.google.com",
  "www.googleapis.com",
]);

/** Field names (lowercased, `_` and `-` removed) that hold a Google key. */
const CREDENTIAL_FIELD_NAMES = new Set([
  "serviceaccountjson",
  "serviceaccount",
  "serviceaccountkey",
  "credentials",
  "credentialsjson",
  "credential",
  "keyfile",
  "keyfilejson",
  "keyjson",
  "googlecredentials",
  "gcpcredentials",
  "gcpkey",
  "sajson",
  "sakey",
]);

/** Keys that make an arbitrary JSON value look like a Google credential. */
const GOOGLE_MARKER_KEYS = [
  "private_key",
  "client_email",
  "token_uri",
  "token_url",
  "credential_source",
  "subject_token_type",
  "service_account_impersonation_url",
];

const DB_TYPES = ["bigquery", "cloudsql-postgres"];
const SOURCE_TYPES = ["bigquery", "gcs", "custom_api"];

export function isCredentialFieldName(name: string): boolean {
  return CREDENTIAL_FIELD_NAMES.has(name.toLowerCase().replace(/[_-]/g, ""));
}

interface Verdict {
  cls: CredentialClass;
  /** Mapped type value, or the token_uri hostname. Never anything else. */
  detail: string;
  credentialSource: boolean;
}

const SAFE_HOST = /^[A-Za-z0-9.-]{1,253}$/;

function tokenHost(uri: unknown): { ok: boolean; host: string } {
  if (typeof uri !== "string") return { ok: false, host: "non_string" };
  try {
    const url = new URL(uri);
    const host = url.hostname.toLowerCase();
    return {
      ok: url.protocol === "https:" && GOOGLE_TOKEN_HOSTS.has(host),
      // Only a plain hostname is printed; anything else is "other".
      host: !host ? "empty" : SAFE_HOST.test(host) ? host : "other",
    };
  } catch {
    return { ok: false, host: "invalid_url" };
  }
}

/**
 * Classify one parsed value. Returns null for a value in a field that is not
 * known to hold a credential and shows no Google marker. Reads `type`,
 * `token_uri` and the existence of `credential_source`, nothing else.
 */
export function classifyParsed(
  value: unknown,
  fieldIsCredential: boolean,
): Verdict | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fieldIsCredential
      ? { cls: "unparseable", detail: "not_object", credentialSource: false }
      : null;
  }
  const obj = value as Record<string, unknown>;
  const typeValue = obj.type;
  const looksGoogle =
    GOOGLE_MARKER_KEYS.some(k => k in obj) ||
    (typeof typeValue === "string" && KNOWN_TYPES.has(typeValue));
  if (!fieldIsCredential && !looksGoogle) return null;

  const credentialSource = "credential_source" in obj;
  if (typeValue !== "service_account") {
    const detail =
      typeof typeValue === "string"
        ? KNOWN_TYPES.has(typeValue)
          ? typeValue
          : "other"
        : typeValue === undefined
          ? "missing"
          : "non_string";
    return { cls: "bad_type", detail, credentialSource };
  }
  if (credentialSource) {
    return { cls: "has_credential_source", detail: "", credentialSource };
  }
  if (obj.token_uri !== undefined) {
    const { ok, host } = tokenHost(obj.token_uri);
    if (!ok) return { cls: "bad_token_uri", detail: host, credentialSource };
  }
  return { cls: "ok", detail: "", credentialSource };
}

/** Decrypt every string inside `value` (nested objects included). */
function decryptDeep(value: unknown): unknown {
  if (typeof value === "string") return deps.decrypt(value);
  if (Array.isArray(value)) return value.map(decryptDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = decryptDeep(v);
    return out;
  }
  return value;
}

/** Overwrite a parsed object's fields so no secret stays reachable from it. */
function scrub(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    scrub(child);
    (value as Record<string, unknown>)[key] = null;
  }
}

/** Decrypt, parse, classify and scrub one stored field value. */
export function classifyStoredField(
  raw: unknown,
  fieldIsCredential: boolean,
): Verdict | null {
  let text: unknown = null;
  let parsed: unknown = null;
  try {
    try {
      text = decryptDeep(raw);
    } catch {
      return fieldIsCredential
        ? { cls: "undecryptable", detail: "", credentialSource: false }
        : null;
    }
    if (typeof text === "string") {
      const trimmed = text.trim();
      // A non-credential field that is not JSON is of no interest.
      if (!fieldIsCredential && !trimmed.startsWith("{")) return null;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return fieldIsCredential
          ? {
              cls: "unparseable",
              detail: "invalid_json",
              credentialSource: false,
            }
          : null;
      }
    } else {
      parsed = text;
    }
    return classifyParsed(parsed, fieldIsCredential);
  } finally {
    scrub(parsed);
    scrub(text);
  }
}

/** Fields of a stored container that may hold a Google credential. */
function candidateFields(
  container: Record<string, unknown> | undefined,
  scanAllStrings: boolean,
): Array<[string, unknown, boolean]> {
  const fields: Array<[string, unknown, boolean]> = [];
  for (const [name, value] of Object.entries(container ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (isCredentialFieldName(name)) fields.push([name, value, true]);
    else if (scanAllStrings && typeof value === "string") {
      fields.push([name, value, false]);
    }
  }
  return fields;
}

type Kind = "database" | "source";

interface StoredDoc {
  _id: { toString(): string };
  workspaceId: { toString(): string };
  type: string;
  createdAt?: Date;
  updatedAt?: Date;
  connection?: unknown;
  config?: unknown;
}

/**
 * Where the connections come from. Postgres is the source of truth
 * (connections are `pg_only`); the Mongo reader reads the frozen copy and
 * backs the in-memory-Mongo unit test.
 */
interface ConnectionReader {
  databaseConnections(workspace?: string): AsyncIterable<StoredDoc>;
  sourceConnections(workspace?: string): AsyncIterable<StoredDoc>;
  workspaceNames(ids: string[]): Promise<Map<string, string>>;
}

const mongoReader: ConnectionReader = {
  databaseConnections: workspace =>
    DatabaseConnection.collection.find(mongoFilter(workspace), {
      projection: {
        workspaceId: 1,
        type: 1,
        connection: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    }) as unknown as AsyncIterable<StoredDoc>,
  sourceConnections: workspace =>
    SourceConnection.collection.find(mongoFilter(workspace), {
      projection: {
        workspaceId: 1,
        type: 1,
        config: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    }) as unknown as AsyncIterable<StoredDoc>,
  async workspaceNames(ids) {
    const names = new Map<string, string>();
    if (ids.length === 0) return names;
    const rows = await Workspace.collection
      .find(
        { _id: { $in: ids.map(i => new mongoose.Types.ObjectId(i)) } },
        { projection: { name: 1 } },
      )
      .toArray();
    for (const r of rows) names.set(String(r._id), String(r.name ?? ""));
    return names;
  },
};

function mongoFilter(workspace?: string): Record<string, unknown> {
  return workspace
    ? { workspaceId: new mongoose.Types.ObjectId(workspace) }
    : {};
}

/** The workspace's Postgres UUID, from a 24-hex id or a UUID. */
function pgWorkspaceUuid(workspace: string): string {
  const parsed = parseEntityId(workspace);
  if (!parsed) throw new Error("--workspace needs a 24-hex id or a UUID");
  return parsed.uuid;
}

/** Postgres reader. Ids print in wire form (24-hex for migrated rows). */
function pgReader(): ConnectionReader {
  async function* connections(
    kind: Kind,
    workspace?: string,
  ): AsyncIterable<StoredDoc> {
    const table = kind === "database" ? databaseConnections : sourceConnections;
    const payload =
      kind === "database"
        ? databaseConnections.connectionEncrypted
        : sourceConnections.configEncrypted;
    const scope = workspace
      ? eq(table.workspaceId, pgWorkspaceUuid(workspace))
      : undefined;
    const pageSize = 256;
    let after: string | undefined;
    for (;;) {
      const rows = await getPgDb()
        .select({
          id: table.id,
          workspaceId: table.workspaceId,
          type: table.type,
          createdAt: table.createdAt,
          updatedAt: table.updatedAt,
          payload,
        })
        .from(table)
        .where(and(scope, after ? gt(table.id, after) : undefined))
        .orderBy(table.id)
        .limit(pageSize);
      for (const r of rows) {
        yield {
          _id: toWireId(r.id),
          workspaceId: toWireId(r.workspaceId),
          type: r.type,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          ...(kind === "database"
            ? { connection: r.payload }
            : { config: r.payload }),
        };
      }
      if (rows.length < pageSize) return;
      after = rows[rows.length - 1].id;
    }
  }
  return {
    databaseConnections: workspace => connections("database", workspace),
    sourceConnections: workspace => connections("source", workspace),
    async workspaceNames(ids) {
      const names = new Map<string, string>();
      if (ids.length === 0) return names;
      const rows = await getPgDb()
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(inArray(workspaces.id, ids.map(pgWorkspaceUuid)));
      for (const r of rows) names.set(toWireId(r.id), r.name);
      return names;
    },
  };
}

function readerFor(opts: CheckOptions): ConnectionReader {
  return (opts.source ?? "pg") === "mongo" ? mongoReader : pgReader();
}

const UNPARSED = Symbol("string_config_unparsed");
type Container = Record<string, unknown> | typeof UNPARSED | undefined;

/**
 * A stored `connection` or `config` is an object, or (legacy rows) a string:
 * either JSON of the object, or the whole object encrypted as one value.
 * Returns UNPARSED when a string yields no object.
 */
function containerOf(value: unknown): Container {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return undefined;
  const asObject = (text: string): Record<string, unknown> | undefined => {
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = asObject(value);
  if (direct) return direct;
  try {
    let text: string | null = deps.decrypt(value);
    const inner = asObject(text);
    text = null;
    if (inner) return inner;
  } catch {
    // fall through
  }
  return UNPARSED;
}

function isCandidate(
  kind: Kind,
  doc: StoredDoc,
  container: Container,
): boolean {
  if (container === UNPARSED) return true;
  const hasField = !!container && candidateFields(container, false).length > 0;
  if (kind === "database") return DB_TYPES.includes(doc.type) || hasField;
  return (
    SOURCE_TYPES.includes(doc.type) || doc.type.startsWith("ws:") || hasField
  );
}

function worst(verdicts: Verdict[]): Verdict | null {
  let best: Verdict | null = null;
  for (const v of verdicts) {
    if (!best || SEVERITY.indexOf(v.cls) < SEVERITY.indexOf(best.cls)) best = v;
  }
  return best;
}

interface Group {
  workspaceId: string;
  kind: Kind;
  connType: string;
  cls: CredentialClass;
  detail: string;
  credentialSource: boolean;
  count: number;
  firstCreated?: Date;
  lastUpdated?: Date;
  ids: string[];
}

export const DECRYPT_FLAG = "--i-understand-this-decrypts";

export const USAGE = `Usage: check-google-credential-types.ts (--dry-run | ${DECRYPT_FLAG}) [--workspace <id>] [--source pg|mongo]
  --source    pg (default; POSTGRES_URL) or mongo (the frozen copy; DATABASE_URL)
  --report api-base-url
              second report: where each BigQuery connection's api_base_url
              points (google, loopback, private, other, empty); never the URL
  --dry-run   count candidates per workspace and type; decrypts nothing
  ${DECRYPT_FLAG}
              decrypt every candidate credential in memory and classify it`;

export class UsageError extends Error {}

export interface CheckOptions {
  dryRun: boolean;
  workspace?: string;
  /** Default: the credential-type report. */
  report?: "api-base-url";
  /** Default: pg. */
  source?: "pg" | "mongo";
}

export interface CheckIO {
  out(line: string): void;
  err(line: string): void;
}

export function parseCheckArgs(argv: string[]): CheckOptions {
  const opts: CheckOptions = { dryRun: false };
  let decrypts = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === DECRYPT_FLAG) decrypts = true;
    else if (arg === "--workspace") {
      const workspace = argv[++i];
      if (!workspace) throw new UsageError("--workspace needs an id");
      opts.workspace = workspace;
    } else if (arg === "--report") {
      if (argv[++i] !== "api-base-url") {
        throw new UsageError("--report only knows: api-base-url");
      }
      opts.report = "api-base-url";
    } else if (arg === "--source" || arg.startsWith("--source=")) {
      const source =
        arg === "--source" ? argv[++i] : arg.slice("--source=".length);
      if (source !== "pg" && source !== "mongo") {
        throw new UsageError("--source only knows: pg, mongo");
      }
      opts.source = source;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.dryRun && !decrypts) {
    throw new UsageError("Pass --dry-run or " + DECRYPT_FLAG);
  }
  if (opts.workspace !== undefined) {
    const parsed = parseEntityId(opts.workspace);
    // Mongo ids are always 24-hex; Postgres also has native UUID workspaces.
    if (
      !parsed ||
      (opts.source === "mongo" &&
        !mongoose.isObjectIdOrHexString(opts.workspace))
    ) {
      throw new Error("--workspace needs a 24-hex id (or a UUID with pg)");
    }
  }
  return opts;
}

function iso(d?: Date): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

/** Walk every candidate connection and print aggregate rows. Read only. */
export async function runCheck(
  opts: CheckOptions,
  io: CheckIO,
): Promise<{ scanned: number; classified: number; bad: number }> {
  const groups = new Map<string, Group>();
  let scanned = 0;
  let classified = 0;
  let bad = 0;

  const reader = readerFor(opts);
  const sources: Array<[Kind, AsyncIterable<StoredDoc>]> = [
    ["database", reader.databaseConnections(opts.workspace)],
    ["source", reader.sourceConnections(opts.workspace)],
  ];

  for (const [kind, cursor] of sources) {
    for await (const doc of cursor) {
      scanned += 1;
      const stored = kind === "database" ? doc.connection : doc.config;
      let verdict: Verdict | null;
      if (opts.dryRun) {
        // Nothing is decrypted or parsed: a string config counts by type.
        const typeMatch =
          kind === "database"
            ? DB_TYPES.includes(doc.type)
            : SOURCE_TYPES.includes(doc.type) || doc.type.startsWith("ws:");
        const objectHit =
          !!stored &&
          typeof stored === "object" &&
          candidateFields(stored as Record<string, unknown>, false).length > 0;
        if (!typeMatch && !objectHit) continue;
        verdict = { cls: "candidate", detail: "", credentialSource: false };
      } else {
        const container = containerOf(stored);
        if (!isCandidate(kind, doc, container)) continue;
        const scanAll = kind === "source" && doc.type.startsWith("ws:");
        const verdicts: Verdict[] = [];
        if (container === UNPARSED) {
          verdicts.push({
            cls: "string_config_unparsed",
            detail: "",
            credentialSource: false,
          });
        } else if (container) {
          for (const [, value, isCred] of candidateFields(container, scanAll)) {
            const v = classifyStoredField(value, isCred);
            if (v) verdicts.push(v);
          }
          // A config that came from a string holds plaintext secrets.
          if (typeof stored === "string") scrub(container);
        }
        verdict = worst(verdicts);
      }
      if (!verdict) continue;
      classified += 1;
      const id = doc._id.toString();
      const workspaceId = doc.workspaceId.toString();
      const key = [
        workspaceId,
        kind,
        doc.type,
        verdict.cls,
        verdict.detail,
        verdict.credentialSource,
      ].join("|");
      let g = groups.get(key);
      if (!g) {
        g = {
          workspaceId,
          kind,
          connType: doc.type,
          cls: verdict.cls,
          detail: verdict.detail,
          credentialSource: verdict.credentialSource,
          count: 0,
          ids: [],
        };
        groups.set(key, g);
      }
      g.count += 1;
      if (
        doc.createdAt &&
        (!g.firstCreated || doc.createdAt < g.firstCreated)
      ) {
        g.firstCreated = doc.createdAt;
      }
      if (doc.updatedAt && (!g.lastUpdated || doc.updatedAt > g.lastUpdated)) {
        g.lastUpdated = doc.updatedAt;
      }
      if (verdict.cls !== "ok" && verdict.cls !== "candidate") {
        g.ids.push(id);
        bad += 1;
      }
    }
  }

  const names = await reader.workspaceNames([
    ...new Set([...groups.values()].map(g => g.workspaceId)),
  ]);

  io.out(
    [
      "workspaceId",
      "workspace",
      "kind",
      "connType",
      "class",
      "detail",
      "cred_source",
      "count",
      "firstCreated",
      "lastUpdated",
      "ids",
    ].join("\t"),
  );
  const rows = [...groups.values()].sort(
    (a, b) =>
      SEVERITY.indexOf(a.cls) - SEVERITY.indexOf(b.cls) ||
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.connType.localeCompare(b.connType),
  );
  for (const g of rows) {
    io.out(
      [
        g.workspaceId,
        (names.get(g.workspaceId) ?? "").replace(/[\t\r\n]+/g, " "),
        g.kind,
        g.connType.replace(/[\t\r\n]+/g, " "),
        g.cls,
        g.detail,
        g.credentialSource ? "yes" : "no",
        String(g.count),
        iso(g.firstCreated),
        iso(g.lastUpdated),
        g.ids.join(","),
      ].join("\t"),
    );
  }
  io.err(
    `${opts.dryRun ? "DRY RUN (nothing decrypted). " : ""}` +
      `scanned ${scanned} connections, ${classified} with a Google credential field, ` +
      `${bad} flagged (any class except ok).`,
  );
  return { scanned, classified, bad };
}

// ── Second report: where BigQuery connections point ─────────────────────

export type BaseUrlClass =
  | "google"
  | "loopback"
  | "private"
  | "other"
  | "empty"
  | "undecryptable"
  | "string_config_unparsed"
  | "candidate"; // dry run only

const LISTED_BASE_URL_CLASSES = new Set<BaseUrlClass>([
  "loopback",
  "private",
  "other",
  "undecryptable",
  "string_config_unparsed",
]);

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every(n => n <= 255) ? o : null;
}

function ipv4Class(o: number[]): "loopback" | "private" | null {
  const [a, b] = o;
  if (a === 127 || a === 0) return "loopback";
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  ) {
    return "private";
  }
  return null;
}

/**
 * Class of an api_base_url. Looks at scheme, host and path only to pick a
 * class; none of them leaves this function. No DNS lookup.
 */
export function classifyBaseUrl(raw: unknown): BaseUrlClass {
  if (raw === undefined || raw === null) return "empty";
  if (typeof raw !== "string") return "other";
  const trimmed = raw.trim();
  if (!trimmed) return "empty";
  // The BigQuery client prepends https:// when there is no scheme.
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return "other";
  }
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const v4 = ipv4Octets(host);
  if (v4) return ipv4Class(v4) ?? "other";
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return "loopback";
    // IPv4-mapped (::ffff:a.b.c.d is normalised to ::ffff:xxxx:xxxx).
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      return ipv4Class([hi >> 8, hi & 255, lo >> 8, lo & 255]) ?? "other";
    }
    const first = host.split(":")[0];
    const head = first ? parseInt(first, 16) : 0;
    if ((head & 0xfe00) === 0xfc00) return "private";
    if ((head & 0xffc0) === 0xfe80) return "private";
    return "other";
  }
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  const pathIsEmpty = url.pathname === "/" || url.pathname === "";
  if (
    url.protocol === "https:" &&
    host.endsWith(".googleapis.com") &&
    pathIsEmpty &&
    !url.search &&
    !url.username &&
    !url.password
  ) {
    return "google";
  }
  return "other";
}

function isBigQueryType(kind: Kind, type: string): boolean {
  return kind === "database"
    ? type === "bigquery"
    : type === "bigquery" || (type.startsWith("ws:") && /bigquery/i.test(type));
}

/** Decrypt api_base_url in memory, classify it, drop it. */
function classifyStoredBaseUrl(raw: unknown): BaseUrlClass {
  let text: unknown = null;
  try {
    try {
      text = decryptDeep(raw);
    } catch {
      return "undecryptable";
    }
    return classifyBaseUrl(text);
  } finally {
    scrub(text);
  }
}

/** Second report. Read only. Prints classes and counts, never a URL. */
export async function runApiBaseUrlReport(
  opts: CheckOptions,
  io: CheckIO,
): Promise<{ scanned: number; classified: number }> {
  interface BaseGroup {
    workspaceId: string;
    kind: Kind;
    connType: string;
    cls: BaseUrlClass;
    count: number;
    ids: string[];
  }
  const groups = new Map<string, BaseGroup>();
  let scanned = 0;
  let classified = 0;
  const reader = readerFor(opts);
  const sources: Array<[Kind, AsyncIterable<StoredDoc>]> = [
    ["database", reader.databaseConnections(opts.workspace)],
    ["source", reader.sourceConnections(opts.workspace)],
  ];
  for (const [kind, cursor] of sources) {
    for await (const doc of cursor) {
      scanned += 1;
      const stored = kind === "database" ? doc.connection : doc.config;
      if (!isBigQueryType(kind, doc.type)) continue;
      let cls: BaseUrlClass;
      if (opts.dryRun) {
        // Candidates by type only: nothing is decrypted or parsed.
        cls = "candidate";
      } else {
        const container = containerOf(stored);
        if (container === UNPARSED) cls = "string_config_unparsed";
        else {
          cls = classifyStoredBaseUrl(container?.api_base_url);
          if (typeof stored === "string" && container) scrub(container);
        }
      }
      classified += 1;
      const workspaceId = doc.workspaceId.toString();
      const key = [workspaceId, kind, doc.type, cls].join("|");
      let g = groups.get(key);
      if (!g) {
        g = { workspaceId, kind, connType: doc.type, cls, count: 0, ids: [] };
        groups.set(key, g);
      }
      g.count += 1;
      if (LISTED_BASE_URL_CLASSES.has(cls)) g.ids.push(doc._id.toString());
    }
  }
  const names = await reader.workspaceNames([
    ...new Set([...groups.values()].map(g => g.workspaceId)),
  ]);
  io.out(
    [
      "workspaceId",
      "workspace",
      "kind",
      "connType",
      "class",
      "count",
      "ids",
    ].join("\t"),
  );
  const order = [
    "other",
    "private",
    "loopback",
    "undecryptable",
    "string_config_unparsed",
  ];
  const rank = (c: string) => (order.includes(c) ? order.indexOf(c) : 99);
  const sorted = [...groups.values()].sort(
    (a, b) =>
      rank(a.cls) - rank(b.cls) ||
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.connType.localeCompare(b.connType),
  );
  for (const g of sorted) {
    io.out(
      [
        g.workspaceId,
        (names.get(g.workspaceId) ?? "").replace(/[\t\r\n]+/g, " "),
        g.kind,
        g.connType.replace(/[\t\r\n]+/g, " "),
        g.cls,
        String(g.count),
        g.ids.join(","),
      ].join("\t"),
    );
  }
  io.err(
    `${opts.dryRun ? "DRY RUN (nothing decrypted). " : ""}` +
      `base URL report: scanned ${scanned} connections, ${classified} BigQuery candidates.`,
  );
  return { scanned, classified };
}

/** The command line. Returns the exit code; 2 means usage, nothing ran. */
export async function cli(
  argv: string[],
  io: CheckIO,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let opts: CheckOptions;
  try {
    opts = parseCheckArgs(argv);
  } catch (error) {
    if (error instanceof UsageError || error instanceof Error) {
      io.err(error.message);
      io.err(USAGE);
    }
    return 2;
  }
  const source = opts.source ?? "pg";
  const urlVar = source === "mongo" ? "DATABASE_URL" : "POSTGRES_URL";
  const url = env[urlVar]?.trim();
  if (!url) throw new Error(`${urlVar} is not set`);
  if (!opts.dryRun && !("ENCRYPTION_KEY" in env)) {
    throw new Error("ENCRYPTION_KEY is not set");
  }
  if (source === "mongo") await mongoose.connect(url);
  try {
    if (opts.report === "api-base-url") await runApiBaseUrlReport(opts, io);
    else await runCheck(opts, io);
  } finally {
    if (source === "mongo") await mongoose.disconnect();
    else await closePgConnections();
  }
  return 0;
}

if (require.main === module) {
  void cli(process.argv.slice(2), {
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
  })
    .then(code => process.exit(code))
    .catch(error => {
      // Name only: a message could echo a connection string.
      console.error(error instanceof Error ? error.name : "Error");
      process.exit(1);
    });
}
