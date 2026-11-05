import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  assertPublicIp,
  readBodyWithLimit,
  SafeFetchError,
  safeFetch,
  stripBlockedRequestHeaders,
} from "./safe-fetch.service";

function testAssertPublicIpRejectsLoopback() {
  assert.throws(() => assertPublicIp("127.0.0.1"), SafeFetchError);
  assert.throws(() => assertPublicIp("::1"), SafeFetchError);
}

function testAssertPublicIpRejectsPrivateRanges() {
  assert.throws(() => assertPublicIp("10.0.0.1"), SafeFetchError);
  assert.throws(() => assertPublicIp("172.16.0.1"), SafeFetchError);
  assert.throws(() => assertPublicIp("192.168.1.1"), SafeFetchError);
  assert.throws(() => assertPublicIp("100.64.0.1"), SafeFetchError);
  assert.throws(() => assertPublicIp("fc00::1"), SafeFetchError);
}

function testAssertPublicIpRejectsMetadataIp() {
  assert.throws(() => assertPublicIp("169.254.169.254"), SafeFetchError);
}

function testAssertPublicIpAcceptsPublicAddresses() {
  assert.doesNotThrow(() => assertPublicIp("8.8.8.8"));
  assert.doesNotThrow(() => assertPublicIp("1.1.1.1"));
  assert.doesNotThrow(() => assertPublicIp("2001:4860:4860::8888"));
}

function testAssertPublicIpJudgesMappedIpv6AsIpv4() {
  assert.throws(() => assertPublicIp("::ffff:169.254.169.254"), SafeFetchError);
  assert.throws(() => assertPublicIp("::ffff:127.0.0.1"), SafeFetchError);
  assert.throws(() => assertPublicIp("::ffff:10.0.0.5"), SafeFetchError);
  assert.throws(() => assertPublicIp("::ffff:a9fe:a9fe"), SafeFetchError);
  assert.throws(() => assertPublicIp("[::ffff:a9fe:a9fe]"), SafeFetchError);
  assert.doesNotThrow(() => assertPublicIp("::ffff:8.8.8.8"));
}

function testAssertPublicIpRejectsNonUnicastRanges() {
  assert.throws(() => assertPublicIp("0.0.0.0"), SafeFetchError);
  assert.throws(() => assertPublicIp("::"), SafeFetchError);
  assert.throws(() => assertPublicIp("224.0.0.1"), SafeFetchError);
  assert.throws(() => assertPublicIp("fe80::1"), SafeFetchError);
}

function testStripBlockedRequestHeaders() {
  assert.deepEqual(
    stripBlockedRequestHeaders({
      Accept: "text/html",
      "Metadata-Flavor": "Google",
      "metadata-flavor": "Google",
      "X-Google-Metadata-Request": "True",
      "x-google-anything": "1",
      authorization: "Bearer t",
    }),
    { Accept: "text/html", authorization: "Bearer t" },
  );
}

/** A stream that yields `chunks` chunks of `size` bytes, recording cancel. */
function chunkedBody(chunks: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(97));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

async function testStreamPastLimitWithoutContentLengthIsRefused() {
  const { stream, state } = chunkedBody(1000, 1024);
  const response = new Response(stream);
  assert.equal(response.headers.get("content-length"), null);
  await assert.rejects(
    () => readBodyWithLimit(response, 10_000),
    (error: unknown) =>
      error instanceof SafeFetchError && /byte limit/.test(error.message),
  );
  assert.equal(state.cancelled, true);
  assert.ok(state.pulled < 1000, "stream was read to the end");
}

async function testStreamUnderLimitReturnsBytes() {
  const { stream } = chunkedBody(3, 100);
  const body = await readBodyWithLimit(new Response(stream), 10_000);
  assert.equal(body.byteLength, 300);
  assert.equal(body.toString("utf8"), "a".repeat(300));
}

async function testContentLengthOverLimitIsRefused() {
  const response = new Response("x".repeat(50), {
    headers: { "content-length": "50" },
  });
  await assert.rejects(() => readBodyWithLimit(response, 10), SafeFetchError);
}

async function testEmptyBodyReturnsEmptyBuffer() {
  const body = await readBodyWithLimit(new Response(null), 10);
  assert.equal(body.byteLength, 0);
}

/**
 * A small gzip payload that decodes past the limit: the compressed size (and
 * content-length) is under it, the decoded size is not.
 */
async function testGzipBodyDecodingPastLimitIsRefused() {
  const maxBytes = 1_000_000;
  const compressed = gzipSync(Buffer.alloc(20_000_000, 0));
  assert.ok(compressed.byteLength < maxBytes);
  const decoded = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const response = new Response(decoded, {
    headers: { "content-length": String(compressed.byteLength) },
  });
  await assert.rejects(
    () => readBodyWithLimit(response, maxBytes),
    SafeFetchError,
  );
}

async function main() {
  testAssertPublicIpRejectsLoopback();
  testAssertPublicIpRejectsPrivateRanges();
  testAssertPublicIpRejectsMetadataIp();
  testAssertPublicIpAcceptsPublicAddresses();
  testAssertPublicIpJudgesMappedIpv6AsIpv4();
  testAssertPublicIpRejectsNonUnicastRanges();
  testStripBlockedRequestHeaders();

  await testStreamPastLimitWithoutContentLengthIsRefused();
  await testStreamUnderLimitReturnsBytes();
  await testContentLengthOverLimitIsRefused();
  await testEmptyBodyReturnsEmptyBuffer();
  await testGzipBodyDecodingPastLimitIsRefused();

  await assert.rejects(
    () => safeFetch("http://[::ffff:169.254.169.254]/latest/meta-data/"),
    SafeFetchError,
  );
  await assert.rejects(
    () => safeFetch("http://[::ffff:a9fe:a9fe]/"),
    SafeFetchError,
  );
  await assert.rejects(
    () => safeFetch("http://[::ffff:127.0.0.1]:8080/"),
    SafeFetchError,
  );

  await assert.rejects(() => safeFetch("file:///etc/passwd"), SafeFetchError);
  await assert.rejects(
    () => safeFetch("ftp://example.com/file"),
    SafeFetchError,
  );
  await assert.rejects(() => safeFetch("http://127.0.0.1/"), SafeFetchError);
  await assert.rejects(
    () => safeFetch("http://169.254.169.254/latest/meta-data/"),
    SafeFetchError,
  );
}

main().catch((error: unknown) => {
  throw error;
});
