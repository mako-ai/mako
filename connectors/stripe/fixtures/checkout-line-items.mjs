import assert from "node:assert/strict";
import { readFolder, requestKey, startReplayServer } from "./harness.mjs";

const ENTITY = "checkout_sessions_line_items";
const SINCE = "2026-11-12T00:00:00.000Z";
const CREATED = Date.parse(SINCE) / 1000;
const first = {
  id: "cs_test_checkout_first",
  created: CREATED + 10,
  expires_at: CREATED + 86410,
};
const second = {
  id: "cs_test_checkout_second",
  created: CREATED,
  expires_at: CREATED + 86400,
};
const items = Array.from({ length: 101 }, (_, index) => ({
  id: `li_checkout_${index + 1}`,
  object: "item",
  amount_subtotal: 1000,
  amount_discount: 0,
  amount_tax: 200,
  amount_total: 1200,
  currency: "eur",
  description: "Fixture checkout",
  discounts: [],
  taxes: [{ amount: 200, rate: { id: "txr_fixture" } }],
  price: { id: "price_checkout_fixture" },
  quantity: 1,
}));
const secondItem = { ...items[0], id: "li_checkout_second" };
const childPath = session => `/v1/checkout/sessions/${session.id}/line_items`;
const childParams = "expand[0]=data.discounts&expand[1]=data.taxes&limit=100";
const childResume = `${childPath(first)}?${childParams}&starting_after=${items[99].id}`;

function response(url, data, hasMore) {
  return {
    status: 200,
    stripeVersion: "2023-10-16",
    body: { object: "list", data, has_more: hasMore, url: url.split("?")[0] },
  };
}

export function checkoutLineItemsCassettes() {
  const cassettes = new Map();
  const add = (url, data, hasMore) =>
    cassettes.set(requestKey("GET", url), response(url, data, hasMore));
  for (const query of ["limit=25", `created[gte]=${CREATED}&limit=3`]) {
    add(`/v1/checkout/sessions?${query}`, [first], true);
    add(
      `/v1/checkout/sessions?${query}&starting_after=${first.id}`,
      [second],
      false,
    );
  }
  add(`${childPath(first)}?${childParams}`, items.slice(0, 100), true);
  add(childResume, items.slice(100), false);
  add(`${childPath(second)}?${childParams}`, [secondItem], false);
  return cassettes;
}

/** Exercise the real SDK/Stripe requests and resume from its emitted state. */
export async function verifyCheckoutLineItems(server) {
  const apiKey = "sk_test_checkout_line_items";
  const read = url =>
    readFolder({
      entity: ENTITY,
      config: { api_key: apiKey, api_base_url: url, __page_size: 3 },
      since: SINCE,
      maxIterations: 1,
    });
  const { rows, chunks } = await read(server.url);
  assert.deepEqual(
    rows.map(row => row.id),
    [...items, secondItem].map(row => row.id),
  );
  assert.deepEqual(chunks, [
    { cursor: first.id, hasMore: true },
    { cursor: first.id, hasMore: false },
  ]);
  for (const [index, row] of rows.entries()) {
    const parent = index < items.length ? first : second;
    assert.equal(row.checkout_session_id, parent.id);
    assert.equal(row.checkout_session_created, parent.created);
    assert.equal(row.checkout_session_expires_at, parent.expires_at);
    assert.equal(row.checkout_session_updated, undefined);
  }
  assert.deepEqual(rows[0].taxes, items[0].taxes);
  assert.deepEqual(server.requestKeys(apiKey), [
    requestKey("GET", `/v1/checkout/sessions?created[gte]=${CREATED}&limit=3`),
    requestKey("GET", `${childPath(first)}?${childParams}`),
    requestKey("GET", childResume),
    requestKey(
      "GET",
      `/v1/checkout/sessions?created[gte]=${CREATED}&limit=3&starting_after=${first.id}`,
    ),
    requestKey("GET", `${childPath(second)}?${childParams}`),
  ]);

  const invalid = checkoutLineItemsCassettes();
  invalid.set(
    requestKey("GET", childResume),
    response(childResume, [items[99]], true),
  );
  const replay = await startReplayServer(invalid);
  try {
    await assert.rejects(() => read(replay.url), /missing or repeated id/);
  } finally {
    await replay.close();
  }

  const empty = checkoutLineItemsCassettes();
  const firstPage = `${childPath(first)}?${childParams}`;
  empty.set(requestKey("GET", firstPage), response(firstPage, [], false));
  const emptyReplay = await startReplayServer(empty);
  try {
    const result = await read(emptyReplay.url);
    assert.deepEqual(
      result.rows.map(row => row.id),
      [secondItem.id],
    );
    assert.deepEqual(
      result.chunks.map(chunk => chunk.hasMore),
      [true, false],
    );
  } finally {
    await emptyReplay.close();
  }
}
