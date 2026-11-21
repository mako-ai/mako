import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  ensureFolderInstalled,
  readFolder,
  requestKey,
  startReplayServer,
} from "./harness.mjs";

const since = "2026-11-20T00:00:00Z";
const cutoff = Date.parse(since) / 1000;
const intent = (id, created) => ({ id, object: "setup_intent", created });
const attempt = (id, created, status) => ({
  id,
  object: "setup_attempt",
  setup_intent: "seti_old",
  created,
  status,
});

export async function checkSetupAttempts(read = readFolder) {
  ensureFolderInstalled();
  const responses = new Map();
  const page = (url, data, has_more = false) => {
    const key = requestKey("GET", url);
    responses.set(key, {
      stripeVersion: "2023-10-16",
      status: 200,
      body: { object: "list", data, has_more },
    });
    return key;
  };
  const parents = page(
    "/v1/setup_intents?limit=2",
    [intent("seti_recent", cutoff + 6), intent("seti_old", cutoff - 100)],
    true,
  );
  const parentsAfterOld = page(
    "/v1/setup_intents?limit=2&starting_after=seti_old",
    [intent("seti_older", cutoff - 200)],
  );
  const attempts = (parent, incremental, after = "") =>
    `/v1/setup_attempts?setup_intent=${parent}&limit=2${incremental ? `&created[gte]=${cutoff}` : ""}${after ? `&starting_after=${after}` : ""}`;
  const newest = attempt("setatt_retry_success", cutoff + 4, "succeeded");
  const retry = attempt("setatt_retry_failed", cutoff + 2, "failed");
  const boundary = attempt("setatt_at_anchor", cutoff, "failed");
  const historical = attempt("setatt_historical", cutoff - 80, "failed");
  const expected = new Map();
  for (const incremental of [true, false]) {
    expected.set(incremental, [
      parents,
      page(attempts("seti_recent", incremental), []),
      page(attempts("seti_old", incremental), [newest, retry], true),
      page(
        attempts("seti_old", incremental, retry.id),
        incremental ? [boundary] : [boundary, historical],
      ),
      parentsAfterOld,
      page(attempts("seti_older", incremental), []),
    ]);
  }

  const server = await startReplayServer(responses);
  try {
    for (const incremental of [true, false]) {
      for (const maxIterations of [1, 10]) {
        const key = `sk_test_setup_attempts_${incremental}_${maxIterations}`;
        const { rows, chunks } = await read({
          entity: "setup_attempts",
          config: {
            api_key: key,
            api_base_url: server.url,
            __page_size: 2,
            __rate_limit_delay_ms: 1,
          },
          since: incremental ? since : undefined,
          maxIterations,
        });
        assert.deepEqual(
          rows,
          incremental
            ? [newest, retry, boundary]
            : [newest, retry, boundary, historical],
        );
        assert.deepEqual(server.requestKeys(key), expected.get(incremental));
        assert.deepEqual(
          chunks.map(chunk => chunk.hasMore),
          maxIterations === 1 ? [true, true, true, true, true, false] : [false],
        );
      }
    }
    assert.deepEqual(server.misses, []);
  } finally {
    await server.close();
  }
  console.info(
    "Stripe Setup Attempts passed 4 offline paging cases (6 requests per sweep).",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await checkSetupAttempts();
}
