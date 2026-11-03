/**
 * The sync tools' pure halves: what flow_list / flow_read put in front of an
 * agent, and that no secret is ever in it.
 *
 * Run: tsx src/agent-lib/tools/flow-sync-tools.test.ts
 */
import assert from "node:assert/strict";
import { Types } from "mongoose";

process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY ??
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

import type { IFlow } from "../../database/workspace-schema";
import { flowToFile } from "../../services/flow-config-files";
import { summarizeFlow, triggersOf } from "./flow-sync-tools";

const SECRET = "whsec_do_not_leak_9f8e7d";

function fakeFlow(overrides: Partial<Record<string, unknown>> = {}): IFlow {
  return {
    _id: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    name: "fr_stripe → bigquery_write",
    slug: "fr-stripe-bigquery-write",
    type: "webhook",
    sourceType: "connector",
    dataSourceId: {
      _id: new Types.ObjectId(),
      name: "fr_stripe",
      type: "stripe",
      config: { api_key: SECRET },
    },
    destinationDatabaseId: {
      _id: new Types.ObjectId(),
      name: "bigquery_write",
      type: "bigquery",
    },
    tableDestination: { schema: "fr_stripe_cdc" },
    entityFilter: ["invoices", "customers"],
    syncEngine: "cdc",
    syncState: "active",
    schedule: { enabled: true, cron: "0 4 * * *", timezone: "UTC" },
    backfillSchedule: { enabled: true, cron: "0 3 * * 0", timezone: "UTC" },
    webhookConfig: {
      enabled: true,
      endpoint: "https://app.mako.ai/api/webhooks/ws/flow",
      secret: SECRET,
    },
    sync: {},
    ...overrides,
  } as unknown as IFlow;
}

// 1. A hybrid sync: poll, webhook and resync are three independent triggers.
{
  const t = triggersOf(fakeFlow());
  assert.deepEqual(t.poll, { cron: "0 4 * * *", timezone: "UTC" });
  assert.equal(t.webhook, true);
  assert.deepEqual(t.resync, { cron: "0 3 * * 0", timezone: "UTC" });
}

// 2. Triggers come from the fields, not from `type`: a scheduled flow whose
//    webhook was never provisioned (no endpoint) has no webhook trigger, and
//    a disabled schedule is no poll.
{
  const t = triggersOf(
    fakeFlow({
      type: "scheduled",
      schedule: { enabled: false, cron: "0 0 * * *" },
      webhookConfig: { enabled: true },
    }),
  );
  assert.equal(t.poll, null);
  assert.equal(t.webhook, false);
}

// 3. flow_list's row: the connector and destination by name and type.
{
  const row = summarizeFlow(fakeFlow());
  assert.equal(row.source.kind, "connector");
  assert.equal(row.source.connector, "stripe");
  assert.equal(row.destination.schema, "fr_stripe_cdc");
  assert.deepEqual(row.entities, ["invoices", "customers"]);
  assert.equal(row.engine, "cdc");
}

// 4. Nothing secret, in either tool's output: not the connection's config,
//    not the webhook signing secret, not the endpoint.
{
  const flow = fakeFlow();
  for (const out of [summarizeFlow(flow), flowToFile(flow), triggersOf(flow)]) {
    const text = JSON.stringify(out);
    assert.equal(text.includes(SECRET), false, "a secret leaked");
    assert.equal(text.includes("api_key"), false, "a credential leaked");
    assert.equal(text.includes("/api/webhooks/"), false, "the endpoint leaked");
  }
}

console.info("flow-sync-tools: ok");
