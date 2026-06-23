import assert from "node:assert/strict";
import {
  assertPublicIp,
  SafeFetchError,
  safeFetch,
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

async function main() {
  testAssertPublicIpRejectsLoopback();
  testAssertPublicIpRejectsPrivateRanges();
  testAssertPublicIpRejectsMetadataIp();
  testAssertPublicIpAcceptsPublicAddresses();

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
