import assert from "node:assert/strict";
import { readFolder, requestKey } from "./harness.mjs";

const since = "2026-11-20T00:00:00.750Z";
const cutoff = Math.floor(Date.parse(since) / 1000);

function metadata(id, created, expires_at) {
  return {
    id,
    object: "file",
    created,
    expires_at,
    filename: "fixture.pdf",
    purpose: "dispute_evidence",
    size: 512,
    title: null,
    type: "pdf",
  };
}

const latest = metadata("file_fixture_latest", cutoff + 20, cutoff + 60);
const newer = metadata("file_fixture_newer", cutoff + 10, null);
const boundary = metadata("file_fixture_at_anchor", cutoff, null);
const older = metadata("file_fixture_older", cutoff - 1, null);

const firstURL = "/v1/files?limit=2";
const afterURL = `/v1/files?limit=2&starting_after=${newer.id}`;
const anchor = `&created[gte]=${cutoff}`;
const defaultURL = "/v1/files?limit=100";

export function fileCassettes() {
  const pages = [
    [firstURL, [latest, newer], true],
    [afterURL, [boundary, older], false],
    [firstURL + anchor, [latest, newer], true],
    [afterURL + anchor, [boundary], false],
    [defaultURL, [latest, newer, boundary, older], false],
  ];
  return new Map(
    pages.map(([url, data, has_more]) => [
      requestKey("GET", url),
      {
        stripeVersion: "2023-10-16",
        status: 200,
        body: {
          object: "list",
          has_more,
          data: data.map(row => ({
            ...row,
            url: "/fixture-file-content",
            links: { data: [{ url: "/fixture-file-link" }] },
          })),
        },
      },
    ]),
  );
}

export async function verifyFiles(server) {
  const read = (key, { pageSize, since } = {}) =>
    readFolder({
      entity: "files",
      config: {
        api_key: key,
        api_base_url: server.url,
        __page_size: pageSize,
        __rate_limit_delay_ms: 1,
      },
      since,
      maxIterations: 1,
    });

  const fullKey = "sk_test_files_full";
  const full = await read(fullKey, { pageSize: 2 });
  assert.deepEqual(full.rows, [latest, newer, boundary, older]);
  assert.deepEqual(full.chunks, [
    { cursor: newer.id, hasMore: true },
    { cursor: newer.id, hasMore: false },
  ]);
  assert.deepEqual(
    server.requestKeys(fullKey),
    [firstURL, afterURL].map(url => requestKey("GET", url)),
  );

  const incrementalKey = "sk_test_files_incremental";
  const incremental = await read(incrementalKey, { pageSize: 2, since });
  assert.deepEqual(incremental.rows, [latest, newer, boundary]);
  assert.deepEqual(
    server.requestKeys(incrementalKey),
    [firstURL + anchor, afterURL + anchor].map(url => requestKey("GET", url)),
  );

  const cappedKey = "sk_test_files_capped";
  const capped = await read(cappedKey, { pageSize: 101 });
  assert.deepEqual(capped.rows, full.rows);
  assert.deepEqual(server.requestKeys(cappedKey), [
    requestKey("GET", defaultURL),
  ]);
  assert.deepEqual(server.misses, []);
  console.info(
    "Stripe Files passed offline pagination, anchor and page bounds.",
  );
}
