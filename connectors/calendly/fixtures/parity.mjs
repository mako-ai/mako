/**
 * Calendly parity: the in-process connector against this folder, entity by
 * entity, on the recorded cassettes. Prints the tables and exits 1 on any
 * difference.
 *
 * From the repository root:
 *
 *   pnpm --filter api exec tsx ../connectors/calendly/fixtures/parity.mjs
 *   pnpm --filter api exec tsx ../connectors/calendly/fixtures/parity.mjs --record
 *
 * `--record` rebuilds the cassettes: it serves `dataset.mjs` through a local
 * Calendly emulator, runs the in-process connector through every scenario
 * and `check`, and writes what it was sent and answered to `cassettes/`. It
 * never calls Calendly. Runs under tsx because the in-process connector is
 * API TypeScript.
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
  inProcessFactory,
  loadCassettes,
  readInProcess,
  runFolderCommand,
  runParity,
  saveCassettes,
  startRecordingServer,
  startReplayServer,
  webhookParity,
} from "./harness.mjs";
import { buildWebhookEvents } from "./webhook-events.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = relative => path.join(here, "../../../api/src", relative);

const { CalendlyConnector } = await import(
  api("connectors/calendly/connector.ts")
);
const { MAKO_SYSTEM_FIELDS } = await import(
  api("connectors/base/BaseConnector.ts")
);
const { jsonSchemaToEntitySchema, connectionSpecificationToForm } =
  await import(api("connectors/workspace/spec-translation.ts"));

const makeInProcess = inProcessFactory({ CalendlyConnector });
const entities = makeInProcess({
  access_token: "cal_test_list",
}).getAvailableEntities();

async function record() {
  const { buildDataset } = await import(path.join(here, "dataset.mjs"));
  const server = await startRecordingServer(buildDataset());
  const byFile = new Map();
  const keep = (file, token) => {
    if (!byFile.has(file)) byFile.set(file, new Map());
    for (const key of server.requests(token)) {
      byFile.get(file).set(key, server.recorded.get(key));
    }
  };
  try {
    for (const scenario of [...SCENARIOS, RATE_LIMIT_SCENARIO]) {
      for (const entity of entities) {
        if (scenario.rateLimited && !RATE_LIMIT_ENTITIES.includes(entity)) {
          continue;
        }
        const token = `cal_test_record_${scenario.name}_${entity}`;
        await readInProcess(
          () =>
            makeInProcess({ access_token: token, api_base_url: server.url }),
          {
            entity,
            since: scenario.since,
            maxIterations: scenario.maxIterations,
            pageSize: scenario.pageSize,
          },
        );
        keep(entity, token);
      }
    }
    const checkToken = "cal_test_record_check";
    const check = await makeInProcess({
      access_token: checkToken,
      api_base_url: server.url,
    }).testConnection();
    if (!check.success) {
      throw new Error(`check failed while recording: ${check.details}`);
    }
    keep("users_me", checkToken);
  } finally {
    await server.close();
  }
  saveCassettes(byFile);
  const total = [...byFile.values()].reduce((sum, map) => sum + map.size, 0);
  console.info(
    `Recorded ${total} interactions in ${byFile.size} cassette files.`,
  );
}

async function main() {
  if (process.argv.includes("--record")) await record();
  ensureFolderInstalled();

  const discover = await runFolderCommand("discover", {
    config: { access_token: "cal_test_schema" },
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
    CalendlyConnector.getConfigSchema().fields,
    connectionSpecificationToForm(spec?.connectionSpecification).fields,
  );
  if (!form.ok) failures++;
  console.info(
    `Credential form: ${form.ok ? "match" : `DIFF ${JSON.stringify(form)}`}`,
  );

  console.info("\nSchemas (vendor fields; system fields excluded):");
  for (const entity of entities) {
    const inProcess = await makeInProcess({
      access_token: "cal_test_list",
    }).resolveSchema(entity);
    const folder = jsonSchemaToEntitySchema(
      entity,
      streams.find(s => s.name === entity),
    );
    const result = compareEntitySchema(inProcess, folder, system);
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
      `\nRead parity (${all.length} runs):\n${formatReport(results)}\n${formatReport(limited)}`,
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

  const webhooks = await webhookParity({
    connector: makeInProcess({ access_token: "cal_test_list" }),
    events: buildWebhookEvents(),
  });
  if (!webhooks.ok) failures++;
  console.info(
    `\nWebhooks: ${webhooks.eventCount} events ${webhooks.eventsSame ? "same" : "DIFFERENT"}; ` +
      `${webhooks.outcomes.filter(o => o.same).length}/${webhooks.outcomes.length} outcomes same; ` +
      `${webhooks.perEntity.filter(p => p.same).length}/${webhooks.perEntity.length} entity selections same`,
  );

  console.info(
    failures === 0
      ? "\nParity: every check matches."
      : `\nParity: ${failures} difference(s).`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
