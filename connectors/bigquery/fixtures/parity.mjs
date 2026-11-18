/**
 * BigQuery parity: the in-process connector against this folder, query by
 * query, on the recorded cassettes. Prints one table and exits 1 on any
 * difference.
 *
 *   pnpm --filter api exec tsx ../connectors/bigquery/fixtures/parity.mjs
 *   pnpm --filter api exec tsx ../connectors/bigquery/fixtures/parity.mjs --record
 *
 * `--record` rebuilds the cassettes from `dataset.mjs` through a local
 * BigQuery emulator, running the in-process connector through every
 * scenario. It never calls Google. Runs under tsx because the in-process
 * connector is API TypeScript.
 */
import path from "node:path";
import {
  CONNECTION_ID,
  CONNECTION_QUERIES,
  RATE_LIMIT_SCENARIO,
  REPO_ROOT,
  SCENARIOS,
  WORKSPACE_ID,
  checkParity,
  compareForm,
  ensureFolderInstalled,
  formatReport,
  loadCassettes,
  readInProcess,
  runFolderCommand,
  runParity,
  saveCassettes,
  startRecordingServer,
  startReplayServer,
  testConfig,
} from "./harness.mjs";

const api = relative => path.join(REPO_ROOT, "api/src", relative);
const { BigQueryConnector } = await import(
  api("connectors/bigquery/connector.ts")
);
const { specToForm } = await import(
  api("connectors/workspace/spec-translation.ts")
);

const makeInProcess = config =>
  new BigQueryConnector({
    _id: CONNECTION_ID,
    name: "BigQuery parity",
    type: "bigquery",
    workspaceId: WORKSPACE_ID,
    config,
  });

const entities = CONNECTION_QUERIES.map(q => q.name);

/**
 * The one known form difference: in-process declares `use_legacy_sql` as a
 * `checkbox`, a type the app's form does not render (it falls back to a text
 * input). The folder's is `boolean`, which renders as a checkbox.
 */
export const EXPECTED_FORM_DIFFS = [
  'queries.use_legacy_sql.type: "checkbox" vs "boolean"',
];

async function record() {
  const server = await startRecordingServer();
  const byFile = new Map();
  const keep = (file, run) => {
    if (!byFile.has(file)) byFile.set(file, new Map());
    for (const key of server.requestKeys(run))
      byFile.get(file).set(key, server.recorded.get(key));
  };
  try {
    for (const entity of entities) {
      for (const scenario of SCENARIOS) {
        const run = `record-${scenario.name}-${entity}`.replace(/_/g, "-");
        const config = testConfig(run, server, scenario);
        await readInProcess(() => makeInProcess(config), {
          entity,
          since: scenario.since,
          maxIterations: scenario.maxIterations,
          pageSize: scenario.pageSize,
        });
        keep(entity, run);
      }
    }
    const check = await makeInProcess(
      testConfig("record-check", server),
    ).testConnection();
    if (!check.success)
      throw new Error(
        `check failed while recording: ${check.details ?? check.message}`,
      );
    keep("check", "record-check");
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
  let failures = 0;

  const config = { project_id: "p", queries: CONNECTION_QUERIES };
  const spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  const streams =
    (await runFolderCommand("discover", { config })).messages.find(
      m => m.type === "CATALOG",
    )?.catalog?.streams ?? [];
  const inEntities = makeInProcess(config).getAvailableEntities();
  const same =
    JSON.stringify(streams.map(s => s.name)) === JSON.stringify(inEntities);
  if (!same) failures++;
  console.info(
    `Entities: ${inEntities.length} in-process, ${streams.length} folder, ${same ? "same list and order" : "DIFFERENT"}`,
  );

  const form = compareForm(
    BigQueryConnector.getConfigSchema().fields,
    specToForm(spec).fields,
  );
  const formOk =
    JSON.stringify(form.diffs) === JSON.stringify(EXPECTED_FORM_DIFFS);
  if (!formOk) failures++;
  console.info(
    `Credential form: ${formOk ? `match but ${form.diffs.length} known difference` : `DIFF ${form.diffs.join("; ")}`}`,
  );

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
        `  ${c.variant}: in-process ${c.inProcess}, folder ${c.folder}, ${c.requests} requests, ${c.requestsEqual ? "same" : "DIFFERENT"}`,
      );
    }
    const results = await runParity({
      entities,
      makeInProcess,
      server,
      scenarios: [...SCENARIOS, RATE_LIMIT_SCENARIO],
    });
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
