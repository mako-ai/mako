/**
 * The connector registry in object storage (RFC connector-runtime §7).
 *
 * The same artifact store connector bundles use (GCS in deployed environments,
 * a directory in development), under a Mako-owned prefix that is NOT the
 * per-environment artifact prefix: one registry serves every environment
 * reading the bucket, the way one npm registry serves every install.
 *
 *   <prefix>/catalog.json                    the catalog: every connector, every version
 *   <prefix>/<slug>/bundles/<hash>.mjs       one built bundle per source hash
 *   <prefix>/<slug>/sources/<hash>.json      the folder that bundle was built from (eject)
 *
 * `<prefix>` is CONNECTOR_REGISTRY_PREFIX, default `connector-registry`.
 * `<hash>` is the iteration-1 source hash (bundle/source-hash.ts) of the
 * published files, so a bundle is named exactly as a workspace bundle of the
 * same folder would be. Bundles and sources are immutable: written once, never
 * replaced. Only `catalog.json` is rewritten, by the release workflow, which
 * runs one publish at a time.
 *
 * Why a JSON manifest rather than a Mongo collection: the release workflow is
 * the only writer and it already holds storage credentials, not database
 * ones; every environment reads the same bucket; and the catalog is a few KB
 * per connector that the API caches for a minute.
 */
import { createHash } from "node:crypto";
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

async function readBytes(key: string, limit: number): Promise<Buffer | null> {
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
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of opened.stream as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;
    if (total > limit) {
      (opened.stream as { destroy?: () => void }).destroy?.();
      throw new Error(`${key} exceeds ${limit} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
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

export async function writeCatalog(catalog: RegistryCatalog): Promise<void> {
  await getArtifactStore().putBuffer(
    Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`),
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

/** Write a bundle and its source once; an existing key is left alone. */
export async function writeRegistryArtifacts(input: {
  slug: string;
  hash: string;
  bundle: Uint8Array;
  source: RegistrySource;
}): Promise<void> {
  const store = getArtifactStore();
  const bundleKey = registryBundleKey(input.slug, input.hash);
  if (!(await store.exists(bundleKey))) {
    await store.putBuffer(input.bundle, bundleKey, "text/javascript", {
      slug: input.slug,
      version: input.source.version,
    });
  }
  const sourceKey = registrySourceKey(input.slug, input.hash);
  if (!(await store.exists(sourceKey))) {
    await store.putBuffer(
      Buffer.from(JSON.stringify(input.source)),
      sourceKey,
      "application/json",
      { slug: input.slug, version: input.source.version },
    );
  }
}
