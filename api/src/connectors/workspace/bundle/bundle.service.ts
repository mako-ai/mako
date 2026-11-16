/**
 * Source hash in, bundle out: the pipeline of RFC connector-runtime §5.1.
 *
 * 1. Hash the folder, its lockfile and the SDK version.
 * 2. Return the stored bundle for that hash when there is one.
 * 3. Otherwise build it in the build box and store it under the hash.
 *
 * Callers are the push reconciler (on push to main) and the sync box's run
 * path (a run that finds no bundle for its hash builds it first). Concurrent
 * callers for one hash in this process share one build.
 */
import { ConnectorDefinition } from "../../../database/workspace-schema";
import type { SandboxExecContext } from "../../../apps/sandbox/provider";
import { loggers } from "../../../logging";
import { installConnectorBundle } from "../sync-box";
import { connectorSdkVersion } from "../resolver";
import { buildBundleInBox } from "./build-box";
import { connectorBundlesEnabled } from "./flag";
import { dependencyPlan } from "./manifest";
import { bundleSourceHash } from "./source-hash";
import { readStoredBundle, writeStoredBundle } from "./store";

const logger = loggers.connector();

/** A build that failed. Its message is what the author sees. */
export class BundleBuildError extends Error {
  constructor(
    readonly hash: string,
    readonly reason: string,
  ) {
    super(`Build failed: ${reason}`);
    this.name = "BundleBuildError";
  }
}

/** What the row records about the last build, next to `status`. */
export interface BundleBuildStatus {
  status: "built" | "failed";
  hash: string;
  error?: string;
  bytes?: number;
  builtAt?: Date;
}

/**
 * Does this folder run from a bundle?
 *
 * Only with the flag on, and only a `node` folder that carries a
 * `package.json`. A folder without one runs its TypeScript entry exactly as
 * before, flag or not: that is the no-regression path for every connector
 * written before bundles existed.
 */
export function shouldBundle(
  runtime: string,
  files: ReadonlyMap<string, Uint8Array>,
): boolean {
  return (
    connectorBundlesEnabled() &&
    runtime === "node" &&
    dependencyPlan(files).kind === "npm"
  );
}

export async function connectorBundleHash(
  files: ReadonlyMap<string, Uint8Array>,
): Promise<string> {
  return bundleSourceHash({ files, sdkVersion: await connectorSdkVersion() });
}

const inFlight = new Map<
  string,
  Promise<{ bytes: Uint8Array; built: boolean }>
>();

/**
 * The bundle for a folder: from storage, or built now and stored.
 *
 * Throws {@link BundleBuildError} when the build itself fails. No failure is
 * cached: the next caller tries again, so a registry outage during one build
 * does not stick to the hash.
 */
export async function ensureBundle(input: {
  workspaceId: string;
  slug: string;
  entry: string;
  files: ReadonlyMap<string, Uint8Array>;
  hash?: string;
}): Promise<{ hash: string; bytes: Uint8Array; built: boolean }> {
  const { workspaceId, slug, entry, files } = input;
  const sdkVersion = await connectorSdkVersion();
  const hash = input.hash ?? bundleSourceHash({ files, sdkVersion });
  const key = `${workspaceId}:${hash}`;

  let work = inFlight.get(key);
  if (!work) {
    work = (async () => {
      const stored = await readStoredBundle(workspaceId, hash);
      if (stored) return { bytes: stored, built: false };
      const result = await buildBundleInBox({
        workspaceId,
        slug,
        hash,
        entry,
        files,
      });
      if (!result.ok) throw new BundleBuildError(hash, result.reason);
      await writeStoredBundle({
        workspaceId,
        hash,
        slug,
        sdkVersion,
        bytes: result.bytes,
      });
      return { bytes: result.bytes, built: true };
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, work);
  }
  const { bytes, built } = await work;
  return { hash, bytes, built };
}

/**
 * Put the bundle for a folder into a sync box and say what to run.
 *
 * The box is asked first: one that already holds the hash never reaches
 * object storage or the build box. Otherwise the bundle is fetched, or built
 * first when storage has none.
 */
export async function prepareBundledConnector(input: {
  ctx: SandboxExecContext;
  runtimeId: string;
  workspaceId: string;
  slug: string;
  entry: string;
  files: ReadonlyMap<string, Uint8Array>;
}): Promise<{
  dir: string;
  entry: string;
  hash: string;
  /** Set when this call fetched or built the bundle; absent when the box had it. */
  build?: BundleBuildStatus;
}> {
  const { ctx, runtimeId, workspaceId, slug, entry, files } = input;
  const hash = await connectorBundleHash(files);
  let build: BundleBuildStatus | undefined;
  const installed = await installConnectorBundle({
    ctx,
    runtimeId,
    slug,
    hash,
    load: async () => {
      const bundle = await ensureBundle({
        workspaceId,
        slug,
        entry,
        files,
        hash,
      });
      build = {
        status: "built",
        hash,
        bytes: bundle.bytes.byteLength,
        ...(bundle.built ? { builtAt: new Date() } : {}),
      };
      return bundle.bytes;
    },
  });
  return { ...installed, hash, ...(build ? { build } : {}) };
}

/**
 * Record a run's build outcome on the index row.
 *
 * Keyed on `sourceSha` so a result never lands on code pushed since. A failed
 * build at run time is recorded but does not block the connector: the cause
 * may be the registry or the box, and the next run retries. The push
 * reconciler is what blocks, as it does for a failed `spec`.
 */
export async function recordRunBuild(input: {
  workspaceId: string;
  slug: string;
  sourceSha: string;
  build: BundleBuildStatus;
}): Promise<void> {
  try {
    await ConnectorDefinition.updateOne(
      {
        workspaceId: input.workspaceId,
        slug: input.slug,
        sourceSha: input.sourceSha,
      },
      { $set: { build: input.build } },
    );
  } catch (error) {
    logger.warn("Could not record a connector build status", {
      workspaceId: input.workspaceId,
      slug: input.slug,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
