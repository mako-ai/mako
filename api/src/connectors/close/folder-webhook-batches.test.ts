/**
 * The Close folder's webhook handler, run as Mako runs it: a `webhook`
 * command through `SandboxedConnector.runWebhookBatch`, with only the box
 * swapped for a local process running the same SDK runner on the same files.
 * Close is the local emulator serving the synthetic dataset (no real data,
 * no network).
 *
 * The point: a `lead.updated` payload carries no `contacts`, `opportunities`
 * or `tasks`. Written as is it would NULL those columns. The handler
 * re-fetches the lead by id, and the row it returns must be the row a read
 * of `leads` stores, byte for byte.
 *
 * Run: node --import tsx src/connectors/close/folder-webhook-batches.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxedConnector } from "../workspace/SandboxedConnector";
import type { LoadedConnector } from "../workspace/resolver";
import type { ConnectorCommand, RunResult } from "../workspace/sync-box";
import {
  FOLDER,
  RUNNER,
  ensureFolderInstalled,
  folderEnv,
  runFolderCommand,
  startRecordingServer,
  type FixtureServer,
} from "../../../../connectors/close/fixtures/harness.mjs";
import { buildDataset } from "../../../../connectors/close/fixtures/dataset.mjs";
import { buildWebhookEvents } from "../../../../connectors/close/fixtures/webhook-events.mjs";
import { CloseConnector } from "./connector";

process.env.CONNECTOR_WEBHOOK_BATCHES = "true";

const API_KEY = "api_test_webhooks";
let server: FixtureServer;
let spec: Record<string, any>;

/** Run one SDK command on the folder, with every input as a file. */
function runFolder(
  command: string,
  inputs: Record<string, unknown>,
): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-close-webhook-"));
  const args = [
    RUNNER,
    command,
    "--connector",
    path.join(FOLDER, "connector.ts"),
  ];
  for (const [name, value] of Object.entries(inputs)) {
    if (value === undefined) continue;
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
    args.push(`--${name}`, file);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: FOLDER,
      env: folderEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({
        exitCode: code ?? 1,
        messages: stdout
          .split("\n")
          .filter(Boolean)
          .map(line => JSON.parse(line)),
        malformed: [],
        stderr,
        timedOut: false,
      });
    });
  });
}

/** What the box would be handed, kept for the assertions. */
const handed: Array<{ command: ConnectorCommand; options: any }> = [];

class BoxlessClose extends SandboxedConnector {
  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "close",
      runtime: "node",
      entry: "connector.ts",
      sha: "webhooks",
      sourceSha: "webhooks",
      spec,
      entities: Object.keys(spec?.mako?.entities ?? {}),
      status: "indexed",
    } as LoadedConnector;
    return this.loaded;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    handed.push({ command, options });
    return runFolder(command, {
      config: options.config,
      batch: options.batch,
    });
  }
}

const connector = () =>
  new BoxlessClose({
    _id: "665f000000000000000000c1",
    workspaceId: "ws_webhooks",
    name: "PL Close shadow",
    type: "ws:close",
    config: { api_key: API_KEY, __base_url: server.url },
  } as never);

before(async () => {
  ensureFolderInstalled();
  server = await startRecordingServer(buildDataset());
  const result = await runFolderCommand("spec");
  spec = result.messages.find(m => m.type === "SPEC")!.spec;
});

after(async () => {
  await server?.close();
});

/** A lead.updated as Close sends it: the lead without its nested lists. */
function partialLeadUpdated(index: number, eventId: string) {
  const dataset = buildDataset() as any;
  const lead = { ...dataset.search.lead[index] };
  delete lead.contacts;
  delete lead.opportunities;
  delete lead.tasks;
  delete lead.contact_ids;
  const [template] = buildWebhookEvents(["lead.updated"]);
  const raw = structuredClone(template.rawPayload);
  raw.event.id = eventId;
  raw.event.object_id = lead.id;
  raw.event.data = lead;
  return { eventId, eventType: "lead.updated", rawPayload: raw, lead };
}

/** Every `leads` row a full read stores, by id. */
async function leadsAsRead(): Promise<Map<string, Record<string, unknown>>> {
  const read = await runFolder("read", {
    config: { api_key: API_KEY, __base_url: server.url },
    catalog: {
      streams: [{ stream: { name: "leads" }, sync_mode: "incremental" }],
    },
  });
  assert.equal(read.exitCode, 0, read.stderr);
  const rows = new Map<string, Record<string, unknown>>();
  for (const m of read.messages) {
    const record = (m as any).record;
    if (m.type === "RECORD") rows.set(record.data.id, record.data);
  }
  return rows;
}

void test("spec carries the Close verification as data and the 86 events", () => {
  assert.deepEqual(spec.mako.webhooks.verification, {
    scheme: "hmac-sha256",
    secretEncoding: "hex",
    signedPayload: ["header:close-sig-timestamp", "body"],
    signatureHeader: "close-sig-hash",
    signatureEncoding: "hex",
  });
  assert.equal(spec.mako.webhooks.events.length, 86);
});

void test("a partial lead.updated is re-fetched by id and writes the row a read writes, never NULLs", async () => {
  const a = partialLeadUpdated(7, "ev_partial_a");
  const b = partialLeadUpdated(42, "ev_partial_b");
  const gone = partialLeadUpdated(8, "ev_gone");
  gone.rawPayload.event.object_id = "lead_does_not_exist";
  gone.rawPayload.event.data = {
    ...gone.rawPayload.event.data,
    id: "lead_does_not_exist",
  };
  const [contact] = buildWebhookEvents(["contact.updated"]);
  const [deleted] = buildWebhookEvents(["lead.deleted"]);
  const [unmapped] = buildWebhookEvents(["export.lead.completed"]).slice(-1);
  const events = [a, contact, b, gone, deleted, unmapped].map(e => ({
    eventId: e.eventId,
    eventType: e.eventType,
    rawPayload: e.rawPayload,
    receivedAt: "2026-11-16T11:00:00.000Z",
  }));

  // The problem, as the in-process connector has it: no contacts at all.
  const builtIn = new CloseConnector({
    _id: "665f000000000000000000c0",
    name: "PL Close",
    type: "close",
    config: { api_key: API_KEY },
  } as never);
  const inline = events.map(e =>
    builtIn.extractWebhookCdcRecords(e.rawPayload, e.eventType),
  );
  const inlineLead = inline[0][0].payload as Record<string, unknown>;
  assert.equal(inlineLead.contacts, undefined);
  assert.equal(inlineLead.contact_ids, undefined);

  handed.length = 0;
  const before = server.requests(API_KEY).length;
  const result = await connector().runWebhookBatch(
    { events },
    { timeoutMs: 60_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const requests = server.requests(API_KEY).slice(before);

  // The box got the connection's credential and the events, nothing else.
  assert.equal(handed.length, 1);
  assert.equal(handed[0].command, "webhook");
  assert.deepEqual(Object.keys(handed[0].options.batch), ["events"]);
  assert.equal(handed[0].options.config.api_key, API_KEY);
  assert.equal(handed[0].options.timeoutMs, 60_000);

  const outcomes: any[] = result.messages
    .filter(m => m.type === "WEBHOOK")
    .map(m => m.webhook);
  assert.deepEqual(
    outcomes.map(o => [o.eventId, o.outcome]),
    [
      ["ev_partial_a", "records"],
      [contact.eventId, "records"],
      ["ev_partial_b", "records"],
      ["ev_gone", "skipped"],
      [deleted.eventId, "records"],
      [unmapped.eventId, "unmapped"],
    ],
  );
  assert.match(outcomes[3].reason, /lead_does_not_exist/);

  const read = await leadsAsRead();
  for (const [i, partial] of [
    [0, a],
    [2, b],
  ] as const) {
    const record = outcomes[i].records[0];
    const row = read.get(partial.lead.id)!;
    assert.ok(row, `the read has ${partial.lead.id}`);
    assert.ok(Array.isArray(record.payload.contacts));
    assert.ok((record.payload.contact_ids as unknown[]).length > 0);
    assert.deepEqual(record.payload, row);
    assert.equal(record.changeId, partial.eventId);
    // Never older than the event: the row is as of the re-fetch.
    assert.ok(
      new Date(record.sourceTs) >=
        new Date(partial.rawPayload.event.date_updated),
    );
  }

  // The contact passes through as in-process extracts it.
  assert.deepEqual(
    outcomes[1].records.map((r: any) => [r.entity, r.recordId, r.payload]),
    inline[1].map(r => [r.entity, r.recordId, r.payload]),
  );
  // A delete is never re-fetched.
  assert.equal(outcomes[4].records[0].operation, "delete");

  // The re-fetch: by-id Search requests only. Leads carry 70 custom fields
  // and the emulator refuses over 50 selectors, so the first is refused and
  // the budget halves, as a read's does.
  assert.ok(requests.length > 0 && requests.length <= 8, requests.join("\n"));
  for (const request of requests) {
    assert.match(request, /\/custom_field_schema\/lead\/|\/data\/search\//);
  }
});

void test("a batch with no lead upserts makes no request to Close", async () => {
  const events = buildWebhookEvents([
    "contact.created",
    "activity.call.created",
    "lead.deleted",
  ])
    // The builder appends its edge cases (a lead.updated among them).
    .slice(0, 3)
    .map(e => ({ ...e, receivedAt: "2026-11-16T11:00:00.000Z" }));
  const before = server.requests(API_KEY).length;
  const result = await connector().runWebhookBatch(
    { events },
    { timeoutMs: 60_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(server.requests(API_KEY).slice(before), []);
  const outcomes = result.messages.filter(m => m.type === "WEBHOOK");
  assert.equal(outcomes.length, 3);
});
