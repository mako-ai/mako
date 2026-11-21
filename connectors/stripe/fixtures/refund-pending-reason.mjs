import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  handleStripeWebhookBatch,
  STRIPE_WEBHOOK_FILL_FIELDS,
} from "../webhook-handler.ts";
import {
  ensureFolderInstalled,
  readFolder,
  requestKey,
  startReplayServer,
} from "./harness.mjs";

function fullRefund(id, fields = {}) {
  const refund = Object.fromEntries(
    STRIPE_WEBHOOK_FILL_FIELDS.refunds.map(field => [field, null]),
  );
  delete refund.pending_reason;
  return { ...refund, id, object: "refund", created: 1794826800, ...fields };
}

export async function checkRefundPendingReason() {
  ensureFolderInstalled();
  const rows = [
    fullRefund("re_cleared", { status: "succeeded" }),
    fullRefund("re_pending", {
      status: "pending",
      pending_reason: "processing",
    }),
    fullRefund("re_null", { status: "succeeded", pending_reason: null }),
  ];
  const key = requestKey("GET", "/v1/refunds?limit=3");
  const server = await startReplayServer(
    new Map([
      [
        key,
        {
          stripeVersion: "2023-10-16",
          status: 200,
          body: { object: "list", data: rows, has_more: false },
        },
      ],
    ]),
  );
  const apiKey = "sk_test_refund_pending_reason";
  try {
    const result = await readFolder({
      entity: "refunds",
      config: { api_key: apiKey, api_base_url: server.url, __page_size: 3 },
      maxIterations: 1,
    });
    assert.deepEqual(result.rows, [
      { ...rows[0], pending_reason: null },
      rows[1],
      rows[2],
    ]);
    assert.deepEqual(server.requestKeys(apiKey), [key]);
    assert.deepEqual(server.misses, []);
  } finally {
    await server.close();
  }

  const event = (id, data) => ({
    eventId: `evt_${id}`,
    eventType: "refund.updated",
    rawPayload: data,
  });
  const requests = [];
  const current = new Map([
    ["re_stale_event", fullRefund("re_stale_event", { status: "succeeded" })],
    [
      "re_thin",
      fullRefund("re_thin", {
        status: "pending",
        pending_reason: "processing",
      }),
    ],
    ["re_wrong", fullRefund("re_another", { status: "succeeded" })],
  ]);
  const outcomes = await handleStripeWebhookBatch(
    {
      stripe: () => ({
        refunds: {
          async retrieve(id) {
            requests.push(id);
            if (current.has(id)) return current.get(id);
            throw Object.assign(new Error("fixture rate limit"), {
              statusCode: 429,
            });
          },
        },
      }),
      log: () => {},
    },
    [
      ...rows.map(row => event(row.id, { data: { object: row } })),
      event("re_stale_event", {
        data: {
          object: { id: "re_stale_event", pending_reason: "processing" },
        },
      }),
      event("re_thin", { related_object: { id: "re_thin" } }),
      event("re_unavailable", {
        data: { object: { id: "re_unavailable", status: "succeeded" } },
      }),
      event("re_wrong", { related_object: { id: "re_wrong" } }),
    ],
  );
  assert.deepEqual(requests, [
    "re_stale_event",
    "re_thin",
    "re_unavailable",
    "re_wrong",
  ]);
  assert.deepEqual(
    outcomes.map(({ outcome }) => outcome),
    [
      "records",
      "records",
      "records",
      "records",
      "records",
      "deferred",
      "extract_failed",
    ],
  );
  assert.deepEqual(
    outcomes
      .slice(0, 5)
      .map(({ records }) => [
        Object.hasOwn(records[0].payload, "pending_reason"),
        records[0].payload.pending_reason,
      ]),
    [
      [true, null],
      [true, "processing"],
      [true, null],
      [true, null],
      [true, "processing"],
    ],
  );
  assert.equal(outcomes[3].records[0].payload.status, "succeeded");
  console.info(
    "Stripe refund pending reasons passed the offline list and webhook checks.",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await checkRefundPendingReason();
}
