/**
 * How a materialized parquet artifact reaches the browser.
 *
 * Redirect mode answers the serve route with a 302 to a short-lived signed
 * bucket URL, so the bytes go bucket→browser directly: the API pays one small
 * lookup per file instead of proxying whole streams, the bucket supplies
 * Content-Length (progress for free) and native Range support, and a page
 * loading dozens of parquet files in parallel is bounded by the bucket, not
 * by one Node process. Stream mode proxies through the API exactly as
 * before — the filesystem store has no URLs to sign, and it is the safe
 * fallback whenever redirecting cannot be proven safe.
 *
 * "Proven safe" is about CORS: the request a browser makes after following a
 * cross-origin redirect carries an Origin header, and if the bucket has no
 * CORS rule the browser downloads the response and then refuses to hand it
 * to the page. That is exactly why an earlier signed-URL attempt retreated
 * to proxying (in the since-removed dashboards artifact route). So redirect mode is
 * entered only after the store confirms — installing it if missing — the
 * bucket's CORS rule, once per process, and quietly stays on streaming when
 * it cannot (no permission to read bucket metadata, S3 with no checker).
 *
 * APPS_ARTIFACT_REDIRECTS=on|off overrides the probe in either direction:
 * "on" for a bucket whose CORS an operator configured by hand (or whose
 * service account may not read bucket metadata), "off" as the kill switch.
 */
import type { ArtifactStore } from "./artifact-store.service";
import { stableWindow } from "../apps/app-origin";
import { loggers } from "../logging";

const logger = loggers.api("artifact-delivery");

export type ArtifactDeliveryMode = "redirect" | "stream";

/**
 * Short on purpose: the URL only needs to outlive the moment between the
 * redirect and the browser's follow-up request — an in-flight download is
 * not cut off at expiry, and a retry re-fetches the route for a fresh URL.
 */
export const SIGNED_URL_TTL_SECONDS = 600;

const modeByStore = new WeakMap<ArtifactStore, Promise<ArtifactDeliveryMode>>();

export async function artifactDeliveryMode(
  store: ArtifactStore,
): Promise<ArtifactDeliveryMode> {
  let mode = modeByStore.get(store);
  if (!mode) {
    mode = resolveMode(store);
    modeByStore.set(store, mode);
  }
  return mode;
}

async function resolveMode(
  store: ArtifactStore,
): Promise<ArtifactDeliveryMode> {
  const override = (process.env.APPS_ARTIFACT_REDIRECTS || "").toLowerCase();
  if (override === "off" || override === "false" || override === "0") {
    return "stream";
  }
  if (override === "on" || override === "true" || override === "1") {
    return store.type === "filesystem" ? "stream" : "redirect";
  }
  if (!store.ensureBrowserCors) return "stream";
  try {
    if (await store.ensureBrowserCors()) {
      logger.info("Artifact delivery: signed-URL redirects active", {
        storeType: store.type,
      });
      return "redirect";
    }
  } catch (error) {
    logger.warn(
      "Artifact delivery: could not verify bucket CORS; streaming through " +
        "the API instead. Run `pnpm artifacts:cors` with credentials that " +
        "may update the bucket, or set APPS_ARTIFACT_REDIRECTS=on once its " +
        "CORS is known good.",
      { storeType: store.type, error },
    );
  }
  return "stream";
}

/**
 * The longest a browser may reuse a stable redirect: until two minutes
 * before the signed URL inside it expires, and never more than ten minutes,
 * which bounds how long a re-pointed binding could keep resolving to its
 * previous key.
 */
export const STABLE_REDIRECT_MAX_AGE_SECONDS = 600;
const STABLE_REDIRECT_MARGIN_SECONDS = 120;

function redirectCacheControl(remainingMs: number): string {
  const maxAge = Math.min(
    STABLE_REDIRECT_MAX_AGE_SECONDS,
    Math.floor(remainingMs / 1000) - STABLE_REDIRECT_MARGIN_SECONDS,
  );
  return maxAge > 0 ? `private, max-age=${maxAge}` : "private, no-store";
}

/**
 * A signed read URL for `key`. Without `stable.windowMs`: valid for
 * SIGNED_URL_TTL_SECONDS from now, a new string every call. With it: fixed
 * for the window (see serveParquetArtifact's `stable`), so every call inside
 * one window returns the same string and the browser cache can answer it.
 * `expiresAt` is set only for a stable URL. Throws when signing fails.
 */
export async function signArtifactUrl(
  store: ArtifactStore,
  key: string,
  stable?: { windowMs?: number; now?: number },
): Promise<{ url: string | null; expiresAt: number | null }> {
  if (!stable?.windowMs) {
    return {
      url: await store.getSignedUrl(key, SIGNED_URL_TTL_SECONDS),
      expiresAt: null,
    };
  }
  const window = stableWindow(stable.now ?? Date.now(), stable.windowMs);
  // The window's own end plus the usual short TTL: a URL handed out in the
  // window's last second still outlives the follow-up request.
  const expiresAt = window.end + SIGNED_URL_TTL_SECONDS * 1000;
  const url = await store.getSignedUrl(key, SIGNED_URL_TTL_SECONDS, {
    accessibleAt: new Date(window.start),
    expiresAt: new Date(expiresAt),
  });
  return { url, expiresAt };
}

/**
 * Serve one parquet artifact: a 302 to a signed bucket URL when the store
 * supports it, a proxied stream otherwise. Returns null when the artifact
 * does not exist — the route decides what a 404 looks like there.
 */
export async function serveParquetArtifact(
  store: ArtifactStore,
  key: string,
  opts: {
    cacheControl: string;
    /**
     * Extra headers for BOTH response shapes. A route fetched cross-origin
     * (the preview host) must put its Access-Control-Allow-Origin here: in
     * the CORS protocol the redirect response is checked before the browser
     * follows it, so ACAO only on the 200 would break the 302 path.
     */
    extraHeaders?: Record<string, string>;
    /**
     * Sign a URL that is fixed for this window rather than for "now", and let
     * the browser keep the redirect until shortly before that URL expires.
     * Only worth it where the browser cache works at all (an app on its own
     * origin, app-origin.ts): an opaque-origin frame caches nothing.
     *
     * Correctness: artifact keys are definition-addressed and overwritten in
     * place on refresh, so one URL can name new bytes. GCS answers a signed
     * read of a non-public object with `Cache-Control: private, max-age=0`
     * plus an ETag, so the browser revalidates every use: unchanged data is a
     * 304 with no body, refreshed data a 200 with the new bytes.
     */
    stable?: { windowMs: number; now?: number };
  },
): Promise<Response | null> {
  if ((await artifactDeliveryMode(store)) === "redirect") {
    try {
      // Probe existence first: a redirect to a missing object would surface
      // as the bucket's XML 404, not the route's "not materialized".
      if (!(await store.exists(key))) return null;
      const now = opts.stable?.now ?? Date.now();
      const { url, expiresAt } = await signArtifactUrl(store, key, {
        ...opts.stable,
        now,
      });
      if (url) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: url,
            "Cache-Control": expiresAt
              ? redirectCacheControl(expiresAt - now)
              : // Never cache the redirect itself: the signature inside expires.
                "private, no-store",
            ...opts.extraHeaders,
          },
        });
      }
    } catch (error) {
      // Signing can fail on its own (e.g. GCS needs a private key or
      // iam signBlob permission). The artifact is still servable — degrade
      // to the proxied stream rather than 500 every data request.
      logger.warn(
        "Artifact delivery: signing failed; streaming this response. If " +
          "this repeats, the service account cannot sign URLs — set " +
          "APPS_ARTIFACT_REDIRECTS=off or grant signBlob.",
        { storeType: store.type, error },
      );
    }
  }

  const stream = await store.openReadStream(key);
  if (!stream) return null;
  const size = await store.getSize(key);
  const { Readable } = await import("node:stream");
  return new Response(
    Readable.toWeb(stream as InstanceType<typeof Readable>) as ReadableStream,
    {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apache.parquet",
        // Parquet readers need the length to find the footer.
        ...(size !== null ? { "Content-Length": String(size) } : {}),
        "Cache-Control": opts.cacheControl,
        ...opts.extraHeaders,
      },
    },
  );
}

/**
 * Serve a small JSON artifact (binding snapshots, capped near 200 KiB).
 * Read through the API, never redirected: a signed-URL hop would cost more
 * than the bytes. Buffered, so the length comes from the bytes and the store
 * sees one read, no size probe. Null when missing (an artifact built before
 * snapshots, or one whose column types a snapshot cannot carry).
 */
export async function serveJsonArtifact(
  store: ArtifactStore,
  key: string,
  opts: {
    cacheControl: string;
    extraHeaders?: Record<string, string>;
  },
): Promise<Response | null> {
  const stream = await store.openReadStream(key);
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const body = Buffer.concat(chunks);
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(body.length),
      "Cache-Control": opts.cacheControl,
      ...opts.extraHeaders,
    },
  });
}
