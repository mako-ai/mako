/**
 * Synthetic Claap webhook deliveries, built from the synthetic dataset, in
 * the shape Claap posts: `{ eventId, event: { type, recording } }`. A
 * recording is its detail without `crmInfo` and `deal`, plus `analytics`
 * and `transcriptOnly`, as real deliveries carry them. The secret is a
 * fixed test value.
 */
import { buildDataset } from "./dataset.mjs";

export const TEST_SECRET = "claap-fixture-webhook-secret-0001";
export const RECEIVED_AT = "2026-11-16T11:00:00.000Z";

function webhookRecording(detail, drop = []) {
  const recording = {
    ...detail,
    analytics: { views: 3 },
    transcriptOnly: false,
  };
  for (const field of drop) delete recording[field];
  return recording;
}

/** One delivery per case; `body` is what Claap posts, `event` what Mako stores. */
export function buildWebhookDeliveries() {
  const { recordings } = buildDataset();
  const byId = id => recordings.find(r => r.id === id);
  const cases = [
    ["recording_added", "rec_0001", []],
    ["recording_updated", "rec_0004", []],
    ["recording_added", "rec_0002", ["source"], "partial: no source"],
    ["recording_updated", "rec_gone", ["source"], "gone since"],
    [
      "recording_updated",
      "rec_noai",
      ["source", "aiFields"],
      "Ready without aiFields",
    ],
    ["recording_added", "rec_0008", [], "a transcript that fails"],
    ["recording_added", "rec_0003", [], "no signed link"],
    ["recording_added", "rec_0005", [], "a refused signed link"],
  ];
  const deliveries = cases.map(([type, id, drop, name], i) => ({
    name: name ?? type,
    body: {
      eventId: `evt_fixture_${i + 1}`,
      event: { type, recording: webhookRecording(byId(id), drop) },
    },
  }));
  deliveries.push(
    {
      name: "unknown event",
      body: {
        eventId: "evt_fixture_unknown",
        event: { type: "recording_deleted", recording: { id: "rec_0001" } },
      },
    },
    {
      name: "no recording",
      body: {
        eventId: "evt_fixture_empty",
        event: { type: "recording_added" },
      },
    },
  );
  return deliveries.map(({ name, body }) => ({
    name,
    raw: JSON.stringify(body),
    body,
    event: {
      eventId: body.eventId,
      eventType: body.event.type,
      rawPayload: body,
      receivedAt: RECEIVED_AT,
    },
  }));
}

/** Reads the webhook handler makes beyond what the backfill recorded. */
export function webhookReadRequests() {
  return [
    "/v1/recordings/rec_0002?returnAiFields=true",
    "/v1/recordings/rec_gone?returnAiFields=true",
    "/v1/recordings/rec_noai?returnAiFields=true",
  ];
}
