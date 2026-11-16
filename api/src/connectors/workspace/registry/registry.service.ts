/**
 * Install by reference: `source: mako/<slug>@<range>` -> one registry bundle.
 *
 * The push reconciler resolves a reference to the newest published version in
 * its range and records that version on the `ConnectorDefinition`. Every later
 * command (check, discover, read) runs the recorded version, never "whatever
 * is newest now": a sync that began on 1.2.0 finishes on 1.2.0, exactly as a
 * workspace connector finishes on the commit it began with.
 *
 * Upgrades follow from that. A patch or minor release inside the range
 * resolves on the next reconcile and changes the row's `sourceSha`, so `spec`
 * runs again on the new code. A major release is outside the range, so it is
 * only recorded as `upgradeAvailable`; bumping the range is the workspace's
 * commit to make.
 */
import type { SandboxExecContext } from "../../../apps/sandbox/provider";
import { installConnectorBundle } from "../sync-box";
import {
  maxSatisfying,
  maxVersion,
  parseVersion,
  type RegistryReference,
} from "./semver";
import {
  readCatalog,
  readRegistryBundle,
  type RegistryCatalog,
  type RegistryEntry,
  type RegistryVersion,
} from "./store";

/** What the `ConnectorDefinition` row records about a reference. */
export interface RegistryResolution {
  /** The reference as written: `mako/stripe@1`. */
  ref: string;
  /** The registry slug, which may differ from the workspace folder's. */
  slug: string;
  range: string;
  /** The version this workspace runs. */
  version: string;
  /** Its source hash: the bundle's name in storage. */
  hash: string;
  /** sha256 of the bundle bytes. */
  sha256: string;
  /** The newest published version, in range or not. */
  latest: string;
  /** Set when a newer MAJOR exists outside the range. */
  upgradeAvailable?: string;
  resolvedAt: Date;
}

const CATALOG_TTL_MS = 60_000;
let cached: { at: number; catalog: RegistryCatalog } | null = null;

/**
 * The catalog. Cached for a minute for the agent tools; the push reconciler
 * passes `fresh` so a release is picked up on the very next push.
 */
export async function getRegistryCatalog(
  options: { fresh?: boolean } = {},
): Promise<RegistryCatalog> {
  if (!options.fresh && cached && Date.now() - cached.at < CATALOG_TTL_MS) {
    return cached.catalog;
  }
  const catalog = await readCatalog();
  cached = { at: Date.now(), catalog };
  return catalog;
}

/** Forget the cached catalog (tests, and after a publish in-process). */
export function clearRegistryCatalogCache(): void {
  cached = null;
}

export type ResolveResult =
  | {
      ok: true;
      entry: RegistryEntry;
      version: RegistryVersion;
      resolution: RegistryResolution;
    }
  | { ok: false; reason: string };

export function resolveReference(
  reference: RegistryReference,
  catalog: RegistryCatalog,
): ResolveResult {
  // Own keys only: `mako/constructor@1` must not find Object.prototype's.
  const entry = Object.hasOwn(catalog.connectors, reference.slug)
    ? catalog.connectors[reference.slug]
    : undefined;
  if (!entry || !Array.isArray(entry.versions) || entry.versions.length === 0) {
    const known = Object.keys(catalog.connectors).sort();
    return {
      ok: false,
      reason:
        `The registry has no connector mako/${reference.slug}. ` +
        (known.length
          ? `Published: ${known.map(slug => `mako/${slug}`).join(", ")}.`
          : "Nothing is published yet."),
    };
  }
  const published = entry.versions.map(version => version.version);
  const chosen = maxSatisfying(published, reference.range);
  if (!chosen) {
    return {
      ok: false,
      reason:
        `No version of mako/${reference.slug} matches @${reference.range.text}. ` +
        `Published: ${published.join(", ")}.`,
    };
  }
  const version = entry.versions.find(
    candidate => candidate.version === chosen,
  );
  if (!version) {
    return { ok: false, reason: `mako/${reference.slug}@${chosen} vanished.` };
  }
  const latest = maxVersion(published) ?? chosen;
  const latestMajor = parseVersion(latest)?.major ?? 0;
  const chosenMajor = parseVersion(chosen)?.major ?? 0;
  return {
    ok: true,
    entry,
    version,
    resolution: {
      ref: reference.text,
      slug: reference.slug,
      range: reference.range.text,
      version: version.version,
      hash: version.hash,
      sha256: version.sha256,
      latest,
      ...(latestMajor > chosenMajor ? { upgradeAvailable: latest } : {}),
      resolvedAt: new Date(),
    },
  };
}

/** The box directory key: never the same as a workspace bundle's. */
export function registryBoxSlug(slug: string): string {
  return `mako.${slug}`;
}

/**
 * Put a resolved registry bundle in a sync box and say what to run. The box
 * is asked first; object storage is read only when the box lacks the hash,
 * and the bytes are checked against the recorded sha256 before they go in.
 */
export async function prepareRegistryConnector(input: {
  ctx: SandboxExecContext;
  runtimeId: string;
  registry: Pick<RegistryResolution, "slug" | "version" | "hash" | "sha256">;
}): Promise<{ dir: string; entry: string }> {
  const { ctx, runtimeId, registry } = input;
  return installConnectorBundle({
    ctx,
    runtimeId,
    slug: registryBoxSlug(registry.slug),
    hash: registry.hash,
    load: () => readRegistryBundle(registry.slug, registry),
  });
}
