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

/**
 * Serve one parquet artifact: a 302 to a signed bucket URL when the store
 * supports it, a proxied stream otherwise. Returns null when the artifact
 * does not exist — the route decides what a 404 looks like there.
 */
export async function serveParquetArtifact(
  store: DashboardArtifactStore,
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
  },
): Promise<Response | null> {
  if ((await artifactDeliveryMode(store)) === "redirect") {
    try {
      // Probe existence first: a redirect to a missing object would surface
      // as the bucket's XML 404, not the route's "not materialized".
      if (!(await store.exists(key))) return null;
      const url = await store.getSignedUrl(key, SIGNED_URL_TTL_SECONDS);
      if (url) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: url,
            // Never cache the redirect itself: the signature inside expires.
            "Cache-Control": "private, no-store",
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
