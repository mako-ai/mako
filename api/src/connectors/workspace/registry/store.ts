/**
 * The connector registry in object storage (RFC connector-runtime §7).
 *
 * GCS in deployed environments: CONNECTOR_REGISTRY_BUCKET when set (the
 * recommended dedicated bucket), else the artifact bucket bundles use
 * (GCS_DASHBOARD_BUCKET with DASHBOARD_ARTIFACT_STORE=gcs). A directory, through
 * the artifact store, in development and tests. Always under a Mako-owned
 * prefix that is NOT the per-environment artifact prefix: one registry serves
 * every environment reading the bucket, the way one npm registry serves every
 * install.
 *
 *   <prefix>/catalog.json                    the catalog: every connector, every version
 *   <prefix>/<slug>/bundles/<hash>.mjs       one built bundle per source hash
 *   <prefix>/<slug>/sources/<hash>.json      the folder that bundle was built from (eject)
 *
 * `<prefix>` is CONNECTOR_REGISTRY_PREFIX, default `connector-registry`.
 * `<hash>` is the iteration-1 source hash (bundle/source-hash.ts) of the
 * published files, so a bundle is named exactly as a workspace bundle of the
 * same folder would be. Bundles and sources are immutable: created with
 * `ifGenerationMatch: 0`, and an existing object is accepted only when its
 * stored bytes hash to what this release built. Only `catalog.json` is
 * rewritten, with `ifGenerationMatch` on the generation it was read at.
 *
 * Why a JSON manifest rather than a Mongo collection: the release workflow is
 * the only writer and it already holds storage credentials, not database
 * ones; every environment reads the same bucket; and the catalog is a few KB
 * per connector that the API caches for a minute.
 */
import { createHash } from "node:crypto";
import { Storage } from "@google-cloud/storage";
import { getArtifactStore } from "../../../services/artifact-store.service";
import { MAX_BUNDLE_BYTES } from "../bundle/store";

export const CATALOG_SCHEMA_VERSION = 1;

/** A catalog or a source document larger than this is refused on read. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

const HASH = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z][a-z0-9-]{0,63}$/;

/** What a connector needs to authenticate, read from its `spec`. */
export type RegistryAuthType = "api_key" | "oauth2" | "none";

export interface RegistryVersion {
  version: string;
  /** Source hash: names the bundle and the source in storage. */
  hash: string;
  /** sha256 of the bundle bytes, checked on every read. */
  sha256: string;
  bytes: number;
  /** The @makoai/connector-sdk version the bundle was built and run against. */
  sdkVersion: string;
  /** The folder's entry file, for eject. */
  entry: string;
  /** Stream names from `discover`. */
  entities: string[];
  /** From `spec`. */
  authType: RegistryAuthType;
  /** The CHANGELOG.md section for this version, when the folder has one. */
  changelog?: string;
  publishedAt: string;
  /** The Mako commit the release was built from. */
  commit?: string;
}

export interface RegistryEntry {
  slug: string;
  name: string;
  title?: string;
  vendor?: string;
  category?: string;
  docs?: string;
  /** Newest first. */
  versions: RegistryVersion[];
}

export interface RegistryCatalog {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  updatedAt: string;
  connectors: Record<string, RegistryEntry>;
}

/** The published source of one version: every file, base64. */
export interface RegistrySource {
  slug: string;
  version: string;
  hash: string;
  entry: string;
  files: Record<string, string>;
}

export function registryPrefix(): string {
  const raw = process.env.CONNECTOR_REGISTRY_PREFIX?.trim();
  return (raw || "connector-registry").replace(/^\/+|\/+$/g, "");
}

function checkSlug(slug: string): string {
  if (!SLUG.test(slug)) throw new Error(`Invalid registry slug: ${slug}`);
  return slug;
}

function checkHash(hash: string): string {
  if (!HASH.test(hash)) throw new Error(`Invalid bundle hash: ${hash}`);
  return hash;
}

export const catalogKey = (): string => `${registryPrefix()}/catalog.json`;

export const registryBundleKey = (slug: string, hash: string): string =>
  `${registryPrefix()}/${checkSlug(slug)}/bundles/${checkHash(hash)}.mjs`;

export const registrySourceKey = (slug: string, hash: string): string =>
  `${registryPrefix()}/${checkSlug(slug)}/sources/${checkHash(hash)}.json`;

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The bucket the registry lives in on GCS, or null for the artifact store. */
function registryBucket(): string | null {
  const dedicated = process.env.CONNECTOR_REGISTRY_BUCKET?.trim();
  if (dedicated) return dedicated;
  // The variable the artifact store itself is built from.
  if (process.env.DASHBOARD_ARTIFACT_STORE !== "gcs") return null;
  return process.env.GCS_DASHBOARD_BUCKET?.trim() || null;
}

let storage: Storage | null = null;
function gcsFile(bucket: string, key: string) {
  storage ??= new Storage();
  return storage.bucket(bucket).file(key);
}

const isPreconditionFailure = (error: unknown): boolean =>
  (error as { code?: unknown }).code === 412;

async function streamToBuffer(
  stream: NodeJS.ReadableStream,
  key: string,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;
    if (total > limit) {
      (stream as { destroy?: () => void }).destroy?.();
      throw new Error(`${key} exceeds ${limit} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readBytes(key: string, limit: number): Promise<Buffer | null> {
  const bucket = registryBucket();
  if (bucket) {
    const file = gcsFile(bucket, key);
    let size: number;
    try {
      const [metadata] = await file.getMetadata();
      size = Number(metadata.size);
    } catch (error) {
      if ((error as { code?: unknown }).code === 404) return null;
      throw error;
    }
    if (size > limit) {
      throw new Error(`${key} is ${size} bytes, over ${limit}.`);
    }
    return streamToBuffer(file.createReadStream(), key, limit);
  }
  const store = getArtifactStore();
  const opened = store.openRead
    ? await store.openRead(key)
    : (await store.exists(key))
      ? { stream: await store.openReadStream(key), size: null }
      : null;
  if (!opened?.stream) return null;
  if (opened.size !== null && opened.size > limit) {
    (opened.stream as { destroy?: () => void }).destroy?.();
    throw new Error(`${key} is ${opened.size} bytes, over ${limit}.`);
  }
  return streamToBuffer(opened.stream, key, limit);
}

/**
 * Create `key` only if it does not exist (`ifGenerationMatch: 0` on GCS).
 * When it exists, the STORED bytes must hash to `bytes`' sha256, or this
 * throws: a published object is never replaced, and a release never records
 * a hash the stored object does not have.
 */
async function createImmutable(
  key: string,
  bytes: Uint8Array,
  contentType: string,
  limit: number,
): Promise<"created" | "matched"> {
  const wanted = sha256Hex(bytes);
  const bucket = registryBucket();
  let created = false;
  if (bucket) {
    try {
      await gcsFile(bucket, key).save(Buffer.from(bytes), {
        contentType,
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      });
      created = true;
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
    }
  } else {
    // Development and tests: no generations; exists-then-write is enough
    // for a single local writer.
    const store = getArtifactStore();
    if (!(await store.exists(key))) {
      await store.putBuffer(bytes, key, contentType);
      created = true;
    }
  }
  if (created) return "created";
  const stored = await readBytes(key, limit);
  const storedSha = stored ? sha256Hex(stored) : "missing";
  if (storedSha !== wanted) {
    throw new Error(
      `${key} already exists with sha256 ${storedSha.slice(0, 12)}, and this release built ${wanted.slice(0, 12)}. ` +
        "Published objects are immutable; refusing to record a hash the stored object does not have.",
    );
  }
  return "matched";
}

export function emptyCatalog(): RegistryCatalog {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    connectors: {},
  };
}

/** The stored catalog; an empty one when nothing was ever published. */
export async function readCatalog(): Promise<RegistryCatalog> {
  const bytes = await readBytes(catalogKey(), MAX_DOCUMENT_BYTES);
  if (!bytes) return emptyCatalog();
  const parsed = JSON.parse(bytes.toString("utf8")) as RegistryCatalog;
  if (parsed?.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error(
      `The connector registry catalog has schemaVersion ${String(parsed?.schemaVersion)}; this Mako reads ${CATALOG_SCHEMA_VERSION}.`,
    );
  }
  return parsed;
}

/** The live catalog's generation: 0 when absent, null when the store has none. */
export async function catalogGeneration(): Promise<number | null> {
  const bucket = registryBucket();
  if (!bucket) return null;
  const file = gcsFile(bucket, catalogKey());
  try {
    const [metadata] = await file.getMetadata();
    return Number(metadata.generation);
  } catch (error) {
    if ((error as { code?: unknown }).code === 404) return 0;
    throw error;
  }
}

/** Another writer replaced the catalog between our read and our write. */
export class CatalogConflictError extends Error {
  constructor() {
    super("The registry catalog changed while this release was writing it.");
    this.name = "CatalogConflictError";
  }
}

const catalogBytes = (catalog: RegistryCatalog): Buffer =>
  Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);

/**
 * Write the catalog only if it is still at `generation` (GCS
 * `ifGenerationMatch`; 0 means "only if absent"). Two releases racing on the
 * read-modify-write then cannot drop each other's version: the loser gets
 * {@link CatalogConflictError} and merges again. Stores without generations
 * (the filesystem one, in development and tests) write unconditionally.
 */
export async function writeCatalogIfUnchanged(
  catalog: RegistryCatalog,
  generation: number | null,
): Promise<void> {
  const bucket = registryBucket();
  if (!bucket || generation === null) return writeCatalog(catalog);
  try {
    await gcsFile(bucket, catalogKey()).save(catalogBytes(catalog), {
      contentType: "application/json",
      resumable: false,
      preconditionOpts: { ifGenerationMatch: generation },
    });
  } catch (error) {
    if (isPreconditionFailure(error)) throw new CatalogConflictError();
    throw error;
  }
}

/** Unconditional write: development, tests, and stores without generations. */
export async function writeCatalog(catalog: RegistryCatalog): Promise<void> {
  const bucket = registryBucket();
  if (bucket) {
    await gcsFile(bucket, catalogKey()).save(catalogBytes(catalog), {
      contentType: "application/json",
      resumable: false,
    });
    return;
  }
  await getArtifactStore().putBuffer(
    catalogBytes(catalog),
    catalogKey(),
    "application/json",
  );
}

/**
 * A published bundle, verified against the sha256 the catalog recorded.
 * Throws when it is missing or does not match: a registry entry whose bytes
 * changed under it must never run.
 */
export async function readRegistryBundle(
  slug: string,
  version: Pick<RegistryVersion, "hash" | "sha256" | "version">,
): Promise<Uint8Array> {
  const bytes = await readBytes(
    registryBundleKey(slug, version.hash),
    MAX_BUNDLE_BYTES,
  );
  if (!bytes) {
    throw new Error(
      `The registry has no bundle for mako/${slug}@${version.version} (${version.hash.slice(0, 12)}).`,
    );
  }
  if (sha256Hex(bytes) !== version.sha256) {
    throw new Error(
      `The registry bundle for mako/${slug}@${version.version} does not match its recorded sha256; refusing to run it.`,
    );
  }
  return new Uint8Array(bytes);
}

export async function readRegistrySource(
  slug: string,
  hash: string,
): Promise<RegistrySource | null> {
  const bytes = await readBytes(
    registrySourceKey(slug, hash),
    MAX_DOCUMENT_BYTES,
  );
  return bytes ? (JSON.parse(bytes.toString("utf8")) as RegistrySource) : null;
}

/** The bytes a source document is stored as: what its sha256 covers. */
export function sourceDocumentBytes(source: RegistrySource): Uint8Array {
  return Buffer.from(JSON.stringify(source));
}

/**
 * Store a bundle and its source, each created once. An object that already
 * exists must hold exactly these bytes, or this throws.
 */
export async function writeRegistryArtifacts(input: {
  slug: string;
  hash: string;
  bundle: Uint8Array;
  source: RegistrySource;
}): Promise<{ bundle: "created" | "matched"; source: "created" | "matched" }> {
  const bundle = await createImmutable(
    registryBundleKey(input.slug, input.hash),
    input.bundle,
    "text/javascript",
    MAX_BUNDLE_BYTES,
  );
  const source = await createImmutable(
    registrySourceKey(input.slug, input.hash),
    sourceDocumentBytes(input.source),
    "application/json",
    MAX_DOCUMENT_BYTES,
  );
  return { bundle, source };
}
