/* eslint-disable no-console, no-process-exit */
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
 *   --workspace <24-hex id>   only that workspace
 *
 * Environment (process only; no .env file is loaded):
 *   DATABASE_URL      Mongo.
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
import mongoose from "mongoose";
import { decryptString } from "../services/crypto.service";
import { DatabaseConnection } from "../database/models/database-connections";
import { SourceConnection } from "../database/models/source-connections";
import { Workspace } from "../database/models/workspace";

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
    text = null;
    parsed = null;
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

export const USAGE = `Usage: check-google-credential-types.ts (--dry-run | ${DECRYPT_FLAG}) [--workspace <24-hex id>]
  --dry-run   count candidates per workspace and type; decrypts nothing
  ${DECRYPT_FLAG}
              decrypt every candidate credential in memory and classify it`;

export class UsageError extends Error {}

export interface CheckOptions {
  dryRun: boolean;
  workspace?: string;
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
    else if (arg === "--workspace") opts.workspace = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!opts.dryRun && !decrypts) {
    throw new UsageError("Pass --dry-run or " + DECRYPT_FLAG);
  }
  if (opts.workspace !== undefined && !/^[0-9a-f]{24}$/i.test(opts.workspace)) {
    throw new Error("--workspace needs a 24-hex workspace id");
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

  const filter = opts.workspace
    ? { workspaceId: new mongoose.Types.ObjectId(opts.workspace) }
    : {};

  const sources: Array<[Kind, AsyncIterable<StoredDoc>]> = [
    [
      "database",
      DatabaseConnection.collection.find(filter, {
        projection: {
          workspaceId: 1,
          type: 1,
          connection: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      }) as unknown as AsyncIterable<StoredDoc>,
    ],
    [
      "source",
      SourceConnection.collection.find(filter, {
        projection: {
          workspaceId: 1,
          type: 1,
          config: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      }) as unknown as AsyncIterable<StoredDoc>,
    ],
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

  const ids = [...new Set([...groups.values()].map(g => g.workspaceId))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const rows = await Workspace.collection
      .find(
        { _id: { $in: ids.map(i => new mongoose.Types.ObjectId(i)) } },
        { projection: { name: 1 } },
      )
      .toArray();
    for (const r of rows) names.set(String(r._id), String(r.name ?? ""));
  }

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
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!opts.dryRun && !("ENCRYPTION_KEY" in env)) {
    throw new Error("ENCRYPTION_KEY is not set");
  }
  await mongoose.connect(url);
  try {
    await runCheck(opts, io);
  } finally {
    await mongoose.disconnect();
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
