/**
 * REST parity: the in-process connector against this folder, entity by
 * entity, on the recorded cassettes. Prints one table and exits 1 on any
 * difference.
 *
 *   pnpm --filter api exec tsx ../connectors/rest/fixtures/parity.mjs
 *   pnpm --filter api exec tsx ../connectors/rest/fixtures/parity.mjs --record
 *
 * `--record` rebuilds the cassettes from `dataset.mjs` through a local
 * emulator, running the in-process connector through every scenario. It
 * never calls a real API. Runs under tsx because the in-process connector
 * is API TypeScript.
 */
import path from "node:path";
import {
  CONNECTION_ID,
  ENTITIES,
  REPO_ROOT,
  SCENARIOS,
  WORKSPACE_ID,
  checkParity,
  compareForm,
  ensureFolderInstalled,
  errorParity,
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
const { RestConnector } = await import(api("connectors/rest/connector.ts"));
const { specToForm } = await import(
  api("connectors/workspace/spec-translation.ts")
);

const makeInProcess = (config, scenario = {}) =>
  liftSsrfGuard(
    new RestConnector({
      _id: CONNECTION_ID,
      name: "REST parity",
      type: "rest",
      workspaceId: WORKSPACE_ID,
      config,
      ...(scenario.settingsBatch
        ? { settings: { sync_batch_size: scenario.settingsBatch } }
        : {}),
    }),
  );

const entities = ENTITIES.map(e => e.name);

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
        const token = `rest_test_record_${scenario.name}_${entity}`;
        const config = testConfig(token, server, scenario);
        await readInProcess(() => makeInProcess(config, scenario), {
          entity,
          since: scenario.since,
          maxIterations: scenario.maxIterations,
          pageSize: scenario.pageSize,
        });
        keep(entity, token);
      }
    }
    for (const variant of ["", "_redirect_ok"]) {
      const token = `rest_test_record_check${variant}`;
      const check = await makeInProcess(
        testConfig(token, server),
      ).testConnection();
      if (!check.success)
        throw new Error(`check failed while recording: ${check.message}`);
      keep("check", token);
    }
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
  const config = { api_base_url: "https://x.test", entities: ENTITIES };
  const discover = await runFolderCommand("discover", { config });
  const streams =
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? [];
  const inEntities = makeInProcess(config).getAvailableEntities();
  const same =
    JSON.stringify(streams.map(s => s.name)) === JSON.stringify(inEntities);
  if (!same) failures++;
  console.info(
    `Entities: ${inEntities.length} in-process, ${streams.length} folder, ${same ? "same list and order" : "DIFFERENT"}`,
  );

  const inSchema = RestConnector.getConfigSchema();
  const folderForm = specToForm(spec);
  const form = compareForm(inSchema.fields, folderForm.fields);
  if (!form.ok) failures++;
  console.info(
    `Config form: ${form.ok ? "match" : `DIFF ${JSON.stringify(form)}`}`,
  );
  const encrypted = fields => fields.filter(f => f.encrypted).map(f => f.name);
  const sameSecrets =
    JSON.stringify(encrypted(inSchema.fields)) ===
    JSON.stringify(encrypted(folderForm.fields));
  if (!sameSecrets) failures++;
  console.info(
    `Encrypted fields: ${encrypted(inSchema.fields).join(", ")} in-process, ${encrypted(folderForm.fields).join(", ")} folder, ${sameSecrets ? "same" : "DIFFERENT"}`,
  );

  const server = await startReplayServer(loadCassettes());
  try {
    const checks = await checkParity({ makeInProcess, server });
    console.info("\nCheck:");
    for (const c of checks) {
      const ok =
        c.inProcess === c.folder &&
        c.requestsEqual &&
        c.inProcess === ["valid", "redirect_ok"].includes(c.variant);
      if (!ok) failures++;
      console.info(
        `  ${c.variant}: in-process ${c.inProcess}, folder ${c.folder}, ${c.requests} requests, ${c.requestsEqual ? "same" : "DIFFERENT"}`,
      );
    }
    const results = await runParity({
      entities,
      makeInProcess,
      server,
      scenarios: SCENARIOS,
    });
    failures += results.filter(r => !r.ok).length;
    console.info(
      `\nRead parity (${results.length} runs):\n${formatReport(results)}`,
    );
    const failed = await errorParity({
      makeInProcess,
      server,
      entity: "orders",
    });
    const errorOk =
      failed.requestsEqual &&
      failed.inProcessMessage !== "" &&
      failed.folderMessage.includes(failed.inProcessMessage);
    if (!errorOk) failures++;
    console.info(
      `\nHTTP 500: ${failed.requests} request(s), ${errorOk ? "same failure" : `DIFFERENT (${failed.inProcessMessage} / ${failed.folderMessage})`}`,
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
