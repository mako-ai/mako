# Changelog

Releases of `mako/stripe`. A workspace installs it with
`source: mako/stripe@1` in `connectors/<slug>/connector.yaml`.

## 1.4.0

- `payment_methods`: a 26th entity, as the realadvisor workspace folder has
  it. Stripe lists payment methods per customer, so it walks customers like
  `customer_balance_transactions`. `since` bounds the walk by the
  customer's `created`. 25 customers per page keep a 10-page chunk at 250
  calls. Columns: the common ones, `customer`, `type`, `billing_details`
  and one JSON column per method type (`card`, `sepa_debit`, `link`, ...),
  a superset of the Airbyte stream.
- 94 webhook events, up from 82. Every event Stripe sends at 2023-10-16 for
  a synced entity now writes that entity:
  - `payment_method.attached`, `.updated`, `.automatically_updated` and
    `.detached`. A detached method keeps its row with `customer` NULL, as
    Airbyte's `payment_methods` holds it.
  - `customer.subscription.trial_will_end`, `.pending_update_applied` and
    `.pending_update_expired`.
  - `invoice.payment_succeeded`, `.payment_action_required`,
    `.finalization_failed` and `.sent`.
  - `payment_intent.partially_funded`.
- Left out: `invoice.upcoming` has no id. `invoice.overdue`,
  `invoice.will_be_due`, `invoice.overpaid` and
  `invoice.payment_attempt_required` are newer than the pinned API version,
  and Stripe refuses an endpoint that lists one.
- An existing endpoint keeps its old list until its flow is re-provisioned
  (`flow_webhook_provision`, or "Create in …" on the Triggers step).

## 1.3.0

- 3 entities, 25 in all. `invoice_line_items`: an invoice's `lines`, read
  with each invoice page. A line carries its invoice as `invoice`,
  `invoice_id` and `invoice_created`, its time. `subscription_items`: a
  subscription's `items`, read with each subscription page (every status).
  An item carries `current_period_start` and `current_period_end` from its
  subscription. A parent embeds 10 children; a longer list costs one more
  call. `events`: `GET /v1/events`, which Stripe keeps for 30 days.
- `since` bounds the two child walks by the parent's `created`.
- Webhooks: an invoice event also writes the invoice's lines, a
  subscription event its items, with the parent's operation. A list cut
  short is read whole first. A failed read defers the whole event. Children
  the flow does not sync cost no request. `events` has no webhook.

## 1.2.0

- 82 webhook events, up from 72. `charge.pending` is the create event of an
  async charge (SEPA, ACH): without it, a pending charge arrived only when
  it settled, days later. Also `charge.expired`,
  `payment_intent.processing`, `payment_intent.requires_action`,
  `payment_intent.amount_capturable_updated`, `invoice.voided`,
  `invoice.marked_uncollectible`, `refund.failed`,
  `customer.subscription.paused` and `customer.subscription.resumed`.
- An existing endpoint keeps its old list until its flow is re-provisioned
  (`flow_webhook_provision`, or "Create in …" on the Triggers step).

## 1.1.0

- Webhooks. The folder declares Stripe's signature scheme as data
  (`stripe-v1`: `Stripe-Signature`, `t=` and `v1=`, HMAC-SHA256 over
  `<t>.<body>`, 300 s window). Mako's API checks it with the flow's secret.
  The secret never reaches a box.
- 72 events map to 19 entities, the same table as the in-process
  connector. A record is the event's `data.object`, unchanged when whole.
- A partial upsert, or a thin event that only names its object, is filled
  by one GET of that object. The webhook's own values win. A 404 skips the
  event. A spent 40 s fill budget defers it. Any other failure fails it for
  a retry. No partial row is ever written.

## 1.0.0

- First release: the in-process Stripe connector ported to
  `@makoai/connector-sdk`, with the same 22 entities, schemas, cursors and
  pagination.
