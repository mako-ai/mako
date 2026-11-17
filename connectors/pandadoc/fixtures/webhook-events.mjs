/**
 * Synthetic PandaDoc webhook deliveries, built from the synthetic dataset,
 * in the shape PandaDoc posts: an array of `{ event, data }` items. A
 * document's `data` is its details without the 5 columns real deliveries
 * leave out (`date_completed`, `date_sent`, `total`, `approvers`,
 * `date_status_changed`), plus 2 keys only webhooks carry. The shared key is
 * a fixed test value.
 */
import crypto from "node:crypto";
import { buildDataset } from "./dataset.mjs";

export const TEST_SHARED_KEY = "pandadoc-fixture-shared-key-0001";

/** What a real document delivery leaves out, measured on 256 deliveries. */
export const WEBHOOK_OMITS = [
  "date_completed",
  "date_sent",
  "total",
  "approvers",
  "date_status_changed",
];

export const RECEIVED_AT = "2026-11-16T11:00:00.000Z";

function documentData(doc) {
  const data = { ...doc, qes_status: null, default_date_format: "DD/MM/YYYY" };
  for (const field of WEBHOOK_OMITS) delete data[field];
  return data;
}

/**
 * One delivery per event type, plus the edge cases. Each entry holds the
 * raw body and `events`: the stored event as the box lane keeps it.
 */
export function buildWebhookDeliveries() {
  const dataset = buildDataset();
  const doc = n => dataset.documents[n];
  const tpl = n => dataset.templates[n];
  const deliveries = [];
  const add = (name, items) => deliveries.push({ name, items });

  const docTriggers = [
    "document_state_changed",
    "document_updated",
    "document_creation_failed",
    "document_completed_pdf_ready",
    "document_section_added",
    "recipient_completed",
    "quote_updated",
  ];
  // Index 6 is `doc_nodetail_404` and 12 `doc_nodetail_400`: skipped here.
  docTriggers.forEach((event, i) =>
    add(event, [{ event, data: documentData(doc(i < 6 ? i : 14)) }]),
  );
  add("document_deleted", [
    { event: "document_deleted", data: documentData(doc(8)) },
  ]);
  add("template_created", [{ event: "template_created", data: { ...tpl(0) } }]);
  add("template_updated (partial)", [
    {
      event: "template_updated",
      data: {
        id: tpl(1).id,
        name: tpl(1).name,
        date_modified: tpl(1).date_modified,
      },
    },
  ]);
  add("template_deleted", [
    { event: "template_deleted", data: { id: tpl(2).id } },
  ]);
  // A whole document: every schema column present, so nothing is read.
  add("document_updated (whole)", [
    {
      event: "document_updated",
      data: {
        ...doc(9),
        total: "1090",
        approvers: [],
        date_status_changed: doc(9).date_modified,
      },
    },
  ]);
  // Two items in one delivery: a document and a template.
  add("two items", [
    { event: "document_state_changed", data: documentData(doc(10)) },
    { event: "template_updated", data: { ...tpl(3) } },
  ]);
  // The document is gone since: its details answer 404.
  add("document gone", [
    {
      event: "document_state_changed",
      data: documentData({ ...doc(11), id: "doc_gone_0001" }),
    },
  ]);
  // Its details answer 400: the event fails for a retry.
  add("details refused", [
    { event: "document_state_changed", data: documentData(doc(12)) },
  ]);
  add("unknown event", [{ event: "document_viewed", data: { id: doc(0).id } }]);
  add("item without id", [
    { event: "document_state_changed", data: { name: "no id" } },
  ]);
  return deliveries.map(({ name, items }) => {
    const body = JSON.stringify(items);
    const eventId = crypto
      .createHash("sha1")
      .update(body, "utf8")
      .digest("hex");
    return {
      name,
      body,
      items,
      event: {
        eventId,
        eventType: items.find(i => i.event)?.event ?? "unknown",
        rawPayload: items,
        receivedAt: RECEIVED_AT,
      },
    };
  });
}

/** The ids whose details a webhook fill reads, for recording. */
export function webhookFillRequests() {
  const dataset = buildDataset();
  return [
    `/public/v1/templates/${dataset.templates[1].id}/details`,
    "/public/v1/documents/doc_gone_0001/details",
  ];
}

/** `?signature=` / `signature:` HMAC-SHA256 hex of the body under the key. */
export const sign = (body, key = TEST_SHARED_KEY) =>
  crypto.createHmac("sha256", key).update(body, "utf8").digest("hex");
