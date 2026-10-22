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
 * to proxying (see dashboard-materialization.ts). So redirect mode is
 * entered only after the store confirms — installing it if missing — the
 * bucket's CORS rule, once per process, and quietly stays on streaming when
 * it cannot (no permission to read bucket metadata, S3 with no checker).
 *
 * APPS_ARTIFACT_REDIRECTS=on|off overrides the probe in either direction:
 * "on" for a bucket whose CORS an operator configured by hand (or whose
 * service account may not read bucket metadata), "off" as the kill switch.
 *
 * `__data/<name>.parquet` additionally carries a short private cache and a
 * strong ETag of the bytes currently at the key (last content write + size),
 * so a repeat view is 304 and does not mint another signed URL. See
 * PARQUET_BROWSER_CACHE_CONTROL. Uncacheable callers (editor artifact
 * download) still pass `no-store` and get the old 302 behaviour.
 */
import type { DashboardArtifactStore } from "./dashboard-artifact-store.service";
import { loggers } from "../logging";

const logger = loggers.api("artifact-delivery");

export type ArtifactDeliveryMode = "redirect" | "stream";

/**
 * Short on purpose: the URL only needs to outlive the moment between the
 * redirect and the browser's follow-up request — an in-flight download is
 * not cut off at expiry, and a retry re-fetches the route for a fresh URL.
 */
export const SIGNED_URL_TTL_SECONDS = 600;

/**
 * Freshness lifetime of the `__data/<name>.parquet` response itself (the
 * 200 stream or the 302). Strictly less than {@link SIGNED_URL_TTL_SECONDS}
 * so a cached redirect cannot outlive the signature in its Location.
 */
export const PARQUET_CACHE_MAX_AGE_SECONDS = 60;

/**
 * Browser cache for `__data/<name>.parquet`. Always `private`: the URL is
 * session- or token-gated and must never land in a shared cache. Short
 * max-age + must-revalidate so a refresh is visible within a minute.
 */
export const PARQUET_BROWSER_CACHE_CONTROL = `private, max-age=${PARQUET_CACHE_MAX_AGE_SECONDS}, must-revalidate`;

export const PARQUET_BROWSER_CACHE_VARY = "Cookie, Authorization";

/**
 * Query override on the signed bucket URL (`response-cache-control`). Strictly
 * less than the signature TTL so a disk-cached bucket response cannot outlive
 * the URL. Set to TTL − 302 max-age so the two layers expire together.
 */
export const SIGNED_URL_RESPONSE_CACHE_CONTROL = `private, max-age=${
  SIGNED_URL_TTL_SECONDS - PARQUET_CACHE_MAX_AGE_SECONDS
}, must-revalidate`;

/**
 * How often the 302's ETag rotates. A 304 reuses the cached Location; rotating
 * the validator before the signature's last max-age window means we mint a
 * fresh URL rather than 304-ing the browser onto an expired one.
 */
export const REDIRECT_ETAG_PERIOD_SECONDS =
  SIGNED_URL_TTL_SECONDS - 2 * PARQUET_CACHE_MAX_AGE_SECONDS;

const modeByStore = new WeakMap<
  DashboardArtifactStore,
  Promise<ArtifactDeliveryMode>
>();

export async function artifactDeliveryMode(
  store: DashboardArtifactStore,
): Promise<ArtifactDeliveryMode> {
  let mode = modeByStore.get(store);
  if (!mode) {
    mode = resolveMode(store);
    modeByStore.set(store, mode);
  }
  return mode;
}

async function resolveMode(
  store: DashboardArtifactStore,
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

export type ServeParquetArtifactOpts = {
  cacheControl: string;
  /**
   * Extra headers for BOTH response shapes. A route fetched cross-origin
   * (the preview host) must put its Access-Control-Allow-Origin here: in
   * the CORS protocol the redirect response is checked before the browser
   * follows it, so ACAO only on the 200 would break the 302 path.
   */
  extraHeaders?: Record<string, string>;
  /** Conditional GET. Matching a cacheable validator returns 304, no signed URL. */
  ifNoneMatch?: string | null;
  /** SDK `?refresh=` bust — never 304, still emit the current ETag. */
  cacheBust?: boolean;
};

/**
 * Pull the parquet cache knobs off a Hono (or Hono-like) request. Used by
 * every `__data/<name>.parquet` route so If-None-Match / `?refresh=` stay
 * consistent across viewer, preview, and public share.
 */
export function parquetCacheFromRequest(req: {
  header: (name: string) => string | undefined;
  query: (name: string) => string | undefined;
}): Pick<ServeParquetArtifactOpts, "ifNoneMatch" | "cacheBust"> {
  return {
    ifNoneMatch: req.header("If-None-Match"),
    cacheBust: req.query("refresh") !== undefined,
  };
}

/**
 * Browser-facing `__data/<name>.parquet` options: private short cache, Vary
 * so a cookie/Authorization change cannot reuse another caller's 304, plus
 * the request's validators.
 */
export function parquetBrowserServeOptions(
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
  },
  extraHeaders?: Record<string, string>,
): ServeParquetArtifactOpts {
  return {
    cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
    ...parquetCacheFromRequest(req),
    extraHeaders: {
      Vary: PARQUET_BROWSER_CACHE_VARY,
      ...extraHeaders,
    },
  };
}

function isNoStore(cacheControl: string): boolean {
  return /\bno-store\b/i.test(cacheControl);
}

/**
 * Strong ETag of the bytes currently at `key`. Artifact keys are
 * definition-addressed (`apps/bindings/<connectionId>/<definitionHash>.parquet`)
 * and a refresh OVERWRITES the same object, so the key is not the identity of
 * the content. The store's last content write (GCS generation `timeCreated` /
 * filesystem mtime / S3 Last-Modified) plus size is: it changes on rebuild
 * even when the SQL did not, and needs no DB column.
 */
export async function parquetContentETag(
  store: DashboardArtifactStore,
  key: string,
): Promise<string | null> {
  const [modified, size] = await Promise.all([
    store.getLastModified(key),
    store.getSize(key),
  ]);
  if (!modified) return null;
  return `"${modified.getTime().toString(36)}-${(size ?? 0).toString(36)}"`;
}

/** 302 validator: content identity plus a period that expires before the signature. */
export function parquetRedirectETag(
  contentETag: string,
  nowMs = Date.now(),
): string {
  const inner = contentETag.startsWith('"')
    ? contentETag.slice(1, contentETag.endsWith('"') ? -1 : undefined)
    : contentETag;
  const bucket = Math.floor(nowMs / 1000 / REDIRECT_ETAG_PERIOD_SECONDS);
  return `"${inner}.${bucket.toString(36)}"`;
}

export function ifNoneMatchSatisfied(
  header: string | null | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  return header.split(",").some(part => {
    const tag = part.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

function successHeaders(input: {
  cacheControl: string;
  etag: string | null;
  extra?: Record<string, string>;
  location?: string;
  contentType?: string;
  contentLength?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": input.cacheControl,
  };
  if (input.location) headers.Location = input.location;
  if (input.contentType) headers["Content-Type"] = input.contentType;
  if (input.contentLength) headers["Content-Length"] = input.contentLength;
  if (input.etag) {
    headers.ETag = input.etag;
    headers.Vary = PARQUET_BROWSER_CACHE_VARY;
  }
  return { ...headers, ...input.extra };
}

function notModifiedResponse(
  etag: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(null, {
    status: 304,
    headers: successHeaders({
      cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
      etag,
      extra: extraHeaders,
    }),
  });
}

/**
 * Serve one parquet artifact: a 302 to a signed bucket URL when the store
 * supports it, a proxied stream otherwise. Returns null when the artifact
 * does not exist — the route decides what a 404 looks like there (and must
 * not attach cache validators to that 404).
 *
 * When `cacheControl` is cacheable (not `no-store`) and the store can name
 * the current bytes, both shapes carry an ETag. A matching If-None-Match
 * returns 304 without minting a signed URL or opening a stream. A 302's
 * max-age is capped well below the signature TTL; its ETag also rotates
 * before that TTL so a 304 cannot reuse an expired Location.
 */
export async function serveParquetArtifact(
  store: DashboardArtifactStore,
  key: string,
  opts: ServeParquetArtifactOpts,
): Promise<Response | null> {
  const mode = await artifactDeliveryMode(store);
  // Probe existence first: a redirect to a missing object would surface
  // as the bucket's XML 404, not the route's "not materialized".
  if (!(await store.exists(key))) return null;

  const contentTag = await parquetContentETag(store, key);
  const cacheable = Boolean(contentTag) && !isNoStore(opts.cacheControl);
  const redirectValidator =
    cacheable && contentTag ? parquetRedirectETag(contentTag) : null;
  const streamValidator = cacheable ? contentTag : null;
  const validator = mode === "redirect" ? redirectValidator : streamValidator;

  if (
    validator &&
    !opts.cacheBust &&
    ifNoneMatchSatisfied(opts.ifNoneMatch, validator)
  ) {
    return notModifiedResponse(validator, opts.extraHeaders);
  }

  if (mode === "redirect") {
    try {
      const url = await store.getSignedUrl(
        key,
        SIGNED_URL_TTL_SECONDS,
        cacheable
          ? { responseCacheControl: SIGNED_URL_RESPONSE_CACHE_CONTROL }
          : undefined,
      );
      if (url) {
        return new Response(null, {
          status: 302,
          headers: successHeaders({
            location: url,
            cacheControl: cacheable
              ? PARQUET_BROWSER_CACHE_CONTROL
              : "private, no-store",
            etag: redirectValidator,
            extra: opts.extraHeaders,
          }),
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
      headers: successHeaders({
        contentType: "application/vnd.apache.parquet",
        // Parquet readers need the length to find the footer.
        contentLength: size !== null ? String(size) : undefined,
        cacheControl: opts.cacheControl,
        etag: streamValidator,
        extra: opts.extraHeaders,
      }),
    },
  );
}
