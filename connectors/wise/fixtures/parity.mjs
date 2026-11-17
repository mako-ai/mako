/**
 * Wise parity: the in-process connector against this folder, entity by
 * entity, on the recorded cassettes. Prints the tables and exits 1 on any
 * difference.
 *
 * From the repository root:
 *
 *   TZ=UTC pnpm --filter api exec tsx ../connectors/wise/fixtures/parity.mjs
 *   TZ=UTC pnpm --filter api exec tsx ../connectors/wise/fixtures/parity.mjs --record
 *
 * `--record` rebuilds the cassettes: it serves `dataset.mjs` through a local
 * Wise emulator, runs the in-process connector through every scenario and
 * `check`, and writes what it was sent and answered to `cassettes/`. It
 * never calls Wise. Runs under tsx because the in-process connector is API
 * TypeScript. The folder runs through the SDK runner directly here; the API
 * test (`api/src/connectors/wise/folder-parity.test.ts`) runs it through
 * `SandboxedConnector`, the box path.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RATE_LIMIT_ENTITIES,
  RATE_LIMIT_SCENARIO,
  SCENARIOS,
  checkParity,
  compareEntitySchema,
  compareForm,
  ensureFolderInstalled,
  formatReport,
  freezeClock,
  inProcessFactory,
  loadCassettes,
  runFolderCommand,
  runParity,
  saveCassettes,
  startRecordingServer,
  startReplayServer,
  testConfig,
  webhookParity,
} from "./harness.mjs";
import {
  TEST_WEBHOOK_KEYS,
  buildDeliveries,
  buildWebhookEvents,
} from "./webhook-events.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = relative => path.join(here, "../../../api/src", relative);

const { WiseConnector } = await import(api("connectors/wise/connector.ts"));
const { verifyWiseWebhook } = await import(api("connectors/wise/webhooks.ts"));
const { MAKO_SYSTEM_FIELDS } = await import(
  api("connectors/base/BaseConnector.ts")
);
const { jsonSchemaToEntitySchema, connectionSpecificationToForm } =
  await import(api("connectors/workspace/spec-translation.ts"));

const makeInProcess = inProcessFactory({ WiseConnector });
const entities = makeInProcess({
  api_key: "wise_test_list",
}).getAvailableEntities();

async function record() {
  const { buildDataset } = await import(path.join(here, "dataset.mjs"));
  const server = await startRecordingServer(buildDataset());
  const byFile = new Map();
  const keep = (file, token) => {
    if (!byFile.has(file)) byFile.set(file, new Map());
    for (const key of server.requests(token)) {
      if (server.recorded.has(key)) {
        byFile.get(file).set(key, server.recorded.get(key));
      }
    }
  };
  try {
    for (const entity of entities) {
      for (const scenario of SCENARIOS) {
        const token = `wise_test_record_${scenario.name}_${entity}`;
        let state;
        do {
          state = await makeInProcess(
            testConfig(token, server),
          ).fetchEntityChunk({
            entity,
            since: scenario.since ? new Date(scenario.since) : undefined,
            maxIterations: scenario.maxIterations,
            ...(scenario.pageSize ? { batchSize: scenario.pageSize } : {}),
            rateLimitDelay: 1,
            state,
            onBatch: async () => {},
          });
        } while (state.hasMore);
        keep(entity, token);
      }
    }
    const checkToken = "wise_test_record_check";
    const check = await makeInProcess(
      testConfig(checkToken, server),
    ).testConnection();
    if (!check.success) {
      throw new Error(`check failed while recording: ${check.details}`);
    }
    keep("me", checkToken);
  } finally {
    await server.close();
  }
  saveCassettes(byFile);
  const total = [...byFile.values()].reduce((sum, map) => sum + map.size, 0);
  console.info(`Recorded ${total} interactions in ${byFile.size} files.`);
}

async function main() {
  const restoreClock = freezeClock();
  try {
    if (process.argv.includes("--record")) await record();
    ensureFolderInstalled();

    const discover = await runFolderCommand("discover", {
      config: { api_key: "wise_test_schema" },
    });
    const streams =
      discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? [];
    const spec = (await runFolderCommand("spec")).messages.find(
      m => m.type === "SPEC",
    )?.spec;
    const system = new Set(Object.keys(MAKO_SYSTEM_FIELDS));
    let failures = 0;

    const folderEntities = streams.map(s => s.name);
    const sameEntities =
      JSON.stringify(folderEntities) === JSON.stringify(entities);
    if (!sameEntities) failures++;
    console.info(
      `Entities: ${entities.length} in-process, ${folderEntities.length} folder, ${sameEntities ? "same list and order" : "DIFFERENT"}`,
    );

    const form = compareForm(
      WiseConnector.getConfigSchema().fields,
      connectionSpecificationToForm(spec?.connectionSpecification).fields,
    );
    if (!form.ok) failures++;
    console.info(
      `Credential form: ${form.ok ? "match (sca_private_key: password, not textarea)" : `DIFF ${JSON.stringify(form)}`}`,
    );

    console.info("\nSchemas (vendor fields; system fields excluded):");
    for (const entity of entities) {
      const inProcess = await makeInProcess({
        api_key: "wise_test_list",
      }).resolveSchema(entity);
      const result = compareEntitySchema(
        inProcess,
        jsonSchemaToEntitySchema(
          entity,
          streams.find(s => s.name === entity),
        ),
        system,
      );
      if (!result.ok) failures++;
      console.info(
        `  ${entity}: ${result.fields[0]} fields, ${result.ok ? "match" : `DIFF ${JSON.stringify(result)}`}`,
      );
    }

    const server = await startReplayServer(loadCassettes());
    try {
      const checks = await checkParity({ makeInProcess, server });
      console.info("\nCheck:");
      for (const c of checks) {
        const ok =
          c.inProcess === c.folder &&
          c.requestsEqual &&
          c.inProcess === (c.variant === "valid");
        if (!ok) failures++;
        console.info(
          `  ${c.variant} token: in-process ${c.inProcess}, folder ${c.folder}, requests ${c.requestsEqual ? "same" : "DIFFERENT"}`,
        );
      }

      const results = await runParity({ entities, makeInProcess, server });
      const limited = await runParity({
        entities: RATE_LIMIT_ENTITIES,
        makeInProcess,
        server,
        scenarios: [RATE_LIMIT_SCENARIO],
      });
      const all = [...results, ...limited];
      failures += all.filter(r => !r.ok).length;
      console.info(
        `\nRead parity (${all.length} runs):\n${formatReport(results)}\n\n${formatReport(limited)}`,
      );
      if (server.misses.length) {
        failures++;
        console.info(
          `\nCassette misses (${server.misses.length}):\n  ${[...new Set(server.misses)].join("\n  ")}`,
        );
      }
    } finally {
      await server.close();
    }

    const connector = makeInProcess({ api_key: "wise_test_list" });
    const webhooks = await webhookParity({
      connector,
      events: buildWebhookEvents(),
      deliveries: buildDeliveries(),
      publicKeys: [TEST_WEBHOOK_KEYS.publicKey],
      inProcessVerify: delivery =>
        verifyWiseWebhook(delivery, () => [TEST_WEBHOOK_KEYS.publicKey]),
    });
    if (!webhooks.ok) failures++;
    console.info(
      `\nWebhooks: ${webhooks.eventCount} events ${webhooks.eventsSame ? "same" : "DIFFERENT"}; ` +
        `${webhooks.outcomes.filter(o => o.same).length}/${webhooks.outcomes.length} events map the same; ` +
        `${webhooks.verify.filter(v => v.same).length}/${webhooks.verify.length} signature cases agree`,
    );

    console.info(
      failures === 0
        ? "\nParity: every check matches."
        : `\nParity: ${failures} difference(s).`,
    );
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    restoreClock();
  }
}

await main();
