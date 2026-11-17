/**
 * The Close folder's webhook handler, run as Mako runs it: a `webhook`
 * command through `SandboxedConnector.runWebhookBatch`, with only the box
 * swapped for a local process running the same SDK runner on the same
 * files. Close is a small local server that serves single objects, so every
 * request the handler makes is seen. No real data, no network.
 *
 * The rule is the in-process connector's (PR 1314): a Close payload leaves
 * out an object's expansions, so a partial upsert is filled from
 * `GET /<object>/<id>/?_fields=<missing>` before it is answered. Only absent
 * keys are filled and the webhook's own values win. A 404 drops the record.
 * A failed read fails the event for a retry. A spent budget defers it. A
 * partial record is never answered unfilled, so it never writes NULLs.
 *
 * Run: node --import tsx src/connectors/close/folder-webhook-batches.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SandboxedConnector } from "../workspace/SandboxedConnector";
import type { LoadedConnector } from "../workspace/resolver";
import type { ConnectorCommand, RunResult } from "../workspace/sync-box";
import {
  FOLDER,
  RUNNER,
  ensureFolderInstalled,
  folderEnv,
  runFolderCommand,
} from "../../../../connectors/close/fixtures/harness.mjs";
import { buildWebhookEvents } from "../../../../connectors/close/fixtures/webhook-events.mjs";
import { CloseConnector } from "./connector";
import { CLOSE_WEBHOOK_FILL_FIELDS } from "./webhooks";

process.env.CONNECTOR_WEBHOOK_BATCHES = "true";

const API_KEY = "api_test_webhooks";
let spec: Record<string, any>;

/** A Close that serves objects by id. Every request is recorded. */
const objects = new Map<string, Record<string, unknown>>();
const failing = new Set<string>();
const requests: string[] = [];
let server: http.Server;
let baseUrl = "";

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
    return runFolder(command, { config: options.config, batch: options.batch });
  }
}

const connector = () =>
  new BoxlessClose({
    _id: "665f000000000000000000c1",
    workspaceId: "ws_webhooks",
    name: "PL Close shadow",
    type: "ws:close",
    config: { api_key: API_KEY, __base_url: baseUrl },
  } as never);

before(async () => {
  ensureFolderInstalled();
  const result = await runFolderCommand("spec");
  spec = result.messages.find(m => m.type === "SPEC")!.spec;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://close.local");
    const route = url.pathname.replace(/^\/api\/v1/, "");
    requests.push(`${req.method} ${route}${url.search}`);
    res.setHeader("content-type", "application/json");
    if (failing.has(route)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Bad request" }));
      return;
    }
    const object = objects.get(route);
    if (!object) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    const wanted = url.searchParams.get("_fields")?.split(",");
    res.end(
      JSON.stringify(
        wanted
          ? Object.fromEntries(
              Object.entries(object).filter(([k]) => wanted.includes(k)),
            )
          : object,
      ),
    );
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise(resolve => server?.close(resolve));
});

/** An event of `type` whose data lacks `drop`, re-ided to `id`. */
function partial(
  eventType: string,
  id: string,
  eventId: string,
  drop: readonly string[],
) {
  const [template] = buildWebhookEvents([eventType]);
  const raw = structuredClone(template.rawPayload);
  raw.event.id = eventId;
  raw.event.object_id = id;
  raw.event.data = { ...raw.event.data, id };
  for (const field of drop) delete raw.event.data[field];
  return {
    eventId,
    eventType,
    rawPayload: raw,
    receivedAt: "2026-11-16T11:00:00.000Z",
  };
}

const outcomesOf = (result: RunResult): any[] =>
  result.messages.filter(m => m.type === "WEBHOOK").map(m => m.webhook);

void test("the folder fills the same fields from the same objects as the in-process connector", async () => {
  const folder = await import(
    pathToFileURL(path.join(FOLDER, "webhook-handler.ts")).href
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(folder.CLOSE_WEBHOOK_FILL_FIELDS)),
    JSON.parse(JSON.stringify(CLOSE_WEBHOOK_FILL_FIELDS)),
  );
  assert.deepEqual(spec.mako.webhooks.verification, {
    scheme: "hmac-sha256",
    secretEncoding: "hex",
    signedPayload: ["header:close-sig-timestamp", "body"],
    signatureHeader: "close-sig-hash",
    signatureEncoding: "hex",
    timestampHeader: "close-sig-timestamp",
    toleranceSeconds: 300,
  });
  assert.equal(spec.mako.webhooks.events.length, 86);
});

void test("partial upserts are filled by object GET, the webhook's values win, and a 404 drops", async () => {
  const lead = CLOSE_WEBHOOK_FILL_FIELDS.leads.fields;
  const contact = CLOSE_WEBHOOK_FILL_FIELDS.contacts.fields;
  objects.set("/lead/lead_full/", {
    id: "lead_full",
    name: "From GET, must not win",
    contacts: [{ id: "cont_1" }],
    opportunities: [],
    tasks: [{ id: "task_1" }],
    html_url: "https://app.close.com/lead/lead_full/",
    integration_links: [],
    primary_email: { email: "x@example.com" },
    // primary_phone is left out by Close too: stored as NULL, as a backfill.
  });
  objects.set("/contact/cont_full/", {
    id: "cont_full",
    display_name: "Contact Full",
    integration_links: [],
  });
  const events = [
    partial("lead.updated", "lead_full", "ev_lead", lead),
    partial("contact.updated", "cont_full", "ev_contact", contact),
    partial("lead.updated", "lead_gone", "ev_gone", lead),
    buildWebhookEvents(["activity.call.created"])[0],
    buildWebhookEvents(["lead.deleted"])[0],
  ].map(e => ({ receivedAt: "2026-11-16T11:00:00.000Z", ...e }));

  // The problem, as the extraction alone has it: the columns are absent.
  const builtIn = new CloseConnector({
    _id: "665f000000000000000000c0",
    name: "PL Close",
    type: "close",
    config: { api_key: API_KEY },
  } as never);
  const extracted = builtIn.extractWebhookCdcRecords(
    events[0].rawPayload,
    "lead.updated",
  )[0].payload as Record<string, unknown>;
  for (const field of lead) assert.equal(field in extracted, false, field);

  handed.length = 0;
  requests.length = 0;
  const result = await connector().runWebhookBatch(
    { events },
    { timeoutMs: 60_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);

  // The box got the connection's credential and the events, nothing else.
  assert.equal(handed[0].command, "webhook");
  assert.deepEqual(Object.keys(handed[0].options.batch), ["events"]);
  assert.equal(handed[0].options.config.api_key, API_KEY);

  const outcomes = outcomesOf(result);
  assert.deepEqual(
    outcomes.map(o => [o.eventId, o.outcome]),
    events.map((e, i) => [e.eventId, i === 2 ? "skipped" : "records"]),
  );

  const filledLead = outcomes[0].records[0].payload;
  assert.deepEqual(filledLead.contacts, [{ id: "cont_1" }]);
  assert.deepEqual(filledLead.tasks, [{ id: "task_1" }]);
  assert.equal(filledLead.primary_phone, null);
  // The webhook's own name, never the GET's.
  assert.equal(filledLead.name, events[0].rawPayload.event.data.name);
  assert.equal(outcomes[0].records[0].changeId, "ev_lead");
  for (const field of lead) assert.ok(field in filledLead, field);

  assert.equal(outcomes[1].records[0].payload.display_name, "Contact Full");
  assert.match(outcomes[2].reason, /404/);
  assert.equal(outcomes[4].records[0].operation, "delete");

  // Exactly one GET per partial upsert, for exactly the missing fields.
  // The call and the delete cost none.
  assert.deepEqual(requests, [
    `GET /lead/lead_full/?_fields=${encodeURIComponent(lead.join(","))}`,
    `GET /contact/cont_full/?_fields=${encodeURIComponent(contact.join(","))}`,
    `GET /lead/lead_gone/?_fields=${encodeURIComponent(lead.join(","))}`,
  ]);
});

void test("a read that fails holds the whole event back, for a retry, never unfilled", async () => {
  failing.add("/opportunity/oppo_bad/");
  const fields = CLOSE_WEBHOOK_FILL_FIELDS.opportunities.fields;
  const events = [partial("opportunity.updated", "oppo_bad", "ev_bad", fields)];
  const result = await connector().runWebhookBatch(
    { events },
    { timeoutMs: 60_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const [outcome] = outcomesOf(result);
  assert.equal(outcome.outcome, "extract_failed");
  assert.match(outcome.reason, /oppo_bad.*HTTP 400/);
});

void test("past the fill budget, events are deferred, never answered unfilled", async () => {
  const folder = await import(
    pathToFileURL(path.join(FOLDER, "webhook-handler.ts")).href
  );
  const fields = CLOSE_WEBHOOK_FILL_FIELDS.leads.fields;
  let clock = 0;
  const gets: string[] = [];
  const api = {
    async get(endpoint: string) {
      gets.push(endpoint);
      clock += 600;
      return { contacts: [] };
    },
    async post() {
      throw new Error("no search");
    },
  };
  const events = [
    partial("lead.updated", "lead_a", "ev_a", fields),
    partial("lead.updated", "lead_b", "ev_b", fields),
    partial("lead.updated", "lead_c", "ev_c", fields),
    buildWebhookEvents(["lead.deleted"])[0],
  ];
  const outcomes = await folder.handleCloseWebhookBatch(
    { api, log: () => {}, budgetMs: 1_000, now: () => clock },
    events,
  );
  assert.deepEqual(
    outcomes.map((o: any) => o.outcome),
    ["records", "records", "deferred", "records"],
  );
  assert.equal(gets.length, 2);
});

void test("an id that is not a Close id is refused before any request", async () => {
  const fields = CLOSE_WEBHOOK_FILL_FIELDS.leads.fields;
  const events = ["..", "lead_x/../../me", "lead_x?_fields=x"].map((id, i) =>
    partial("lead.updated", id, `ev_badid_${i}`, fields),
  );
  requests.length = 0;
  const result = await connector().runWebhookBatch(
    { events },
    { timeoutMs: 60_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(
    outcomesOf(result).map(o => o.outcome),
    ["extract_failed", "extract_failed", "extract_failed"],
  );
  assert.deepEqual(requests, []);
});
