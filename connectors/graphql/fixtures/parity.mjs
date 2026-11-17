/**
 * GraphQL parity: the in-process connector against this folder, query by
 * query, on the recorded cassettes. Prints one table and exits 1 on any
 * difference.
 *
 *   pnpm --filter api exec tsx ../connectors/graphql/fixtures/parity.mjs
 *   pnpm --filter api exec tsx ../connectors/graphql/fixtures/parity.mjs --record
 *
 * `--record` rebuilds the cassettes from `dataset.mjs` through a local
 * emulator, running the in-process connector through every scenario. It
 * never calls a real API. Runs under tsx because the in-process connector
 * is API TypeScript.
 */
import path from "node:path";
import {
  CONNECTION_ID,
  FLOW_QUERIES,
  RATE_LIMIT_SCENARIO,
  REPO_ROOT,
  SCENARIOS,
  WORKSPACE_ID,
  checkParity,
  compareForm,
  ensureFolderInstalled,
  formatReport,
  liftSsrfGuard,
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
const { GraphQLConnector } = await import(
  api("connectors/graphql/connector.ts")
);
const { specToForm } = await import(
  api("connectors/workspace/spec-translation.ts")
);

const makeInProcess = config =>
  liftSsrfGuard(
    new GraphQLConnector({
      _id: CONNECTION_ID,
      name: "GraphQL parity",
      type: "graphql",
      workspaceId: WORKSPACE_ID,
      config,
    }),
  );

const entities = FLOW_QUERIES.map(q => q.name);

async function record() {
  const server = await startRecordingServer();
  const byFile = new Map();
  const keep = (file, token) => {
    if (!byFile.has(file)) byFile.set(file, new Map());
    for (const key of server.requestKeys(token))
      byFile.get(file).set(key, server.recorded.get(key));
  };
  try {
    for (const entity of entities) {
      for (const scenario of SCENARIOS) {
        const token = `gql_test_record_${scenario.name}_${entity}`;
        const config = testConfig(token, server, scenario);
        await readInProcess(() => makeInProcess(config), {
          entity,
          since: scenario.since,
          maxIterations: scenario.maxIterations,
          pageSize: scenario.pageSize,
        });
        keep(entity, token);
      }
    }
    const checkToken = "gql_test_record_check";
    const { queries: _q, ...connection } = testConfig(checkToken, server);
    const check = await makeInProcess(connection).testConnection();
    if (!check.success)
      throw new Error(`check failed while recording: ${check.message}`);
    keep("check", checkToken);
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

  const spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  const discover = await runFolderCommand("discover", {
    config: { endpoint: "https://x.test/graphql", queries: FLOW_QUERIES },
  });
  const streams =
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? [];
  const inEntities = makeInProcess({
    endpoint: "https://x.test/graphql",
    queries: FLOW_QUERIES,
  }).getAvailableEntities();
  const same =
    JSON.stringify(streams.map(s => s.name)) === JSON.stringify(inEntities);
  if (!same) failures++;
  console.info(
    `Entities: ${inEntities.length} in-process, ${streams.length} folder, ${same ? "same list and order" : "DIFFERENT"}`,
  );

  const inSchema = GraphQLConnector.getConfigSchema();
  const folderForm = specToForm(spec);
  const form = compareForm(inSchema.fields, folderForm.fields);
  const queriesForm = compareForm(
    inSchema.transferQueries.fields,
    folderForm.transferQueries?.fields,
  );
  const queriesMeta =
    folderForm.transferQueries?.label === inSchema.transferQueries.label &&
    folderForm.transferQueries?.required === inSchema.transferQueries.required;
  if (!form.ok || !queriesForm.ok || !queriesMeta) failures++;
  console.info(
    `Credential form: ${form.ok ? "match" : `DIFF ${JSON.stringify(form)}`}`,
  );
  console.info(
    `Flow query form: ${queriesForm.ok && queriesMeta ? "match" : `DIFF ${JSON.stringify(queriesForm)}`}`,
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
