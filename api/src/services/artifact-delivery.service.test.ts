/**
 * Artifact delivery — redirect vs stream.
 *
 * The properties worth pinning: a bucket that answers browser CORS gets a
 * 302 whose Location is the signed URL and whose Cache-Control forbids
 * caching the (expiring) signature; every "cannot prove it's safe" path —
 * no CORS checker, checker says no, checker throws, signing throws, env
 * kill switch — degrades to the exact proxied stream we served before,
 * never to an error; and a missing artifact is null (the route's 404), not
 * a redirect to the bucket's XML 404.
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { DashboardArtifactStore } from "./dashboard-artifact-store.service";
import {
  artifactDeliveryMode,
  serveParquetArtifact,
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

async function main() {
  await testRedirectsWhenBucketCorsConfirmed();
  await testMissingArtifactIsNullNotBucket404();
  await testFilesystemStreams();
  await testNoCorsCheckerStreams();
  await testCorsCheckFailureStreams();
  await testSigningFailureDegradesToStream();
  await testEnvOverrides();
  await testModeIsResolvedOncePerStore();
  console.log("artifact-delivery.service tests passed");
}

main().catch((error: unknown) => {
  throw error;
});
