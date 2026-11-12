---
title: Run Notifications
description: Email, webhook, and Slack notifications for scheduled query, flow, and dbt job runs.
---

Mako can notify you when a scheduled console query, a flow, or a dbt job finishes. Rules are workspace-scoped and admin-managed; deliveries fan out per terminal run.

## How it works

When a scheduled query, flow, or dbt job run reaches a terminal state, Mako emits an internal `flow.run.terminal` event. An Inngest fan-out function looks up matching `NotificationRule` records (by `workspaceId`, `resourceType`, `resourceId`, `enabled`, `triggers`) and queues one delivery per matching rule and channel.

- **Triggers**: `success`, `failure`. A rule must list at least one to fire.
- **Resources**: `scheduled_query` (saved console with a schedule), `flow`, `dbt_job` (one dbt job), or `dbt_project` (the default for every job of a dbt project).
- **Channels**: `email`, `webhook`, `slack`. One channel per rule.
- **Idempotency**: deliveries are keyed by `resourceType:resourceId:runId:trigger:channelType:ruleId`. Re-emits do not duplicate. One run posts at most once per rule.
- **Retries**: the deliver job retries up to 5 times via Inngest. The fan-out step retries up to 3 times.

## Configuring notifications in the UI

Open a saved console's schedule modal or a flow's configuration form and use the **Notifications** section. You can:

- Add a rule (pick triggers, channel, and channel-specific config)
- Send a **Test** notification before saving
- See a delivery log with status, attempts, HTTP status, and last error
- Disable a rule without deleting it

Workspace admins are the only role allowed to create, update, or delete rules. Any workspace member can read rules and the delivery log.

## dbt job alerts

A dbt job run notifies through the same rules. Two resource types exist:

| Resource type | `resourceId` | Reach |
| ------------- | ------------ | ----- |
| `dbt_job`     | the job id   | Runs of that job. |
| `dbt_project` | the project id | Runs of every job of the project. Use it as the workspace default. |

A run matches the rules on its job and the rules on its project. A job rule and a project default both deliver: add a job rule to reach an extra channel, and disable the project default to silence it everywhere.

### Set up an alert in the UI

- **One job**: open the job, click **Alerts** in the header, then **Add notification**. The button shows how many alerts cover the job, project defaults included.
- **Every job of a project**: open the project settings drawer and use **Job alerts**.

Pick the events, pick a channel (email, signed webhook, or Slack incoming webhook), then send a **Test**.

### When an alert fires

dbt rules follow the state of the job, so a job that fails every hour posts once.

| Rule setting | A run fails | A run succeeds |
| ------------ | ----------- | -------------- |
| `failure` trigger (default) | Posts when the previous run of the job had not failed. | |
| `failure` trigger with `everyFailure: true` | Posts on every failed run. | |
| `success` trigger | | Posts once on recovery: the previous run had failed. |

- The previous run is the last finished run of the same job. Cancelled runs are ignored.
- The first run of a job posts when it fails.
- A cancelled run posts nothing.
- Runs started without a job (editor builds, agent builds, CI) post nothing.

### What the message contains

- The outcome, the job name, and the environment, first.
- How the run started (schedule, manual, agent) and its duration.
- On failure: the first 10 failing models and tests, each with its dbt message cut to 300 characters, plus the count of the rest.
- A link that opens the run in Mako.

Mako masks connection-string credentials and `password=` style values in dbt messages before sending.

Example Slack message:

```text
*dbt job failed: Nightly build* (prod)
2 steps failed · Scheduled run · 4 min 12 s
• `fct_orders (model, error)`: Database Error: column order_id not found
• `not_null_orders_id (test, fail)`: Got 3 results, configured to fail if != 0
Open the run in Mako
```

### Where the credentials live

Webhook URLs and Slack webhook URLs are credentials. Mako stores them encrypted on the rule. Job files (`dbt/jobs/<slug>.yml`) hold no notification settings. Slack delivery uses an incoming webhook URL, which is bound to one channel in Slack.

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

Mako posts a Slack mrkdwn message with the run status, resource, run ID, completion time, duration, row count, error (on failure), and a deep link. dbt job runs use the format shown under [dbt job alerts](#dbt-job-alerts).

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

`triggerType` describes how the run was started: `schedule` or `manual`, plus `agent` for dbt job runs.

### dbt job payload

A dbt job run sends the same shape with `resourceType: "dbt_job"` and these extra fields. `resourceId` is the job id, including when a `dbt_project` rule delivers.

```json
{
  "version": 1,
  "event": "flow.run.terminal",
  "trigger": "failure",
  "resourceType": "dbt_job",
  "resourceId": "66b...",
  "resourceName": "Nightly build",
  "runId": "66c...",
  "completedAt": "2026-05-02T04:04:12.345Z",
  "durationMs": 252000,
  "errorMessage": "dbt build exited with code 1",
  "triggerType": "schedule",
  "workspaceId": "65a...",
  "deepLink": "https://app.mako.ai/x/66a.../job/66b...?run=66c...",
  "projectId": "66a...",
  "environment": "prod",
  "failedSteps": [
    {
      "name": "fct_orders",
      "resourceType": "model",
      "status": "error",
      "message": "Database Error: column order_id not found"
    }
  ],
  "failedStepCount": 1
}
```

| Field | Present | Meaning |
| ----- | ------- | ------- |
| `projectId`, `environment` | always | The dbt project and the environment the run built into. |
| `failedSteps` | `trigger: "failure"` | Up to 10 failed models and tests. `status` is `error`, `fail`, or `runtime error`. `message` holds up to 300 characters. |
| `failedStepCount` | `trigger: "failure"` | Every failed step, including those cut from `failedSteps`. `0` when the run failed before dbt reported a step; read `errorMessage`. |
| `errorMessage` | `trigger: "failure"` | The run-level error, up to 500 characters. |
| `recovered` | `trigger: "success"` | `true` when the previous run of the job had failed. |

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

### Create a dbt project default (example)

```bash
curl -X POST \
  -H "Authorization: Bearer revops_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "resourceType": "dbt_project",
    "resourceId": "PROJECT_ID",
    "triggers": ["failure", "success"],
    "everyFailure": false,
    "channelType": "slack",
    "slackWebhookUrl": "https://hooks.slack.com/services/T.../B.../...",
    "displayLabel": "#data-alerts"
  }' \
  https://app.mako.ai/api/workspaces/WORKSPACE_ID/notification-rules
```

Use `"resourceType": "dbt_job"` with a job id for one job. `everyFailure` is accepted on `dbt_job` and `dbt_project` rules only, on create and on `PATCH`.

The response includes the sanitized rule plus, for newly-generated webhook secrets, `signingSecretOnce`. Persist it before discarding the response.

### Rotate a webhook secret

`PATCH` the rule with the same channel config and `rotateWebhookSecret: true`. The response will include a fresh `signingSecretOnce`.

### Delivery log

```bash
curl -H "Authorization: Bearer revops_YOUR_API_KEY" \
  "https://app.mako.ai/api/workspaces/WORKSPACE_ID/notification-rules/deliveries?resourceType=scheduled_query&resourceId=65f...&limit=50"
```

Each delivery row records `ruleId`, `runId`, `trigger`, `channelType`, `status`, `attempts`, `httpStatus`, `lastError`, `sentAt`, `completedAt`.

For dbt, a job's log lists every delivery about that job, project defaults included. A project's log lists the deliveries of its own default rules.

## Limits and behavior

- One channel per rule. Add multiple rules to fan out to multiple channels.
- dbt rules post on state changes by default (first failure, recovery). Scheduled query and flow rules post on every matching run.
- Test deliveries do **not** create persistent delivery records.
- Failed deliveries retry up to 5 times with Inngest's default backoff before being recorded as failed.
- Webhook signing secrets are generated as `whsec_<64-hex>` and never returned again after creation/rotation.
