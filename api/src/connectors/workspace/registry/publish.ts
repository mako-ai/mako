/**
 * Publish one top-level `connectors/<slug>/` folder of the Mako repo to the
 * registry (RFC connector-runtime §7, iteration 4).
 *
 * The release workflow runs this on a tag `connector-<slug>-v<version>`:
 *
 * 1. Collect the folder's published files: everything but `node_modules/`,
 *    `fixtures/` and tests. Those files are what a workspace gets on eject.
 * 2. Hash them with the iteration-1 source hash and build them with the
 *    iteration-1 bundler (`buildBundleInBox`), so a registry bundle is made
 *    exactly as a workspace bundle of the same folder would be.
 * 3. Run `spec` and `discover` on the BUILT bundle in a sync box: the catalog
 *    entry describes the bytes that will run, not the TypeScript.
 * 4. Unless it is a dry run, store the bundle and the source under the hash
 *    and add the version to `catalog.json`.
 *
 * A version is immutable. Re-publishing the same version with the same hash
 * is a no-op; with a different hash it is refused.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getSandboxProvider } from "../../../apps/sandbox/provider";
import { loggers } from "../../../logging";
import { parseConnectorFile, validateSpec } from "../connector-file";
import { buildBundleInBox } from "../bundle/build-box";
import { dependencyPlan } from "../bundle/manifest";
import { bundleSourceHash } from "../bundle/source-hash";
import { connectorSdkVersion, ensureConnectorRuntime } from "../resolver";
import {
  failureMessage,
  firstOfType,
  installConnectorBundle,
  runConnectorCommand,
  syncBoxContext,
} from "../sync-box";
import { registryBoxSlug } from "./registry.service";
import { parseVersion, sortVersionsDescending } from "./semver";
import {
  CatalogConflictError,
  catalogGeneration,
  readCatalog,
  sha256Hex,
  sourceDocumentBytes,
  writeCatalogIfUnchanged,
  writeRegistryArtifacts,
  type RegistrySource,
  type RegistryAuthType,
  type RegistryCatalog,
  type RegistryEntry,
  type RegistryVersion,
} from "./store";

const logger = loggers.connector();

/** The box key the release builds and runs in. Never a workspace's. */
export const REGISTRY_BOX_KEY = "mako-registry";

/** The workspace folder cap, so an ejected folder is always indexable. */
const MAX_PUBLISHED_BYTES = 2 * 1024 * 1024;

const SKIPPED_DIRECTORIES = new Set(["node_modules", "fixtures", ".git"]);
const SKIPPED_FILE = /(^|\/)\.DS_Store$|\.test\.[cm]?[jt]s$/;

/** The files a release publishes, keyed by path relative to the folder. */
export async function collectPublishedFiles(
  folder: string,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          await walk(path.join(dir, entry.name), relative);
        }
        continue;
      }
      if (!entry.isFile() || SKIPPED_FILE.test(relative)) continue;
      const bytes = new Uint8Array(
        await fs.readFile(path.join(dir, entry.name)),
      );
      total += bytes.byteLength;
      if (total > MAX_PUBLISHED_BYTES) {
        throw new Error(
          `${folder} publishes more than ${MAX_PUBLISHED_BYTES} bytes; a workspace could not eject it.`,
        );
      }
      files.set(relative, bytes);
    }
  };
  await walk(folder, "");
  return files;
}

/** api_key when a field is a secret, oauth2 when the spec says so, else none. */
export function authTypeOf(spec: Record<string, unknown>): RegistryAuthType {
  if (spec.advanced_auth || spec.authSpecification) return "oauth2";
  const properties = (
    spec.connectionSpecification as { properties?: Record<string, unknown> }
  )?.properties;
  const secret = Object.values(properties ?? {}).some(
    property =>
      (property as { airbyte_secret?: unknown } | null)?.airbyte_secret ===
      true,
  );
  return secret ? "api_key" : "none";
}

/**
 * The CHANGELOG.md section for one version: the lines under a heading that
 * names it (`## 1.2.0` or `## [1.2.0] - 2026-11-16`), up to the next heading
 * of the same or a higher level.
 */
export function changelogFor(
  markdown: string | undefined,
  version: string,
): string | undefined {
  if (!markdown) return undefined;
  const lines = markdown.split("\n");
  const escaped = version.replace(/\./g, "\\.");
  const heading = new RegExp(`^(#{1,6})\\s+\\[?v?${escaped}\\]?(\\s|$)`);
  const start = lines.findIndex(line => heading.test(line));
  const level = start < 0 ? 0 : (heading.exec(lines[start])?.[1].length ?? 0);
  if (level === 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const next = /^(#{1,6})\s/.exec(line);
    if (next && next[1].length <= level) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text || undefined;
}

export interface PublishResult {
  slug: string;
  version: string;
  hash: string;
  /** False on a dry run, and when the same version and hash already exist. */
  published: boolean;
  alreadyPublished: boolean;
  entry: RegistryVersion;
}

/** One built release: everything the registry stores, before it is stored. */
export interface Release {
  /** The catalog entry, with this one version. */
  entry: RegistryEntry;
  record: RegistryVersion;
  bundle: Uint8Array;
  source: RegistrySource;
}

/**
 * Build and describe one connector folder. Runs the connector's own code
 * (`npm ci`, `spec`, `discover`) and touches no storage, so the release
 * workflow runs it in a job that holds no credential.
 */
export async function buildRelease(input: {
  /** Absolute path of `connectors/<slug>/`. */
  folder: string;
  slug: string;
  version: string;
  commit?: string;
}): Promise<Release> {
  const { folder, slug, version, commit } = input;
  if (!parseVersion(version)) {
    throw new Error(
      `"${version}" is not a release version; use MAJOR.MINOR.PATCH, e.g. 1.0.0.`,
    );
  }

  const files = await collectPublishedFiles(folder);
  const yaml = files.get("connector.yaml");
  if (!yaml) throw new Error(`${folder} has no connector.yaml.`);
  const parsed = parseConnectorFile(new TextDecoder().decode(yaml));
  if (!parsed.ok) throw new Error(parsed.reason);
  if (/^\s*source\s*:/m.test(new TextDecoder().decode(yaml))) {
    throw new Error(
      "A published connector holds code; its connector.yaml must not use `source`.",
    );
  }
  const entry = parsed.value.entry;
  if (!files.has(entry)) {
    throw new Error(`connector.yaml points at ${entry}, which is not there.`);
  }
  const plan = dependencyPlan(files);
  if (plan.kind !== "npm") {
    throw new Error(
      plan.kind === "invalid"
        ? plan.reason
        : "A registry connector is built from package.json and package-lock.json; add both.",
    );
  }

  const sdkVersion = await connectorSdkVersion();
  const hash = bundleSourceHash({ files, sdkVersion });

  const built = await buildBundleInBox({
    workspaceId: REGISTRY_BOX_KEY,
    slug,
    hash,
    entry,
    files,
  });
  if (!built.ok) throw new Error(`Build failed: ${built.reason}`);

  const described = await describeBundle({ slug, hash, bytes: built.bytes });
  if (described.version !== version) {
    throw new Error(
      `The tag says ${version} but the connector's spec says ${described.version ?? "nothing"}. ` +
        `Set version: "${version}" in defineConnector (and package.json), then tag again.`,
    );
  }

  const changelogText = files.get("CHANGELOG.md");
  const changelog = changelogFor(
    changelogText ? new TextDecoder().decode(changelogText) : undefined,
    version,
  );
  const record: RegistryVersion = {
    version,
    hash,
    sha256: sha256Hex(built.bytes),
    bytes: built.bytes.byteLength,
    sdkVersion,
    entry,
    entities: described.entities,
    authType: described.authType,
    ...(changelog ? { changelog } : {}),
    publishedAt: new Date().toISOString(),
    ...(commit ? { commit } : {}),
  };
  return {
    record,
    bundle: built.bytes,
    source: {
      slug,
      version,
      hash,
      entry,
      files: Object.fromEntries(
        [...files].map(([name, bytes]) => [
          name,
          Buffer.from(bytes).toString("base64"),
        ]),
      ),
    },
    entry: {
      slug,
      name: described.name ?? slug,
      ...(described.title ? { title: described.title } : {}),
      ...(parsed.value.page?.vendor
        ? { vendor: parsed.value.page.vendor }
        : {}),
      ...(parsed.value.page?.category
        ? { category: parsed.value.page.category }
        : {}),
      ...(parsed.value.page?.docs ? { docs: parsed.value.page.docs } : {}),
      versions: [record],
    },
  };
}

/** What crosses from the build job to the publish job, next to the bytes. */
interface ReleaseManifest {
  slug: string;
  version: string;
  hash: string;
  bundleSha256: string;
  sourceSha256: string;
  entry: RegistryEntry;
}

/** Write a built release to a directory, for the publish job. */
export async function writeReleaseDir(
  dir: string,
  release: Release,
): Promise<string> {
  const target = path.join(
    dir,
    `${release.entry.slug}-${release.record.version}`,
  );
  await fs.mkdir(target, { recursive: true });
  const source = sourceDocumentBytes(release.source);
  const manifest: ReleaseManifest = {
    slug: release.entry.slug,
    version: release.record.version,
    hash: release.record.hash,
    bundleSha256: sha256Hex(release.bundle),
    sourceSha256: sha256Hex(source),
    entry: release.entry,
  };
  await fs.writeFile(path.join(target, "bundle.mjs"), release.bundle);
  await fs.writeFile(path.join(target, "source.json"), source);
  await fs.writeFile(
    path.join(target, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return target;
}

/**
 * Read a release directory back, and re-verify it: the bundle's and the
 * source's sha256 against the manifest, the catalog record against the
 * manifest, and the source hash recomputed from the source files. Runs no
 * connector code.
 */
export async function readReleaseDir(dir: string): Promise<Release> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as ReleaseManifest;
  const bundle = new Uint8Array(
    await fs.readFile(path.join(dir, "bundle.mjs")),
  );
  const sourceBytes = new Uint8Array(
    await fs.readFile(path.join(dir, "source.json")),
  );
  const fail = (what: string): never => {
    throw new Error(`Release ${dir} failed verification: ${what}.`);
  };
  if (sha256Hex(bundle) !== manifest.bundleSha256) fail("bundle sha256");
  if (sha256Hex(sourceBytes) !== manifest.sourceSha256) fail("source sha256");
  const versions = manifest.entry?.versions ?? [];
  const record = versions[0];
  if (versions.length !== 1 || !record) fail("the entry must hold one version");
  if (record.version !== manifest.version) fail("version");
  if (record.hash !== manifest.hash) fail("hash");
  if (record.sha256 !== manifest.bundleSha256) fail("record sha256");
  if (record.bytes !== bundle.byteLength) fail("byte count");
  if (manifest.entry.slug !== manifest.slug) fail("slug");
  const source = JSON.parse(
    Buffer.from(sourceBytes).toString("utf8"),
  ) as RegistrySource;
  if (
    source.slug !== manifest.slug ||
    source.version !== manifest.version ||
    source.hash !== manifest.hash
  ) {
    fail("source identity");
  }
  const files = new Map(
    Object.entries(source.files).map(([name, base64]) => [
      name,
      new Uint8Array(Buffer.from(base64, "base64")),
    ]),
  );
  const recomputed = bundleSourceHash({
    files,
    sdkVersion: record.sdkVersion,
  });
  if (recomputed !== manifest.hash) fail("source hash recomputed from files");
  return { entry: manifest.entry, record, bundle, source };
}

/**
 * Tie an artifact to the release that was asked for. The build job ran
 * connector code, so nothing in its artifact is trusted beyond the bundle
 * bytes themselves:
 *
 * - exactly one release directory, named for the tag's slug and version;
 * - the manifest's slug, version and commit are the tag's;
 * - every source file equals the file in the checked-out folder at the
 *   tagged commit, byte for byte, and no file is added or missing;
 * - the SDK version is this checkout's, so the recomputed source hash is the
 *   hash of the repository's own folder.
 *
 * A dependency that tampers with the build can therefore change at most the
 * bundle of the connector being released, never another connector, version
 * or source.
 */
export async function readExpectedRelease(input: {
  root: string;
  slug: string;
  version: string;
  commit?: string;
  folder: string;
}): Promise<Release> {
  const { root, slug, version, commit, folder } = input;
  const entries = (await fs.readdir(root, { withFileTypes: true })).map(
    entry => entry.name,
  );
  const expectedDir = `${slug}-${version}`;
  if (entries.length !== 1 || entries[0] !== expectedDir) {
    throw new Error(
      `The release artifact must hold exactly ${expectedDir}/; it holds ${entries.join(", ") || "nothing"}.`,
    );
  }
  const release = await readReleaseDir(path.join(root, expectedDir));
  if (release.entry.slug !== slug || release.record.version !== version) {
    throw new Error(
      `The artifact is mako/${release.entry.slug}@${release.record.version}, not the tagged mako/${slug}@${version}.`,
    );
  }
  if (commit && release.record.commit !== commit) {
    throw new Error(
      `The artifact was built from ${release.record.commit ?? "an unknown commit"}, not the tagged ${commit}.`,
    );
  }
  const sdkVersion = await connectorSdkVersion();
  if (release.record.sdkVersion !== sdkVersion) {
    throw new Error(
      `The artifact names @makoai/connector-sdk ${release.record.sdkVersion}; the tagged commit ships ${sdkVersion}.`,
    );
  }
  const expected = await collectPublishedFiles(folder);
  const shipped = release.source.files;
  const names = new Set([...expected.keys(), ...Object.keys(shipped)]);
  for (const name of names) {
    const want = expected.get(name);
    const got = Object.hasOwn(shipped, name)
      ? Buffer.from(shipped[name], "base64")
      : undefined;
    if (!want || !got || !Buffer.from(want).equals(got)) {
      throw new Error(
        `The artifact's source differs from connectors/${slug}/ at the tagged commit: ${name}.`,
      );
    }
  }
  if (release.source.entry !== release.record.entry) {
    throw new Error("The artifact's source and record name different entries.");
  }
  return release;
}

/**
 * Store a verified release: the bundle and source created once, then the
 * version added to the catalog. Runs no connector code; this is all the
 * publish job's credential is used for.
 *
 * Immutability is checked on every attempt of the catalog loop, against the
 * catalog as it is at that moment: a version already present with another
 * hash or sha256 fails, and one present with the same is a no-op.
 */
export async function uploadRelease(release: Release): Promise<PublishResult> {
  const { record } = release;
  const slug = release.entry.slug;
  await writeRegistryArtifacts({
    slug,
    hash: record.hash,
    bundle: release.bundle,
    source: release.source,
  });
  for (let attempt = 1; ; attempt++) {
    const generation = await catalogGeneration();
    const latest = await readCatalog();
    const existing = publishedVersion(latest, slug, record.version);
    if (existing) {
      assertSameRelease(slug, existing, record);
      logger.info("Connector version already published", {
        slug,
        version: record.version,
      });
      return {
        slug,
        version: record.version,
        hash: record.hash,
        published: false,
        alreadyPublished: true,
        entry: existing,
      };
    }
    try {
      await writeCatalogIfUnchanged(
        withVersion(latest, release.entry),
        generation,
      );
      break;
    } catch (error) {
      if (!(error instanceof CatalogConflictError) || attempt >= 5) throw error;
      logger.warn("Registry catalog changed during a release; merging again", {
        slug,
        version: record.version,
        attempt,
      });
    }
  }
  logger.info("Published a connector to the registry", {
    slug,
    version: record.version,
    hash: record.hash,
    bytes: record.bytes,
  });
  return {
    slug,
    version: record.version,
    hash: record.hash,
    published: true,
    alreadyPublished: false,
    entry: record,
  };
}

/** Build, then upload unless it is a dry run. For development and the gate. */
export async function publishConnector(input: {
  folder: string;
  slug: string;
  version: string;
  dryRun?: boolean;
  commit?: string;
}): Promise<PublishResult> {
  const release = await buildRelease(input);
  if (input.dryRun) {
    return {
      slug: input.slug,
      version: input.version,
      hash: release.record.hash,
      published: false,
      alreadyPublished: false,
      entry: release.record,
    };
  }
  return uploadRelease(release);
}

function publishedVersion(
  catalog: RegistryCatalog,
  slug: string,
  version: string,
): RegistryVersion | undefined {
  if (!Object.hasOwn(catalog.connectors, slug)) return undefined;
  return catalog.connectors[slug].versions.find(v => v.version === version);
}

function assertSameRelease(
  slug: string,
  existing: RegistryVersion,
  record: RegistryVersion,
): void {
  if (existing.hash !== record.hash || existing.sha256 !== record.sha256) {
    throw new Error(
      `mako/${slug}@${record.version} is already published with hash ${existing.hash.slice(0, 12)} ` +
        `(sha256 ${existing.sha256.slice(0, 12)}), and this release is ${record.hash.slice(0, 12)} ` +
        `(sha256 ${record.sha256.slice(0, 12)}). A version is immutable: bump the version and tag again.`,
    );
  }
}

/** Add one version to the catalog, newest first; the entry's metadata follows the newest. */
export function withVersion(
  catalog: RegistryCatalog,
  published: RegistryEntry,
): RegistryCatalog {
  const current = Object.hasOwn(catalog.connectors, published.slug)
    ? catalog.connectors[published.slug]
    : undefined;
  // Never replace a version silently: the same one may be merged again, a
  // different one under the same number fails.
  for (const version of published.versions) {
    const existing = current?.versions.find(v => v.version === version.version);
    if (existing) assertSameRelease(published.slug, existing, version);
  }
  const versions = [
    ...(current?.versions ?? []).filter(
      v => !published.versions.some(p => p.version === v.version),
    ),
    ...published.versions,
  ];
  const order = sortVersionsDescending(versions.map(v => v.version));
  const sorted = order.flatMap(version =>
    versions.filter(v => v.version === version).slice(0, 1),
  );
  const newest = sorted[0]?.version;
  const metadata =
    !current || published.versions.some(v => v.version === newest)
      ? { ...published }
      : { ...current };
  return {
    ...catalog,
    updatedAt: new Date().toISOString(),
    connectors: {
      ...catalog.connectors,
      [published.slug]: { ...metadata, versions: sorted },
    },
  };
}

/** Run `spec` and `discover` on a built bundle, in a sync box. */
async function describeBundle(input: {
  slug: string;
  hash: string;
  bytes: Uint8Array;
}): Promise<{
  name?: string;
  title?: string;
  version?: string;
  entities: string[];
  authType: RegistryAuthType;
}> {
  const ctx = syncBoxContext(REGISTRY_BOX_KEY);
  const runtimeId = await ensureConnectorRuntime(ctx);
  const { dir, entry } = await installConnectorBundle({
    ctx,
    runtimeId,
    slug: registryBoxSlug(input.slug),
    hash: input.hash,
    load: async () => input.bytes,
  });

  const spec = await runConnectorCommand({
    ctx,
    runtimeId,
    connectorDir: dir,
    entry,
    command: "spec",
    timeoutMs: 60_000,
  });
  const specFailure = failureMessage(spec);
  if (specFailure) throw new Error(`spec failed: ${specFailure}`);
  const specMessage = firstOfType<{ spec?: Record<string, unknown> }>(
    spec.messages,
    "SPEC",
  )?.spec;
  const valid = validateSpec(specMessage);
  if (!valid.ok || !specMessage) {
    throw new Error(valid.ok ? "spec emitted no SPEC message." : valid.reason);
  }

  // `discover` without a credential: a published connector must describe its
  // streams without calling its vendor, or the picker could not show them.
  const discover = await runConnectorCommand({
    ctx,
    runtimeId,
    connectorDir: dir,
    entry,
    command: "discover",
    config: {},
    timeoutMs: 60_000,
  });
  const discoverFailure = failureMessage(discover);
  if (discoverFailure) throw new Error(`discover failed: ${discoverFailure}`);
  const streams = (
    firstOfType<{ catalog?: { streams?: Array<{ name?: unknown }> } }>(
      discover.messages,
      "CATALOG",
    )?.catalog?.streams ?? []
  )
    .map(stream => stream?.name)
    .filter((name): name is string => typeof name === "string");
  if (streams.length === 0) {
    throw new Error("discover returned no streams.");
  }

  const mako = (specMessage.mako ?? {}) as {
    name?: string;
    version?: string;
  };
  const title = (
    specMessage.connectionSpecification as { title?: unknown } | undefined
  )?.title;
  return {
    name: mako.name,
    title: typeof title === "string" ? title : undefined,
    version: mako.version,
    entities: streams,
    authType: authTypeOf(specMessage),
  };
}

/** Tear down the release's boxes (the local provider's directories in CI). */
export async function cleanupPublishBoxes(): Promise<void> {
  const provider = getSandboxProvider();
  // Each build box is torn down by the build itself; the sync box is not.
  const ctx = syncBoxContext(REGISTRY_BOX_KEY);
  await provider.destroySession?.(ctx.sessionKey).catch(() => undefined);
}
