/**
 * Runs the folder's in-process webhook half (`webhook` exported by
 * `connector.ts`: the mapping and the reference signature check) on a JSON
 * file and prints the answer as JSON on stdout. The box runs the SDK's
 * `webhook` command instead; this is what the parity harness compares with
 * the in-process connector.
 *
 *   node webhook-cli.mjs batch.json
 *
 * The file is `{ verify: [{ payload, headers, secret }], publicKeys,
 * entitySets: [[entity]], events: [...] }`. It imports the folder's
 * TypeScript directly, as the SDK runner does.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { webhook } = await import(
  pathToFileURL(path.join(here, "../connector.ts")).href
);
const { verifyWiseWebhook } = await import(
  pathToFileURL(path.join(here, "../webhooks.ts")).href
);

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = {
  events: webhook.events(),
  eventsForEntities: (input.entitySets ?? []).map(entities =>
    webhook.eventsForEntities(entities),
  ),
  verify: (input.verify ?? []).map(delivery =>
    input.publicKeys
      ? verifyWiseWebhook(delivery, () => input.publicKeys)
      : webhook.verify(delivery),
  ),
  outcomes: webhook.handleBatch(input.events ?? []),
};
process.stdout.write(JSON.stringify(out));
