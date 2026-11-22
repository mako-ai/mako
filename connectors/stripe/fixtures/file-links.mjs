import assert from "node:assert/strict";
import { readFolder, requestKey, startReplayServer } from "./harness.mjs";

const older = {
  id: "link_older",
  object: "file_link",
  file: "file_shared",
  created: 100,
  expired: false,
  expires_at: null,
  livemode: false,
  metadata: { group: "fixture" },
};
const newer = { ...older, id: "link_newer", created: 200 };
const first = "/v1/file_links?limit=1";
const next = first + "&starting_after=" + newer.id;

export function fileLinkCassettes(expired = false) {
  const oldRow = {
    ...older,
    expired,
    expires_at: expired ? 300 : null,
    file: { id: older.file, object: "file", url: "/fixture/private-file" },
  };
  const pages = [
    [first, [newer], true],
    [next, [oldRow], false],
    ["/v1/file_links?limit=100", [newer, oldRow], false],
  ];
  return new Map(
    pages.map(([path, rows, has_more]) => [
      requestKey("GET", path),
      {
        stripeVersion: "2023-10-16",
        status: 200,
        body: {
          object: "list",
          has_more,
          data: rows.map(row => ({ ...row, url: "/fixture/shared-download" })),
        },
      },
    ]),
  );
}

export async function verifyFileLinks(server) {
  const key = "sk_test_file_links";
  const read = (instance, since) =>
    readFolder({
      entity: "file_links",
      config: {
        api_key: key,
        api_base_url: instance.url,
        __page_size: 1,
        __rate_limit_delay_ms: 1,
      },
      maxIterations: 1,
      since,
    });
  const expectedRequests = [first, next].map(path => requestKey("GET", path));
  const initial = await read(server);
  assert.deepEqual(initial.rows, [newer, older]);
  assert.deepEqual(server.requestKeys(key), expectedRequests);

  const updated = await startReplayServer(fileLinkCassettes(true));
  try {
    // Both links predate the polling anchor. One was subsequently expired.
    const replay = await read(updated, "2026-11-20T00:00:00Z");
    assert.deepEqual(replay.rows, [
      newer,
      { ...older, expired: true, expires_at: 300 },
    ]);
    assert.deepEqual(updated.requestKeys(key), expectedRequests);
    assert.deepEqual(updated.misses, []);
  } finally {
    await updated.close();
  }
}
