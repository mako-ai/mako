/**
 * buildWebhookCdcRecords and connector enrichment: a
 * WebhookEnrichmentRetryError defers or fails the event and applies
 * nothing. Any other enrichment error still applies the extracted records.
 */
import assert from "node:assert/strict";
import { WebhookEnrichmentRetryError } from "../../connectors/base/BaseConnector";
import { buildWebhookCdcRecords, loadWebhookConnector } from "./webhook-flow";

const extracted = {
  entity: "leads",
  recordId: "lead_1",
  operation: "upsert" as const,
  payload: { id: "lead_1", name: "Partial" },
  sourceTs: new Date("2026-11-17T06:05:50.265Z"),
  source: "webhook" as const,
  changeId: "ev_1",
};

function connectorThatThrows(error: Error) {
  return {
    extractWebhookCdcRecords: () => [extracted],
    enrichWebhookCdcRecords: async () => {
      throw error;
    },
  } as any;
}

async function build(error: Error) {
  return buildWebhookCdcRecords({
    connector: connectorThatThrows(error),
    sourceConnection: { id: "src_1", name: "pl_close" },
    flow: {} as any,
    webhookEvent: {
      eventId: "evt_1",
      eventType: "lead.updated",
      rawPayload: {},
      receivedAt: new Date(),
    },
  });
}

async function testRetryErrorsApplyNothing() {
  for (const mode of ["defer", "fail"] as const) {
    const result = await build(new WebhookEnrichmentRetryError("wait", mode));
    assert.deepEqual(result.records, [], mode);
    assert.equal(result.extractedCount, 1, mode);
    assert.deepEqual(result.retry, { mode, message: "wait" }, mode);
  }
}

async function testOtherErrorsStillApplyExtractedRecords() {
  const result = await build(new Error("transcript download failed"));
  assert.equal(result.retry, undefined);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].recordId, "lead_1");
}

/**
 * The ingest connector gets the decrypted credential. Built from the raw
 * row, Close got ciphertext as its key and answered 401 to every fill read.
 */
async function testWebhookConnectorGetsTheDecryptedConfig() {
  const row = {
    _id: "src_1",
    name: "pl_close",
    type: "close",
    workspaceId: "ws_1",
    config: { api_key: "enc:ciphertext" },
    toObject() {
      const { toObject: _drop, ...plain } = this as any;
      return plain;
    },
  } as any;
  let built: any;
  const connector = await loadWebhookConnector(row, {
    getSourceConnection: async id => {
      assert.equal(id, "src_1");
      return { connection: { api_key: "api_plaintext" } };
    },
    getConnectorFor: connection => {
      built = connection;
      return { ok: true } as any;
    },
  });
  assert.deepEqual(connector, { ok: true });
  assert.equal(built.config.api_key, "api_plaintext");
  assert.equal(built.type, "close");
  assert.equal(built.name, "pl_close");
  assert.equal(built.workspaceId, "ws_1");
  // The stored row is left as it was.
  assert.equal(row.config.api_key, "enc:ciphertext");

  const gone = await loadWebhookConnector(row, {
    getSourceConnection: async () => null,
    getConnectorFor: () => {
      throw new Error("must not build a connector without its credential");
    },
  });
  assert.equal(gone, null);
}

async function main() {
  await testRetryErrorsApplyNothing();
  await testOtherErrorsStillApplyExtractedRecords();
  await testWebhookConnectorGetsTheDecryptedConfig();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
