/**
 * The folder's webhook mapping, before any fill, as JSON on stdout: what
 * the parity harness compares with the in-process extraction.
 *
 *   node webhook-cli.mjs input.json
 *
 * The file is `{ events: [...], selections: [[entity, ...], ...] }`. It
 * imports the folder's TypeScript directly, as the SDK runner does.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const webhooks = await import(
  pathToFileURL(path.join(here, "../webhooks.ts")).href
);

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = {
  events: [...webhooks.CALENDLY_SUPPORTED_WEBHOOK_EVENTS],
  eventsForEntities: (input.selections ?? []).map(entities =>
    webhooks.calendlyWebhookEventsForEntities(entities),
  ),
  outcomes: webhooks.mapWebhookBatch(input.events ?? []),
};
process.stdout.write(JSON.stringify(out));
