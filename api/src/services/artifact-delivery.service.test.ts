/**
 * Artifact delivery — redirect vs stream.
 *
 * The properties worth pinning: a bucket that answers browser CORS gets a
 * 302 whose Location is the signed URL; uncacheable callers still forbid
 * caching that (expiring) signature, while `__data` callers get a short
 * private max-age + ETag and If-None-Match → 304 without a new signature;
 * every "cannot prove it's safe" path — no CORS checker, checker says no,
 * checker throws, signing throws, env kill switch — degrades to the exact
 * proxied stream we served before, never to an error; and a missing
 * artifact is null (the route's 404), not a redirect to the bucket's XML
 * 404 and not a cacheable error.
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { DashboardArtifactStore } from "./dashboard-artifact-store.service";
import {
  artifactDeliveryMode,
  ifNoneMatchSatisfied,
  parquetCacheFromRequest,
  PARQUET_BROWSER_CACHE_CONTROL,
  PARQUET_BROWSER_CACHE_VARY,
  PARQUET_CACHE_MAX_AGE_SECONDS,
  parquetContentETag,
  parquetRedirectETag,
  REDIRECT_ETAG_PERIOD_SECONDS,
  serveParquetArtifact,
  SIGNED_URL_RESPONSE_CACHE_CONTROL,
  SIGNED_URL_TTL_SECONDS,
} from "./artifact-delivery.service";

function fakeStore(
  overrides: Partial<DashboardArtifactStore> & {
    type: DashboardArtifactStore["type"];
  },
): DashboardArtifactStore {
  return {
    exists: async () => true,
    put: async () => undefined,
    putBuffer: async () => undefined,
    getSignedUrl: async () => "https://bucket.example/signed?sig=abc",
    openReadStream: async () => Readable.from([Buffer.from("PAR1-bytes")]),
    getSize: async () => 10,
    getLastModified: async () => null,
    delete: async () => undefined,
    ...overrides,
  };
}

async function testRedirectsWhenBucketCorsConfirmed() {
  let requestedTtl: number | undefined;
  const store = fakeStore({
    type: "gcs",
    ensureBrowserCors: async () => true,
    getSignedUrl: async (_key, ttl) => {
      requestedTtl = ttl;
      return "https://bucket.example/signed?sig=abc";
    },
  });
  const res = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: "no-store",
    extraHeaders: { "Access-Control-Allow-Origin": "*" },
  });
  assert.ok(res);
  assert.equal(res.status, 302);
  assert.equal(
    res.headers.get("Location"),
    "https://bucket.example/signed?sig=abc",
  );
  // A cached redirect would outlive its signature.
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  // Cross-origin callers need ACAO on the redirect itself, not just the 200.
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(requestedTtl, SIGNED_URL_TTL_SECONDS);
}

async function testMissingArtifactIsNullNotBucket404() {
  const store = fakeStore({
    type: "gcs",
    ensureBrowserCors: async () => true,
    exists: async () => false,
  });
  const res = await serveParquetArtifact(store, "apps/missing.parquet", {
    cacheControl: "no-store",
  });
  assert.equal(res, null);
}

async function streamedBody(res: Response | null): Promise<string> {
  assert.ok(res);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("Content-Type"),
    "application/vnd.apache.parquet",
  );
  return await res.text();
}

async function testFilesystemStreams() {
  const store = fakeStore({
    type: "filesystem",
    getSignedUrl: async () => null,
  });
  const res = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: "private, no-store",
  });
  assert.equal(await streamedBody(res), "PAR1-bytes");
  assert.ok(res);
  assert.equal(res.headers.get("Content-Length"), "10");
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.equal(await artifactDeliveryMode(store), "stream");
}

async function testNoCorsCheckerStreams() {
  // S3 today: signs URLs but cannot verify bucket CORS.
  const store = fakeStore({ type: "s3" });
  assert.equal(await artifactDeliveryMode(store), "stream");
  const res = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: "no-store",
  });
  assert.equal(await streamedBody(res), "PAR1-bytes");
}

async function testCorsCheckFailureStreams() {
  for (const ensureBrowserCors of [
    async () => false,
    async () => {
      throw new Error("permission denied: storage.buckets.get");
    },
  ]) {
    const store = fakeStore({ type: "gcs", ensureBrowserCors });
    assert.equal(await artifactDeliveryMode(store), "stream");
  }
}

async function testSigningFailureDegradesToStream() {
  const store = fakeStore({
    type: "gcs",
    ensureBrowserCors: async () => true,
    getSignedUrl: async () => {
      throw new Error("signBlob permission missing");
    },
  });
  const res = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: "no-store",
  });
  assert.equal(await streamedBody(res), "PAR1-bytes");
}

async function testEnvOverrides() {
  const prior = process.env.APPS_ARTIFACT_REDIRECTS;
  try {
    process.env.APPS_ARTIFACT_REDIRECTS = "off";
    const corsOk = fakeStore({
      type: "gcs",
      ensureBrowserCors: async () => true,
    });
    assert.equal(await artifactDeliveryMode(corsOk), "stream");

    process.env.APPS_ARTIFACT_REDIRECTS = "on";
    // "on" trusts the operator: no CORS checker consulted.
    const unchecked = fakeStore({ type: "s3" });
    assert.equal(await artifactDeliveryMode(unchecked), "redirect");
    // ...but a filesystem store has no URLs to sign, whatever the env says.
    const fsStore = fakeStore({ type: "filesystem" });
    assert.equal(await artifactDeliveryMode(fsStore), "stream");
  } finally {
    if (prior === undefined) delete process.env.APPS_ARTIFACT_REDIRECTS;
    else process.env.APPS_ARTIFACT_REDIRECTS = prior;
  }
}

async function testModeIsResolvedOncePerStore() {
  let probes = 0;
  const store = fakeStore({
    type: "gcs",
    ensureBrowserCors: async () => {
      probes += 1;
      return true;
    },
  });
  await serveParquetArtifact(store, "a", { cacheControl: "no-store" });
  await serveParquetArtifact(store, "b", { cacheControl: "no-store" });
  assert.equal(probes, 1);
}

const WRITTEN_AT = new Date("2026-10-22T00:00:00.000Z");
const WRITTEN_LATER = new Date("2026-10-22T00:05:00.000Z");

function cacheableGcsStore(
  overrides: Partial<DashboardArtifactStore> = {},
): DashboardArtifactStore {
  return fakeStore({
    type: "gcs",
    ensureBrowserCors: async () => true,
    getLastModified: async () => WRITTEN_AT,
    getSize: async () => 10,
    ...overrides,
  });
}

async function testCacheableRedirectSetsEtagAndShortMaxAge() {
  let signedOpts: { responseCacheControl?: string } | undefined;
  const store = cacheableGcsStore({
    getSignedUrl: async (_key, _ttl, opts) => {
      signedOpts = opts;
      return "https://bucket.example/signed?sig=abc";
    },
  });
  const res = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
  });
  assert.ok(res);
  assert.equal(res.status, 302);
  const contentTag = await parquetContentETag(store, "apps/k.parquet");
  assert.ok(contentTag);
  assert.equal(res.headers.get("ETag"), parquetRedirectETag(contentTag));
  assert.equal(res.headers.get("Cache-Control"), PARQUET_BROWSER_CACHE_CONTROL);
  assert.equal(res.headers.get("Vary"), PARQUET_BROWSER_CACHE_VARY);
  const maxAge = Number(
    /max-age=(\d+)/.exec(res.headers.get("Cache-Control") ?? "")?.[1],
  );
  assert.equal(maxAge, PARQUET_CACHE_MAX_AGE_SECONDS);
  assert.ok(maxAge < SIGNED_URL_TTL_SECONDS);
  assert.equal(
    signedOpts?.responseCacheControl,
    SIGNED_URL_RESPONSE_CACHE_CONTROL,
  );
  const gcsMaxAge = Number(
    /max-age=(\d+)/.exec(SIGNED_URL_RESPONSE_CACHE_CONTROL)?.[1],
  );
  assert.ok(gcsMaxAge < SIGNED_URL_TTL_SECONDS);
  assert.ok(
    REDIRECT_ETAG_PERIOD_SECONDS + PARQUET_CACHE_MAX_AGE_SECONDS <
      SIGNED_URL_TTL_SECONDS,
  );
}

async function testIfNoneMatchReturns304WithoutSigning() {
  let signed = 0;
  const store = cacheableGcsStore({
    getSignedUrl: async () => {
      signed += 1;
      return "https://bucket.example/signed?sig=abc";
    },
  });
  const first = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
  });
  assert.ok(first);
  const etag = first.headers.get("ETag");
  assert.ok(etag);
  signed = 0;
  const again = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
    ifNoneMatch: etag,
    extraHeaders: { "Access-Control-Allow-Origin": "*" },
  });
  assert.ok(again);
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("ETag"), etag);
  assert.equal(
    again.headers.get("Cache-Control"),
    PARQUET_BROWSER_CACHE_CONTROL,
  );
  assert.equal(again.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(await again.text(), "");
  assert.equal(signed, 0);
}

async function testEtagChangesAfterRebuild() {
  let modified = WRITTEN_AT;
  const store = cacheableGcsStore({
    getLastModified: async () => modified,
  });
  const before = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
  });
  assert.ok(before);
  const oldTag = before.headers.get("ETag");
  assert.ok(oldTag);
  modified = WRITTEN_LATER;
  const after = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
  });
  assert.ok(after);
  const newTag = after.headers.get("ETag");
  assert.ok(newTag);
  assert.notEqual(newTag, oldTag);
  const stale = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
    ifNoneMatch: oldTag,
  });
  assert.ok(stale);
  assert.equal(stale.status, 302);
  assert.equal(stale.headers.get("ETag"), newTag);
}

async function testRefreshBustSkips304() {
  let signed = 0;
  const store = cacheableGcsStore({
    getSignedUrl: async () => {
      signed += 1;
      return "https://bucket.example/signed?sig=abc";
    },
  });
  const first = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
  });
  assert.ok(first);
  const etag = first.headers.get("ETag");
  assert.ok(etag);
  signed = 0;
  const busted = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
    ifNoneMatch: etag,
    cacheBust: true,
  });
  assert.ok(busted);
  assert.equal(busted.status, 302);
  assert.equal(busted.headers.get("ETag"), etag);
  assert.equal(signed, 1);
}

async function testUncacheableRedirectDoesNotSignCacheOverride() {
  let signedOpts: { responseCacheControl?: string } | undefined = {
    responseCacheControl: "sentinel",
  };
  const store = cacheableGcsStore({
    getSignedUrl: async (_key, _ttl, opts) => {
      signedOpts = opts;
      return "https://bucket.example/signed?sig=abc";
    },
  });
  const res = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: "no-store",
  });
  assert.ok(res);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.equal(res.headers.get("ETag"), null);
  assert.equal(signedOpts, undefined);
}

async function testMissingArtifactDoesNotEmitCacheHeaders() {
  let signed = 0;
  const store = cacheableGcsStore({
    exists: async () => false,
    getSignedUrl: async () => {
      signed += 1;
      return "https://bucket.example/signed?sig=abc";
    },
  });
  const res = await serveParquetArtifact(store, "apps/missing.parquet", {
    cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
    ifNoneMatch: '"anything"',
  });
  assert.equal(res, null);
  assert.equal(signed, 0);
}

async function testFilesystemCacheableSetsEtagOn200And304() {
  const store = fakeStore({
    type: "filesystem",
    getSignedUrl: async () => null,
    getLastModified: async () => WRITTEN_AT,
    getSize: async () => 10,
  });
  const first = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
  });
  assert.ok(first);
  assert.equal(first.status, 200);
  const etag = first.headers.get("ETag");
  assert.equal(etag, await parquetContentETag(store, "apps/k.parquet"));
  assert.equal(
    first.headers.get("Cache-Control"),
    PARQUET_BROWSER_CACHE_CONTROL,
  );
  const again = await serveParquetArtifact(store, "apps/k.parquet", {
    cacheControl: PARQUET_BROWSER_CACHE_CONTROL,
    ifNoneMatch: etag,
  });
  assert.ok(again);
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
}

async function testIfNoneMatchListAndStar() {
  assert.equal(ifNoneMatchSatisfied('"a"', '"a"'), true);
  assert.equal(ifNoneMatchSatisfied('W/"a"', '"a"'), true);
  assert.equal(ifNoneMatchSatisfied('"b", "a"', '"a"'), true);
  assert.equal(ifNoneMatchSatisfied("*", '"a"'), true);
  assert.equal(ifNoneMatchSatisfied('"b"', '"a"'), false);
  assert.equal(ifNoneMatchSatisfied(undefined, '"a"'), false);
}

async function testRefreshQueryAlwaysBusts() {
  const req = (refresh: string | undefined) =>
    parquetCacheFromRequest({
      header: () => undefined,
      query: name => (name === "refresh" ? refresh : undefined),
    });
  assert.equal(req(undefined).cacheBust, false);
  assert.equal(req("").cacheBust, true);
  assert.equal(req("1").cacheBust, true);
}

async function testRedirectEtagRotatesBeforeSignatureTtl() {
  const tag = '"abc-def"';
  const atStart = parquetRedirectETag(tag, 0);
  const stillSamePeriod = parquetRedirectETag(
    tag,
    (REDIRECT_ETAG_PERIOD_SECONDS - 1) * 1000,
  );
  const nextPeriod = parquetRedirectETag(
    tag,
    REDIRECT_ETAG_PERIOD_SECONDS * 1000,
  );
  assert.equal(atStart, stillSamePeriod);
  assert.notEqual(atStart, nextPeriod);
}

async function main() {
  await testRedirectsWhenBucketCorsConfirmed();
  await testMissingArtifactIsNullNotBucket404();
  await testFilesystemStreams();
  await testNoCorsCheckerStreams();
  await testCorsCheckFailureStreams();
  await testSigningFailureDegradesToStream();
  await testEnvOverrides();
  await testModeIsResolvedOncePerStore();
  await testCacheableRedirectSetsEtagAndShortMaxAge();
  await testIfNoneMatchReturns304WithoutSigning();
  await testEtagChangesAfterRebuild();
  await testRefreshBustSkips304();
  await testUncacheableRedirectDoesNotSignCacheOverride();
  await testMissingArtifactDoesNotEmitCacheHeaders();
  await testFilesystemCacheableSetsEtagOn200And304();
  await testIfNoneMatchListAndStar();
  await testRefreshQueryAlwaysBusts();
  await testRedirectEtagRotatesBeforeSignatureTtl();
  console.log("artifact-delivery.service tests passed");
}

main().catch((error: unknown) => {
  throw error;
});
