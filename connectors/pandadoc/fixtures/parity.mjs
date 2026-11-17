/**
 * PandaDoc parity: the in-process connector against this folder, entity by
 * entity, on the recorded cassettes. Prints the table and exits 1 on any
 * difference.
 *
 * From the repository root:
 *
 *   pnpm --filter api exec tsx ../connectors/pandadoc/fixtures/parity.mjs
 *   pnpm --filter api exec tsx ../connectors/pandadoc/fixtures/parity.mjs --record
 *
 * `--record` rebuilds the cassettes: it serves `dataset.mjs` through a
 * local PandaDoc emulator, runs only the in-process connector through every
 * scenario, `check` and the webhook fills, and writes what it was sent and
 * answered to `cassettes/`. It never calls PandaDoc. Runs under tsx because
 * the in-process connector is API TypeScript.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTITIES,
  RATE_LIMIT_ENTITIES,
  RATE_LIMIT_SCENARIO,
  SCENARIOS,
  ensureFolderInstalled,
  formatReport,
  freezeClock,
  inProcessFactory,
  readInProcess,
  runParity,
  saveCassettes,
  startRecordingServer,
  startReplayServer,
} from "./harness.mjs";
import { webhookFillRequests } from "./webhook-events.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = relative => path.join(here, "../../../api/src", relative);
const { PandaDocConnector } = await import(
  api("connectors/pandadoc/connector.ts")
);
const makeInProcess = inProcessFactory(PandaDocConnector);

const restore = freezeClock();
ensureFolderInstalled();

if (process.argv.includes("--record")) {
  const server = await startRecordingServer();
  const scenarios = [...SCENARIOS, RATE_LIMIT_SCENARIO];
  for (const scenario of scenarios) {
    for (const entity of ENTITIES) {
      if (scenario.rateLimited && !RATE_LIMIT_ENTITIES.includes(entity)) {
        continue;
      }
      await readInProcess(
        () =>
          makeInProcess({
            api_key: `api_test_record_${scenario.name}_${entity}`,
            api_base_url: server.url,
            ...(scenario.config ?? {}),
          }),
        {
          entity,
          since: scenario.since,
          maxIterations: scenario.maxIterations,
          pageSize: scenario.pageSize,
        },
      );
    }
  }
  await makeInProcess({
    api_key: "api_test_record_check",
    api_base_url: server.url,
  }).testConnection();
  for (const route of webhookFillRequests()) {
    await fetch(`${server.url}${route}`, {
      headers: { authorization: "API-Key api_test_record_webhooks" },
    });
  }
  saveCassettes(server.recorded);
  console.log(`Recorded ${server.recorded.size} interactions.`);
  await server.close();
}

const server = await startReplayServer();
const results = await runParity({ makeInProcess, server });
const limited = await runParity({
  entities: RATE_LIMIT_ENTITIES,
  makeInProcess,
  server,
  scenarios: [RATE_LIMIT_SCENARIO],
});
console.log(formatReport(results));
console.log(formatReport(limited));
const all = [...results, ...limited];
const failed = all.filter(r => !r.ok);
console.log(
  `\n${all.length - failed.length} of ${all.length} runs match; ${server.misses.length} cassette misses.`,
);
await server.close();
restore();
process.exitCode = failed.length === 0 && server.misses.length === 0 ? 0 : 1;
