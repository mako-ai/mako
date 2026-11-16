/**
 * Stands in for the `webhook` command the SDK does not have yet: reads a
 * JSON file and prints the folder's answer as JSON on stdout.
 *
 *   node webhook-cli.mjs batch.json
 *
 * The file is `{ verify: [{ payload, headers, secret }], events: [...] }`.
 * `verify` runs the signature check per delivery; `events` runs
 * `handleBatch`. It imports the folder's TypeScript directly, as the SDK
 * runner does.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { webhook } = await import(
  pathToFileURL(path.join(here, "../connector.ts")).href
);

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = {
  events: webhook.events(),
  verify: (input.verify ?? []).map(delivery => webhook.verify(delivery)),
  outcomes: webhook.handleBatch(input.events ?? []),
};
process.stdout.write(JSON.stringify(out));
