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
import { inngest } from "../inngest/client";
import { noteTiming, timed } from "../middleware/server-timing";

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

/** Where a variant came from — the `thumb.src` note on Server-Timing. */
export type VariantSource = "lru" | "store" | "generated" | "fallback";

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
): Promise<Buffer | null> {
  // A read, not a write: no repo simply means no picture (null, not a skip).
  const repoDir = await timed("thumb.repo", () =>
    boundRepoDirIfExists(workspaceId),
  );
  const read = () =>
    repoDir ? readThumbnailBlob(repoDir, thumbnail) : Promise.resolve(null);
  const bytes = await timed("thumb.blob", read);
  if (bytes || !repoDir) return bytes;
  await timed("thumb.fetch", () =>
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
 * A raster thumbnail's variant and where it came from: LRU, then the
 * artifact store, then built from the blob and written back to the store
 * (not awaited — the response never waits on an upload). When the encoder
 * cannot handle the image the original bytes come back with
 * `transformed: false`, and nothing is stored. Null when the blob is gone.
 * Steps are `thumb.*` spans of the request's Server-Timing (#1117 helper).
 */
export async function resolveThumbnailVariant(
  workspaceId: string,
  thumbnail: AppThumbnailRef,
  v: VariantKind,
): Promise<{ variant: ImageVariant; source: VariantSource } | null> {
  const key = variantStoreKey(workspaceId, thumbnail.oid, v);
  let source: VariantSource = "lru";
  const variant = await cachedVariant(key, async () => {
    const stored = await timed("thumb.store", () => readStored(key));
    if (stored) {
      source = "store";
      return {
        bytes: stored,
        contentType: storedContentType(v),
        ...(imageSize(stored) ?? {}),
        transformed: true,
      };
    }
    const original = await readBlob(workspaceId, thumbnail);
    if (!original) return null;
    const built = await timed("thumb.encode", () =>
      generate(original, thumbnail, v),
    );
    if (!built) {
      source = "fallback";
      return {
        bytes: original,
        contentType: thumbnailContentType(thumbnail.file) ?? "image/png",
        ...(imageSize(original) ?? {}),
        transformed: false,
      };
    }
    source = "generated";
    void getArtifactStore()
      .putBuffer(built.bytes, key, built.contentType, {
        oid: thumbnail.oid,
        variant: variantName(v),
      })
      .catch(error =>
        logger.warn("storing thumbnail variant failed", {
          key,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return built;
  });
  if (!variant) return null;
  noteTiming("thumb.src", source);
  return { variant, source };
}

/** The variant only (see resolveThumbnailVariant). */
export async function getThumbnailVariant(
  workspaceId: string,
  thumbnail: AppThumbnailRef,
  v: VariantKind,
): Promise<ImageVariant | null> {
  return (
    (await resolveThumbnailVariant(workspaceId, thumbnail, v))?.variant ?? null
  );
}

// ---------------------------------------------------------------------------
// Pre-warm
// ---------------------------------------------------------------------------

/** (workspace → main sha) this process has already asked to warm. */
const warmRequested = new Map<string, string>();

/**
 * The event that runs the warm (inngest/functions/apps-thumbnail-warm).
 * `workspaceId: "*"` means every workspace with thumbnails (the backfill).
 * An Inngest function rather than in-process fire-and-forget: Cloud Run
 * here bills CPU per request, so background work after a response is
 * starved — a mirror clone that takes ~6 s in a request timed out at 30 s.
 */
export const THUMBNAIL_WARM_EVENT = "apps/thumbnails.warm";
export interface ThumbnailWarmEventData {
  workspaceId: string;
  sha?: string;
}

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
      const out = await resolveThumbnailVariant(workspaceId, thumb, v);
      if (out?.source === "generated") generated++;
    }
  }
  return { checked, generated };
}

/** Whether pre-warm requests are sent from this process. */
export function warmEnabled(): boolean {
  const flag = process.env.APPS_THUMBNAIL_WARM;
  if (flag) return flag !== "0" && flag !== "false";
  // Off under the test runner: suites call warmThumbnailVariants directly.
  return !process.env.VITEST;
}

/** Ask the warm function to run (debounced per workspace there). */
export function requestThumbnailWarm(data: ThumbnailWarmEventData): void {
  if (!warmEnabled()) return;
  void inngest.send({ name: THUMBNAIL_WARM_EVENT, data }).catch(error =>
    logger.warn("could not request a thumbnail warm", {
      workspaceId: data.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

/**
 * Pre-warm once per (workspace, main sha) per process. Called whenever an
 * instance's apps index moves to a new main (a push, or this instance's
 * first index read), so new posters are stored before anyone asks.
 */
export function scheduleThumbnailWarm(
  workspaceId: string,
  snapshot: AppsIndexSnapshot,
): void {
  if (!snapshot.sha) return;
  if (warmRequested.get(workspaceId) === snapshot.sha) return;
  warmRequested.set(workspaceId, snapshot.sha);
  requestThumbnailWarm({ workspaceId, sha: snapshot.sha });
}

/** Tests: forget what this process has asked for. */
export function resetThumbnailWarmState(): void {
  warmRequested.clear();
}
