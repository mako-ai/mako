---
title: Flow Run Notifications
description: Email, webhook, and Slack notifications for scheduled query and flow runs.
---

Mako can notify you when a scheduled console query or flow finishes. Rules are workspace-scoped and admin-managed; deliveries fan out per terminal run.

## How it works

When a scheduled query or flow reaches a terminal state, Mako emits an internal `flow.run.terminal` event. An Inngest fan-out function looks up matching `NotificationRule` records (by `workspaceId`, `resourceType`, `resourceId`, `enabled`, `triggers`) and queues one delivery per matching rule and channel.

- **Triggers**: `success`, `failure`. A rule must list at least one to fire.
- **Resources**: `scheduled_query` (saved console with a schedule) or `flow`.
- **Channels**: `email`, `webhook`, `slack`. One channel per rule.
- **Idempotency**: deliveries are keyed by `resourceType:resourceId:runId:trigger:channelType:ruleId`. Re-emits do not duplicate.
- **Retries**: the deliver job retries up to 5 times via Inngest. The fan-out step retries up to 3 times.

## Configuring notifications in the UI

Open a saved console's schedule modal or a flow's configuration form and use the **Notifications** section. You can:

- Add a rule (pick triggers, channel, and channel-specific config)
- Send a **Test** notification before saving
- See a delivery log with status, attempts, HTTP status, and last error
- Disable a rule without deleting it

Workspace admins are the only role allowed to create, update, or delete rules. Any workspace member can read rules and the delivery log.

## Channels

### Email

```json
{
  "channelType": "email",
  "recipients": ["alerts@example.com", "ops@example.com"]
}
```

Mako sends a templated email with the run status, resource name, completion time, duration, row count (if available), error message (on failure), and a deep link back to the console or flow.

### Webhook

```json
{
  "channelType": "webhook",
  "url": "https://example.com/hooks/mako",
  "rotateWebhookSecret": false
}
```

When a webhook rule is created (or rotated), Mako returns the signing secret **once** in the response body as `signingSecretOnce`. Store it — it is not retrievable later.

Mako `POST`s a JSON body to your endpoint with these headers:

| Header              | Value                                            |
| ------------------- | ------------------------------------------------ |
| `Content-Type`      | `application/json`                               |
| `X-Mako-Signature`  | `HMAC-SHA256(signingSecret, rawBody)` as hex     |

Verify in Node.js:

```ts
import crypto from "crypto";

function verifyMakoSignature(rawBody: string, header: string, secret: string) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}
```

Any non-2xx response is treated as a failure and retried.

### Slack (Incoming Webhook)

```json
{
  "channelType": "slack",
  "slackWebhookUrl": "https://hooks.slack.com/services/T.../B.../...",
  "displayLabel": "#data-alerts"
}
```

Mako posts a Slack mrkdwn message with the run status, resource, run ID, completion time, duration, row count, error (on failure), and a deep link.

## Webhook payload

All channels share the same outbound payload shape (Slack and email render it differently):

```json
{
  "version": 1,
  "event": "flow.run.terminal",
  "trigger": "success",
  "resourceType": "scheduled_query",
  "resourceId": "65f...",
  "resourceName": "Daily revenue rollup",
  "runId": "01HX...",
  "completedAt": "2026-05-02T04:00:12.345Z",
  "durationMs": 1842,
  "rowCount": 124,
  "errorMessage": null,
  "triggerType": "scheduled",
  "workspaceId": "65a...",
  "deepLink": "https://app.mako.ai/workspace/65a.../console/65f..."
}
```

`triggerType` describes how the run was started: `scheduled`, `manual`, `backfill`, etc.

## API reference

All endpoints are scoped to a workspace and require workspace-member access. Mutations require workspace admin (owner or admin role) or a workspace API key. Base path: `/api/workspaces/:workspaceId/notification-rules`.

| Method   | Endpoint                | Description                                                                  |
| -------- | ----------------------- | ---------------------------------------------------------------------------- |
| `GET`    | `/`                     | List rules for a resource. Query: `resourceType`, `resourceId` (required).   |
| `GET`    | `/deliveries`           | List recent deliveries for a resource. Query: `resourceType`, `resourceId`, optional `limit`. |
| `POST`   | `/`                     | Create a rule. Admin only.                                                   |
| `PATCH`  | `/:ruleId`              | Update triggers / channel / enabled flag. Admin only.                        |
| `DELETE` | `/:ruleId`              | Delete a rule. Admin only.                                                   |
| `POST`   | `/test`                 | Send a one-off test notification (using saved rule by `ruleId`, or ad-hoc channel config). |

### Create rule (example)

```bash
curl -X POST \
  -H "Authorization: Bearer revops_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "resourceType": "scheduled_query",
    "resourceId": "65f...",
    "enabled": true,
    "triggers": ["failure"],
    "channelType": "webhook",
    "url": "https://example.com/hooks/mako"
  }' \
  https://app.mako.ai/api/workspaces/WORKSPACE_ID/notification-rules
```

The response includes the sanitized rule plus, for newly-generated webhook secrets, `signingSecretOnce`. Persist it before discarding the response.

### Rotate a webhook secret

`PATCH` the rule with the same channel config and `rotateWebhookSecret: true`. The response will include a fresh `signingSecretOnce`.

### Delivery log

```bash
curl -H "Authorization: Bearer revops_YOUR_API_KEY" \
  "https://app.mako.ai/api/workspaces/WORKSPACE_ID/notification-rules/deliveries?resourceType=scheduled_query&resourceId=65f...&limit=50"
```

Each delivery row records `ruleId`, `runId`, `trigger`, `channelType`, `status`, `attempts`, `httpStatus`, `lastError`, `sentAt`, `completedAt`.

## Limits and behavior

- One channel per rule. Add multiple rules to fan out to multiple channels.
- Test deliveries do **not** create persistent delivery records.
- Failed deliveries retry up to 5 times with Inngest's default backoff before being recorded as failed.
- Webhook signing secrets are generated as `whsec_<64-hex>` and never returned again after creation/rotation.
