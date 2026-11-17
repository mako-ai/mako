/**
 * Synthetic Wise webhook deliveries: one per event type the connector maps,
 * every schema version the in-process tests cover, and the edge cases. Ids
 * come from the synthetic dataset, so a fill reads a real fixture object. No
 * real payload is used.
 *
 * Wise signs with its own RSA key, which no test holds. Signed deliveries
 * here are signed with `TEST_WEBHOOK_KEYS`, a pair generated per run; a
 * check under test is given its public key instead of Wise's.
 */
import crypto from "node:crypto";
import { BUSINESS, PERSONAL } from "./dataset.mjs";

export const TEST_WEBHOOK_KEYS = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const SUBSCRIPTION = "00000000-0000-4000-a000-000000000001";

/**
 * A verified delivery as Mako stores it: the body, plus the `type` and `id`
 * the declaration reads (`event_type`, `X-Delivery-Id`). The in-process
 * check stores the same keys.
 */
export function storedEvent(body, deliveryId) {
  const type = body.event_type;
  return {
    eventId: deliveryId ?? `generated-${type}`,
    eventType: type ?? "unknown",
    rawPayload: {
      ...body,
      ...(type ? { type } : {}),
      ...(deliveryId ? { id: deliveryId } : {}),
    },
    receivedAt: "2026-11-16T11:00:00.000Z",
  };
}

const envelope = (eventType, schemaVersion, data, sentAt) => ({
  data,
  subscription_id: SUBSCRIPTION,
  event_type: eventType,
  schema_version: schemaVersion,
  sent_at: sentAt,
});

export function buildWebhookEvents() {
  const events = [];
  let n = 0;
  const push = (body, deliveryId = `d-${String(++n).padStart(4, "0")}`) =>
    events.push(storedEvent(body, deliveryId));

  // transfers#state-change 2.0.0: a personal transfer and a business one.
  push(
    envelope(
      "transfers#state-change",
      "2.0.0",
      {
        resource: {
          type: "transfer",
          id: 51_000_000,
          profile_id: PERSONAL,
          account_id: 70_000_000,
        },
        current_state: "outgoing_payment_sent",
        previous_state: "processing",
        occurred_at: "2026-11-16T10:00:00Z",
      },
      "2026-11-16T10:00:01Z",
    ),
  );
  push(
    envelope(
      "transfers#state-change",
      "2.0.0",
      {
        resource: {
          type: "transfer",
          id: 52_000_001,
          profile_id: BUSINESS,
          account_id: 70_001_001,
        },
        current_state: "funds_converted",
        previous_state: "processing",
        occurred_at: "2026-11-15T09:00:00Z",
      },
      "2026-11-15T09:00:01Z",
    ),
  );
  // transfers#refund: the amounts on the resource.
  push(
    envelope(
      "transfers#refund",
      "2.0.0",
      {
        resource: {
          type: "transfer",
          id: 51_000_003,
          profile_id: PERSONAL,
          account_id: 70_000_003,
          refund_amount: 103,
          refund_currency: "EUR",
        },
        occurred_at: "2026-11-14T08:00:00Z",
      },
      "2026-11-14T08:00:01Z",
    ),
  );
  // transfers#payout-failure 5.0.0: no resource, `transfer_id` instead.
  push(
    envelope(
      "transfers#payout-failure",
      "5.0.0",
      {
        transfer_id: 51_000_004,
        profile_id: PERSONAL,
        failure_reason_code: "WRONG_ID_NUMBER",
        failure_description: "Wrong id number",
        occurred_at: "2026-11-13T07:00:00Z",
      },
      "2026-11-13T07:00:01Z",
    ),
  );
  // transfers#active-cases: issues listed.
  push(
    envelope(
      "transfers#active-cases",
      "2.0.0",
      {
        resource: {
          type: "transfer",
          id: 51_000_005,
          profile_id: PERSONAL,
          account_id: 70_000_005,
        },
        active_cases: ["deposit_amount_less_invoice"],
        occurred_at: "2026-11-12T06:00:00Z",
      },
      "2026-11-12T06:00:01Z",
    ),
  );
  // A transfer the fill finds gone (404).
  push(
    envelope(
      "transfers#state-change",
      "2.0.0",
      {
        resource: {
          type: "transfer",
          id: 59_999_999,
          profile_id: PERSONAL,
          account_id: 1,
        },
        current_state: "cancelled",
        previous_state: "processing",
        occurred_at: "2026-11-11T06:00:00Z",
      },
      "2026-11-11T06:00:01Z",
    ),
  );
  // balances#update 4.0.0: the ledger line, webhook-only.
  push(
    envelope(
      "balances#update",
      "4.0.0",
      {
        resource: { type: "balance-account", id: 301, profile_id: PERSONAL },
        amount: 70,
        balance_id: 301,
        channel_name: "TRANSFER",
        currency: "EUR",
        occurred_at: "2026-11-10T14:55:38.123Z",
        post_transaction_balance_amount: 88.93,
        step_id: 1234567,
        transaction_type: "credit",
        transfer_reference: "BNK-1234567",
      },
      "2026-11-10T14:55:39.456Z",
    ),
  );
  // balances#credit 2.0.0: no balance_id or step_id; the id adds currency.
  push(
    envelope(
      "balances#credit",
      "2.0.0",
      {
        resource: { type: "balance-account", id: 401, profile_id: BUSINESS },
        transaction_type: "credit",
        amount: 1.23,
        currency: "EUR",
        post_transaction_balance_amount: 2.34,
        occurred_at: "2026-10-17T09:00:00Z",
      },
      "2026-10-17T09:00:01Z",
    ),
  );
  // balances#account-state-change: the balance, filled from the REST object.
  push(
    envelope(
      "balances#account-state-change",
      "2.0.0",
      {
        resource: { type: "balance-account", id: 302, profile_id: PERSONAL },
        current_state: "ACTIVE",
        previous_state: "PENDING",
        occurred_at: "2026-11-09T09:00:00Z",
      },
      "2026-11-09T09:00:01Z",
    ),
  );
  // profiles#state-change.
  push(
    envelope(
      "profiles#state-change",
      "2.0.0",
      {
        resource: { type: "profile", id: BUSINESS },
        current_state: "VISIBLE",
        previous_state: "HIDDEN",
        occurred_at: "2026-11-08T09:00:00Z",
      },
      "2026-11-08T09:00:01Z",
    ),
  );
  // recipients#state-change 4.0.0: the recipient nested in resource.data.
  push(
    envelope(
      "recipients#state-change",
      "4.0.0",
      {
        resource: {
          id: "00000000-0000-4000-b000-000000000007",
          occurred_at: "2026-11-07T09:00:00Z",
          data: {
            recipientId: 70_000_007,
            profileId: PERSONAL,
            currency: "GBP",
            state: "ACTIVE",
          },
        },
      },
      "2026-11-07T09:00:01Z",
    ),
  );
  // recipients#state-change, older shape: the recipient is the resource.
  push(
    envelope(
      "recipients#state-change",
      "2.0.0",
      {
        resource: { type: "recipient", id: 70_001_002, profile_id: BUSINESS },
        current_state: "INACTIVE",
        previous_state: "ACTIVE",
        occurred_at: "2026-11-06T09:00:00Z",
      },
      "2026-11-06T09:00:01Z",
    ),
  );
  // No X-Delivery-Id: the change id falls back to type, id and time.
  events.push(
    storedEvent(
      envelope(
        "transfers#state-change",
        "2.0.0",
        {
          resource: {
            type: "transfer",
            id: 51_000_006,
            profile_id: PERSONAL,
            account_id: 70_000_006,
          },
          current_state: "processing",
          previous_state: "incoming_payment_waiting",
          occurred_at: "2026-11-05T09:00:00Z",
        },
        "2026-11-05T09:00:01Z",
      ),
    ),
  );
  // A test notification, as Mako stores it: its type and id only.
  events.push({
    eventId: "test:d-test",
    eventType: "wise#test-notification",
    rawPayload: { type: "wise#test-notification", id: "test:d-test" },
    receivedAt: "2026-11-16T11:00:00.000Z",
  });
  // An event type the connector does not map.
  push(
    envelope(
      "cards#transaction-state-change",
      "1.0.0",
      { resource: { id: 1 } },
      "2026-11-04T09:00:01Z",
    ),
  );
  // A mapped type whose payload names no object: nothing to extract.
  push(envelope("transfers#state-change", "2.0.0", {}, "2026-11-03T09:00:01Z"));
  push(envelope("balances#update", "4.0.0", {}, "2026-11-03T09:00:02Z"));
  return events;
}

/** Signature cases: valid, tampered, wrong key, missing pieces, test pings. */
export function buildDeliveries(body = buildWebhookEvents()[0].rawPayload) {
  const { type: _type, id: _id, ...plain } = body;
  const payload = JSON.stringify(plain);
  const sign = (key, text) =>
    crypto.createSign("RSA-SHA256").update(text).sign(key, "base64");
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const good = sign(TEST_WEBHOOK_KEYS.privateKey, payload);
  const id = { "x-delivery-id": "d-sig-0001" };
  return [
    {
      name: "valid",
      payload,
      headers: { "x-signature-sha256": good, ...id },
    },
    {
      name: "valid, no delivery id",
      payload,
      headers: { "x-signature-sha256": good },
    },
    {
      name: "tampered body",
      payload: payload.replace(
        "outgoing_payment_sent",
        "outgoing_payment_lost",
      ),
      headers: { "x-signature-sha256": good, ...id },
    },
    {
      name: "wrong key",
      payload,
      headers: {
        "x-signature-sha256": sign(other.privateKey, payload),
        ...id,
      },
    },
    {
      name: "no signature header",
      payload,
      headers: { ...id },
    },
    {
      name: "signature not base64",
      payload,
      headers: { "x-signature-sha256": "%%%not-base64%%%", ...id },
    },
    {
      name: "test notification, unsigned",
      payload,
      headers: { "x-test-notification": "true", ...id },
    },
    {
      name: "test notification, badly signed, odd case",
      payload,
      headers: {
        "x-test-notification": " TRUE ",
        "x-signature-sha256": "bad",
        ...id,
      },
    },
    {
      name: "test notification header false, unsigned",
      payload,
      headers: { "x-test-notification": "false", ...id },
    },
  ];
}
