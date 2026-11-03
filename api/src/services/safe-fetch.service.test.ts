import assert from "node:assert/strict";
import {
  assertPublicIp,
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

async function main() {
  testAssertPublicIpRejectsLoopback();
  testAssertPublicIpRejectsPrivateRanges();
  testAssertPublicIpRejectsMetadataIp();
  testAssertPublicIpAcceptsPublicAddresses();
  testAssertPublicIpJudgesMappedIpv6AsIpv4();
  testAssertPublicIpRejectsNonUnicastRanges();
  testStripBlockedRequestHeaders();

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
