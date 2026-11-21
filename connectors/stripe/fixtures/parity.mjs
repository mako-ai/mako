/**
 * Stripe parity: the in-process connector against this folder, entity by
 * entity, on the recorded cassettes. Prints one table and exits 1 on any
 * difference.
 *
 * From the repository root:
 *
 *   pnpm --filter api exec tsx ../connectors/stripe/fixtures/parity.mjs
 *   pnpm --filter api exec tsx ../connectors/stripe/fixtures/parity.mjs --record
 *
 * `--record` rebuilds the cassettes: it serves `dataset.mjs` through a local
 * Stripe emulator, runs the in-process connector through every scenario, and
 * writes what it was sent and answered to `cassettes/`. It never calls
 * Stripe. Runs under tsx because the in-process connector is API TypeScript.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPO_ROOT,
  SCENARIOS,
  checkParity,
  compareEntitySchema,
  compareForm,
  ensureFolderInstalled,
  formatReport,
  loadCassettes,
  runFolderCommand,
  runParity,
  saveCassettes,
  startRecordingServer,
  startReplayServer,
} from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = relative => path.join(REPO_ROOT, "api/src", relative);

const { StripeConnector } = await import(api("connectors/stripe/connector.ts"));
const { MAKO_SYSTEM_FIELDS } = await import(
  api("connectors/base/BaseConnector.ts")
);
const { jsonSchemaToEntitySchema, connectionSpecificationToForm } =
  await import(api("connectors/workspace/spec-translation.ts"));

const makeInProcess = config =>
  new StripeConnector({
    id: "ds_parity",
    name: "Stripe parity",
    type: "stripe",
    config,
  });

const entities = makeInProcess({
  api_key: "sk_test_list",
}).getAvailableEntities();

async function record() {
  const { buildDataset } = await import(path.join(here, "dataset.mjs"));
  const server = await startRecordingServer(buildDataset());
  const byFile = new Map();
  const keep = (file, apiKey) => {
    if (!byFile.has(file)) byFile.set(file, new Map());
    for (const key of server.requestKeys(apiKey)) {
      byFile.get(file).set(key, server.recorded.get(key));
    }
  };
  try {
    for (const entity of entities) {
      for (const scenario of SCENARIOS) {
        const apiKey = `sk_test_record_${scenario.name}_${entity}`;
        const connector = makeInProcess({
          api_key: apiKey,
          api_base_url: server.url,
        });
        let state;
        do {
          state = await connector.fetchEntityChunk({
            entity,
            since: scenario.since ? new Date(scenario.since) : undefined,
            maxIterations: scenario.maxIterations,
            ...(scenario.pageSize ? { batchSize: scenario.pageSize } : {}),
            rateLimitDelay: 1,
            state,
            onBatch: async () => {},
          });
        } while (state.hasMore);
        keep(entity, apiKey);
      }
    }
    const checkKey = "sk_test_record_check";
    const check = await makeInProcess({
      api_key: checkKey,
      api_base_url: server.url,
    }).testConnection();
    if (!check.success)
      throw new Error(
        `check failed while recording: ${check.details ?? check.message}`,
      );
    keep("account", checkKey);
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

  // Schemas and the form: no server needed.
  const discover = await runFolderCommand("discover", {
    config: { api_key: "sk_test_schema" },
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
    folderEntities.filter(name => name === "checkout_sessions_line_items")
      .length === 1 &&
    JSON.stringify(
      folderEntities.filter(name => name !== "checkout_sessions_line_items"),
    ) === JSON.stringify(entities);
  if (!sameEntities) failures++;
  console.info(
    `Entities: ${entities.length} in-process, ${folderEntities.length} folder, ${sameEntities ? "shared entities match in order" : "DIFFERENT"}`,
  );

  const form = compareForm(
    StripeConnector.getConfigSchema().fields,
    connectionSpecificationToForm(spec?.connectionSpecification).fields,
  );
  if (!form.ok) failures++;
  console.info(
    `Credential form: ${form.ok ? "match" : `DIFF ${JSON.stringify(form)}`}`,
  );

  const labels = makeInProcess({ api_key: "sk_test_list" }).getEntityMetadata();
  const labelDiffs = labels
    .filter(m => spec?.mako?.entities?.[m.name]?.label !== m.label)
    .map(m => m.name);
  if (labelDiffs.length) failures++;
  console.info(
    `Entity labels: ${labelDiffs.length === 0 ? "match" : `DIFF ${labelDiffs.join(", ")}`}`,
  );

  console.info("\nSchemas (vendor fields; system fields excluded):");
  for (const entity of entities) {
    const inProcess = await makeInProcess({
      api_key: "sk_test_list",
    }).resolveSchema(entity);
    const folder = jsonSchemaToEntitySchema(
      entity,
      streams.find(s => s.name === entity),
    );
    const result = compareEntitySchema(inProcess, folder, system);
    if (!result.ok) failures++;
    const detail = result.ok
      ? "match"
      : `DIFF missing=${result.missing} extra=${result.extra} ${result.fieldDiffs.join("; ")}`;
    console.info(`  ${entity}: ${result.fields[0]} fields, ${detail}`);
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
        `  ${c.variant} key: in-process ${c.inProcess}, folder ${c.folder}, requests ${c.requestsEqual ? "same" : "DIFFERENT"}`,
      );
    }

    const results = await runParity({ entities, makeInProcess, server });
    failures += results.filter(r => !r.ok).length;
    console.info(
      `\nRead parity (${results.length} runs):\n${formatReport(results)}`,
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

  console.info(
    failures === 0
      ? "\nParity: every check matches."
      : `\nParity: ${failures} difference(s).`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

await main();
