/**
 * Bundles in object storage: the artifact store apps and dbt already use
 * (GCS in deployed environments, a directory in development).
 *
 * Layout: `<artifact prefix>/connector-bundles/<workspaceId>/<hash>.mjs`.
 *
 * The hash alone would be enough to name the bytes. The workspace is in the
 * key anyway because a workspace connector is that workspace's code (RFC
 * connectors-as-code §6.4): two workspaces never share a stored artifact, so
 * cleaning one up, or reading one, never involves another. Mako's own
 * connectors get a global namespace with the registry (iteration 4).
 *
 * Bundles are immutable. A key is written once; a second writer that finds
 * the key present leaves it alone.
 */
import {
  getArtifactPrefix,
  getArtifactStore,
} from "../../../services/artifact-store.service";

/** A built bundle is a few hundred KB; a ceiling keeps a bad build bounded. */
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

const HASH = /^[0-9a-f]{64}$/;

export function bundleKey(workspaceId: string, hash: string): string {
  if (!HASH.test(hash)) throw new Error(`Invalid bundle hash: ${hash}`);
  if (!/^[0-9a-f]{24}$/i.test(workspaceId)) {
    throw new Error(`Invalid workspace id: ${workspaceId}`);
  }
  return `${getArtifactPrefix()}/connector-bundles/${workspaceId}/${hash}.mjs`;
}

/** The stored bundle, or null when none has been built for this hash. */
export async function readStoredBundle(
  workspaceId: string,
  hash: string,
): Promise<Uint8Array | null> {
  const store = getArtifactStore();
  const key = bundleKey(workspaceId, hash);
  const opened = store.openRead
    ? await store.openRead(key)
    : (await store.exists(key))
      ? { stream: await store.openReadStream(key), size: null }
      : null;
  if (!opened?.stream) return null;
  if (opened.size !== null && opened.size > MAX_BUNDLE_BYTES) {
    (opened.stream as { destroy?: () => void }).destroy?.();
    throw new Error(
      `Stored bundle ${hash} is ${opened.size} bytes, over the ${MAX_BUNDLE_BYTES} byte limit.`,
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of opened.stream as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buffer.byteLength;
    if (total > MAX_BUNDLE_BYTES) {
      (opened.stream as { destroy?: () => void }).destroy?.();
      throw new Error(
        `Stored bundle ${hash} exceeds the ${MAX_BUNDLE_BYTES} byte limit.`,
      );
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Store a bundle under its hash, once. */
export async function writeStoredBundle(input: {
  workspaceId: string;
  hash: string;
  slug: string;
  sdkVersion: string;
  bytes: Uint8Array;
}): Promise<void> {
  const store = getArtifactStore();
  const key = bundleKey(input.workspaceId, input.hash);
  // Immutable: two replicas building the same hash produce the same input,
  // and the first one stored wins.
  if (await store.exists(key)) return;
  await store.putBuffer(input.bytes, key, "text/javascript", {
    slug: input.slug,
    sdkVersion: input.sdkVersion,
    builtAt: new Date().toISOString(),
  });
}
