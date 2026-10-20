/**
 * Durable thumbnail variants: card WebPs and the Open Graph JPEG, shared by
 * every API instance through the artifact store.
 *
 * Why: a variant was cached per process only, so the first request for an
 * app's picture on a fresh Cloud Run instance had to clone the workspace
 * mirror (5–7 s on prod) before it could even read the blob — long enough
 * for WhatsApp/Slack to give up on the unfurl. A variant is a pure function
 * of an immutable blob, so it is stored once under a key derived from the
 * blob oid and the recipe, and every instance serves it from there:
 *
 *   in-process LRU  →  artifact store  →  generate (git blob + sharp) → store
 *
 * and main moving pre-generates the variants a crawler and the Apps home
 * will ask for (`warmThumbnailVariants`), so the first hit is a store hit.
 */
import type { AppThumbnailRef, AppsIndexSnapshot } from "./app-index.service";
import { readThumbnailBlob, thumbnailContentType } from "./app-thumbnail";
import { freshenForServe } from "./cloud-repo.service";
import {
  cachedVariant,
  imageSize,
  toOgJpeg,
  toWebpVariant,
  variantCache,
  type ImageVariant,
} from "./image-variants";
import { boundRepoDirIfExists } from "./workspace-repo-required";
import {
  getArtifactPrefix,
  getArtifactStore,
} from "../services/artifact-store.service";
import { loggers } from "../logging";

const logger = loggers.api("apps-thumbnail-variants");

/** What can be derived from a thumbnail: a card width, or the OG picture. */
export type VariantKind = { kind: "og" } | { kind: "width"; width: number };

const OG: VariantKind = { kind: "og" };
/** What the Apps home asks for first (AppThumbnail's `src`). */
const CARD: VariantKind = { kind: "width", width: 640 };

function variantName(v: VariantKind): string {
  return v.kind === "og" ? "og.jpg" : `w${v.width}.webp`;
}

/**
 * The store key. Workspace-scoped (so a workspace's variants can be listed
 * or dropped together) and content-addressed by oid: immutable, so never
 * rewritten and never stale.
 */
export function variantStoreKey(
  workspaceId: string,
  oid: string,
  v: VariantKind,
): string {
  return `${getArtifactPrefix()}/app-thumbnails/${workspaceId}/${oid}/${variantName(v)}`;
}

/** Phase timings of one variant lookup, for Server-Timing and slow logs. */
export class Timings {
  private readonly started = Date.now();
  readonly phases: Array<[string, number]> = [];
  source: "lru" | "store" | "generated" | "fallback" | "none" = "none";

  async time<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      this.phases.push([phase, Date.now() - t]);
    }
  }

  get totalMs(): number {
    return Date.now() - this.started;
  }

  /** `Server-Timing` value: each phase plus the cache outcome. */
  header(): string {
    return [
      ...this.phases.map(([p, ms]) => `${p};dur=${ms}`),
      `src;desc=${this.source}`,
      `total;dur=${this.totalMs}`,
    ].join(", ");
  }
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

async function readStored(key: string): Promise<Buffer | null> {
  try {
    const stream = await getArtifactStore().openReadStream(key);
    return stream ? await readStream(stream) : null;
  } catch (error) {
    // Missing objects surface as stream errors on some stores.
    logger.debug("thumbnail variant not in store", { key, error });
    return null;
  }
}

/**
 * The thumbnail blob from the workspace repo. A blob the local clone does
 * not have yet (the index rows came from an instance that saw a newer
 * main) gets one forced mirror fetch before giving up.
 */
async function readBlob(
  workspaceId: string,
  thumbnail: AppThumbnailRef,
  timings: Timings,
): Promise<Buffer | null> {
  // A read, not a write: no repo simply means no picture (null, not a skip).
  const repoDir = await timings.time("repo", () =>
    boundRepoDirIfExists(workspaceId),
  );
  const read = () =>
    repoDir ? readThumbnailBlob(repoDir, thumbnail) : Promise.resolve(null);
  const bytes = await timings.time("blob", read);
  if (bytes || !repoDir) return bytes;
  await timings.time("fetch", () =>
    freshenForServe(workspaceId, 0).catch(() => undefined),
  );
  return read();
}

async function generate(
  source: Buffer,
  thumbnail: AppThumbnailRef,
  v: VariantKind,
): Promise<ImageVariant | null> {
  if (v.kind === "width") return toWebpVariant(source, v.width);
  const jpeg = await toOgJpeg(source);
  // An original that already is a JPEG smaller than the re-encode stays.
  if (
    jpeg &&
    thumbnailContentType(thumbnail.file) === "image/jpeg" &&
    source.length <= jpeg.bytes.length
  ) {
    return {
      bytes: source,
      contentType: "image/jpeg",
      ...(imageSize(source) ?? {}),
      transformed: true,
    };
  }
  return jpeg;
}

/** Content type of a stored variant, from its name. */
function storedContentType(v: VariantKind): string {
  return v.kind === "og" ? "image/jpeg" : "image/webp";
}

/**
 * A raster thumbnail's variant: LRU, then the artifact store, then built
 * from the blob and written back to the store (not awaited — the response
 * never waits on an upload). When the encoder cannot handle the image the
 * original bytes come back with `transformed: false`, and nothing is stored.
 * Null when the blob is gone.
 */
export async function getThumbnailVariant(
  workspaceId: string,
  thumbnail: AppThumbnailRef,
  v: VariantKind,
  timings: Timings = new Timings(),
): Promise<ImageVariant | null> {
  const key = variantStoreKey(workspaceId, thumbnail.oid, v);
  if (variantCache.get(key)) timings.source = "lru";
  const out = await cachedVariant(key, async () => {
    const stored = await timings.time("store", () => readStored(key));
    if (stored) {
      timings.source = "store";
      return {
        bytes: stored,
        contentType: storedContentType(v),
        ...(imageSize(stored) ?? {}),
        transformed: true,
      };
    }
    const source = await readBlob(workspaceId, thumbnail, timings);
    if (!source) return null;
    const built = await timings.time("encode", () =>
      generate(source, thumbnail, v),
    );
    if (!built) {
      timings.source = "fallback";
      return {
        bytes: source,
        contentType: thumbnailContentType(thumbnail.file) ?? "image/png",
        ...(imageSize(source) ?? {}),
        transformed: false,
      };
    }
    timings.source = "generated";
    void getArtifactStore()
      .putBuffer(built.bytes, key, built.contentType, {
        oid: thumbnail.oid,
        variant: variantName(v),
      })
      .catch(error =>
        logger.warn("storing thumbnail variant failed", { key, error }),
      );
    return built;
  });
  if (timings.totalMs > 1000) {
    logger.info("slow thumbnail variant", {
      workspaceId,
      oid: thumbnail.oid,
      variant: variantName(v),
      timing: timings.header(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pre-warm
// ---------------------------------------------------------------------------

/** (workspace → main sha) already warmed by this process. */
const warmedAt = new Map<string, string>();
const warming = new Map<string, Promise<void>>();

function isRaster(file: string): boolean {
  const type = thumbnailContentType(file);
  return !!type && type !== "image/svg+xml";
}

/**
 * Make sure every raster thumbnail on main has its stored variants: the OG
 * JPEG for workspace-tree apps (the only ones that unfurl) and the 640-wide
 * card WebP for all. Store hits are cheap existence checks; misses build
 * from the local repo (the caller just read main, so it is there).
 * Sequential on purpose: background work must not compete with requests.
 */
export async function warmThumbnailVariants(
  workspaceId: string,
  apps: AppsIndexSnapshot["apps"],
): Promise<{ checked: number; generated: number }> {
  const store = getArtifactStore();
  let checked = 0;
  let generated = 0;
  for (const app of apps) {
    const thumb = app.thumbnail;
    if (!thumb || !isRaster(thumb.file)) continue;
    const wanted = app.scope === "workspace" ? [OG, CARD] : [CARD];
    for (const v of wanted) {
      checked++;
      const key = variantStoreKey(workspaceId, thumb.oid, v);
      if (variantCache.get(key)) continue;
      if (await store.exists(key).catch(() => false)) continue;
      const timings = new Timings();
      const out = await getThumbnailVariant(workspaceId, thumb, v, timings);
      if (out && timings.source === "generated") generated++;
    }
  }
  return { checked, generated };
}

/** Whether main-moved pre-warming runs in this process. */
export function warmEnabled(): boolean {
  const flag = process.env.APPS_THUMBNAIL_WARM;
  if (flag) return flag !== "0" && flag !== "false";
  // Off under the test runner: suites call warmThumbnailVariants directly.
  return !process.env.VITEST;
}

/**
 * Fire-and-forget pre-warm, once per (workspace, main sha) per process.
 * Called whenever the apps index is read, so a push (whose deploy-on-push
 * reads the index) warms the new posters, and the first index read after a
 * deploy backfills whatever an earlier version never stored.
 */
export function scheduleThumbnailWarm(
  workspaceId: string,
  snapshot: AppsIndexSnapshot,
): void {
  if (!snapshot.sha || !warmEnabled()) return;
  if (warmedAt.get(workspaceId) === snapshot.sha) return;
  if (warming.has(workspaceId)) return;
  warmedAt.set(workspaceId, snapshot.sha);
  const run = warmThumbnailVariants(workspaceId, snapshot.apps)
    .then(({ checked, generated }) => {
      if (generated > 0) {
        logger.info("thumbnail variants warmed", {
          workspaceId,
          sha: snapshot.sha,
          checked,
          generated,
        });
      }
    })
    .catch(error => {
      // Try again on the next index read.
      warmedAt.delete(workspaceId);
      logger.warn("thumbnail warm failed", { workspaceId, error });
    })
    .finally(() => warming.delete(workspaceId));
  warming.set(workspaceId, run);
}

/** Tests: forget what this process has warmed. */
export function resetThumbnailWarmState(): void {
  warmedAt.clear();
  warming.clear();
}
