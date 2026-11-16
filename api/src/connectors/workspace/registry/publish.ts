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
import { buildBundleInBox, buildBoxContext } from "../bundle/build-box";
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
  writeCatalogIfUnchanged,
  writeRegistryArtifacts,
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

export async function publishConnector(input: {
  /** Absolute path of `connectors/<slug>/`. */
  folder: string;
  slug: string;
  version: string;
  dryRun?: boolean;
  commit?: string;
}): Promise<PublishResult> {
  const { folder, slug, version, dryRun = false, commit } = input;
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

  const catalog = await readCatalog();
  const existing = catalog.connectors[slug]?.versions.find(
    candidate => candidate.version === version,
  );
  if (existing && existing.hash !== hash) {
    throw new Error(
      `mako/${slug}@${version} is already published with hash ${existing.hash.slice(0, 12)}, and this folder hashes to ${hash.slice(0, 12)}. ` +
        `A version is immutable: bump the version and tag again.`,
    );
  }
  if (existing && !dryRun) {
    logger.info("Connector version already published", { slug, version });
    return {
      slug,
      version,
      hash,
      published: false,
      alreadyPublished: true,
      entry: existing,
    };
  }

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

  if (dryRun) {
    return {
      slug,
      version,
      hash,
      published: false,
      alreadyPublished: Boolean(existing),
      entry: record,
    };
  }

  await writeRegistryArtifacts({
    slug,
    hash,
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
  });
  // Read, merge, and write only if nobody wrote in between; on a conflict,
  // merge again onto what the other release wrote.
  const published: RegistryEntry = {
    slug,
    name: described.name ?? slug,
    ...(described.title ? { title: described.title } : {}),
    ...(parsed.value.page?.vendor ? { vendor: parsed.value.page.vendor } : {}),
    ...(parsed.value.page?.category
      ? { category: parsed.value.page.category }
      : {}),
    ...(parsed.value.page?.docs ? { docs: parsed.value.page.docs } : {}),
    versions: [record],
  };
  for (let attempt = 1; ; attempt++) {
    const generation = await catalogGeneration();
    const latest = await readCatalog();
    try {
      await writeCatalogIfUnchanged(withVersion(latest, published), generation);
      break;
    } catch (error) {
      if (!(error instanceof CatalogConflictError) || attempt >= 5) throw error;
      logger.warn("Registry catalog changed during a release; merging again", {
        slug,
        version,
        attempt,
      });
    }
  }
  logger.info("Published a connector to the registry", {
    slug,
    version,
    hash,
    bytes: record.bytes,
  });
  return {
    slug,
    version,
    hash,
    published: true,
    alreadyPublished: false,
    entry: record,
  };
}

/** Add one version to the catalog, newest first; the entry's metadata follows the newest. */
export function withVersion(
  catalog: RegistryCatalog,
  published: RegistryEntry,
): RegistryCatalog {
  const current = catalog.connectors[published.slug];
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
  for (const ctx of [
    buildBoxContext(REGISTRY_BOX_KEY),
    syncBoxContext(REGISTRY_BOX_KEY),
  ]) {
    await provider.destroySession?.(ctx.sessionKey).catch(() => undefined);
  }
}
