/**
 * Close parity: the in-process connector against this folder, entity by
 * entity, on the recorded cassettes. Prints the tables and exits 1 on any
 * difference.
 *
 * From the repository root:
 *
 *   pnpm --filter api exec tsx ../connectors/close/fixtures/parity.mjs
 *   pnpm --filter api exec tsx ../connectors/close/fixtures/parity.mjs --record
 *
 * `--record` rebuilds the cassettes: it serves `dataset.mjs` through a local
 * Close emulator, runs the in-process connector through every scenario, its
 * schemas and `check`, and writes what it was sent and answered to
 * `cassettes/`. It never calls Close. Runs under tsx because the in-process
 * connector is API TypeScript.
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
  formatScale,
  freezeClock,
  inProcessFactory,
  inProcessPosition,
  loadCassettes,
  runFolderCommand,
  runParity,
  saveCassettes,
  startRecordingServer,
  startReplayServer,
  webhookParity,
} from "./harness.mjs";
import { buildDeliveries, buildWebhookEvents } from "./webhook-events.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = relative => path.join(here, "../../../api/src", relative);

const { CloseConnector } = await import(api("connectors/close/connector.ts"));
const { createCloseClient } = await import(api("connectors/close/client.ts"));
const { MAKO_SYSTEM_FIELDS } = await import(
  api("connectors/base/BaseConnector.ts")
);
const { jsonSchemaToEntitySchema, connectionSpecificationToForm } =
  await import(api("connectors/workspace/spec-translation.ts"));
const { resolveSourceTimestamp, normalizePayloadKeys } = await import(
  api("sync-cdc/normalization.ts")
);

const { SandboxedConnector } = await import(
  api("connectors/workspace/SandboxedConnector.ts")
);
const boxed = new SandboxedConnector({
  id: "ds_box",
  name: "Close box",
  type: "ws:close",
  config: {},
});

const makeInProcess = inProcessFactory({ CloseConnector, createCloseClient });
const entities = makeInProcess({
  api_key: "api_test_list",
}).getAvailableEntities();

/** The engine's resolver, then the connector's: in-process Close, or the box adapter. */
const sourceTs = {
  inProcess: row => [
    resolveSourceTimestamp(normalizePayloadKeys(row)).toISOString(),
    makeInProcess({ api_key: "api_test_ts" })
      .normalizeBackfillRecord("leads", row)
      ?.sourceTs.toISOString(),
  ],
  folder: row => [
    resolveSourceTimestamp(normalizePayloadKeys(row)).toISOString(),
    boxed.normalizeBackfillRecord("leads", row)?.sourceTs.toISOString(),
  ],
};

/** A Basic-auth user name cannot hold ":", and `activities:Call` does. */
const tag = entity => entity.replace(/[^a-zA-Z0-9_]/g, "-");

async function record() {
  const { ORG, buildDataset } = await import(path.join(here, "dataset.mjs"));
  const { CLOSE_MEMBERSHIP_FIELDS } = await import(
    path.join(here, "../memberships.ts")
  );
  const server = await startRecordingServer(buildDataset());
  const byFile = new Map();
  const keep = (file, apiKey) => {
    if (!byFile.has(file)) byFile.set(file, new Map());
    for (const key of server.requests(apiKey)) {
      byFile.get(file).set(key, server.recorded.get(key));
    }
  };
  try {
    for (const entity of entities) {
      for (const scenario of SCENARIOS) {
        const apiKey = `api_test_record_${scenario.name}_${tag(entity)}`;
        let state;
        do {
          state = await makeInProcess({
            api_key: apiKey,
            baseUrl: server.url,
          }).fetchEntityChunk({
            entity,
            since: scenario.since ? new Date(scenario.since) : undefined,
            maxIterations: scenario.maxIterations,
            ...(scenario.pageSize ? { batchSize: scenario.pageSize } : {}),
            rateLimitDelay: 1,
            state,
            onBatch: async () => {},
          });
          void inProcessPosition(state);
        } while (state.hasMore);
        keep(entity, apiKey);
      }
      const schemaKey = `api_test_record_schema_${tag(entity)}`;
      await makeInProcess({
        api_key: schemaKey,
        baseUrl: server.url,
      }).resolveSchema(entity);
      keep(entity, schemaKey);
    }
    const checkKey = "api_test_record_check";
    const check = await makeInProcess({
      api_key: checkKey,
      baseUrl: server.url,
    }).testConnection();
    if (!check.success) {
      throw new Error(`check failed while recording: ${check.details}`);
    }
    keep("me", checkKey);
    // What only the folder asks for (`FOLDER_ONLY`): in-process never sends
    // these, so they are recorded by hand, from the same emulator.
    const folderOnlyKey = "api_test_record_folder_only";
    const auth = `Basic ${Buffer.from(`${folderOnlyKey}:`).toString("base64")}`;
    for (const route of [
      "/me/",
      `/organization/${ORG}/?_fields=${CLOSE_MEMBERSHIP_FIELDS}`,
      "/custom_field/activity/",
      "/custom_field/custom_object_type/",
    ]) {
      const response = await fetch(`${server.url}${route}`, {
        headers: { authorization: auth },
      });
      if (!response.ok) throw new Error(`${route}: ${response.status}`);
    }
    keep("folder_only", folderOnlyKey);
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
  const restoreClock = freezeClock();
  try {
    if (process.argv.includes("--record")) await record();
    ensureFolderInstalled();
    let failures = 0;
    const server = await startReplayServer(loadCassettes());
    try {
      const discover = await runFolderCommand("discover", {
        config: { api_key: "api_test_schema", __base_url: server.url },
      });
      const streams =
        discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ??
        [];
      const spec = (await runFolderCommand("spec")).messages.find(
        m => m.type === "SPEC",
      )?.spec;
      const system = new Set(Object.keys(MAKO_SYSTEM_FIELDS));

      const folderEntities = streams.map(s => s.name);
      const sameEntities =
        JSON.stringify(folderEntities) === JSON.stringify(entities);
      if (!sameEntities) failures++;
      console.info(
        `Entities: ${entities.length} in-process, ${folderEntities.length} folder, ${sameEntities ? "same list and order" : "DIFFERENT"}`,
      );

      const form = compareForm(
        CloseConnector.getConfigSchema().fields,
        connectionSpecificationToForm(spec?.connectionSpecification).fields,
      );
      if (!form.ok) failures++;
      console.info(
        `Credential form: ${form.ok ? "match" : `DIFF ${JSON.stringify(form)}`}`,
      );

      console.info(
        "\nSchemas (vendor and custom fields; system fields excluded):",
      );
      for (const entity of entities) {
        const inProcess = await makeInProcess({
          api_key: `api_test_schema_${tag(entity)}`,
          baseUrl: server.url,
        }).resolveSchema(entity);
        const folder = jsonSchemaToEntitySchema(
          entity,
          streams.find(s => s.name === entity),
        );
        const result = compareEntitySchema(inProcess, folder, system);
        if (!result.ok) failures++;
        console.info(
          `  ${entity}: ${result.fields[0]} fields (${result.customFields} custom), ${result.ok ? "match" : `DIFF missing=${result.missing} extra=${result.extra} ${result.fieldDiffs.join("; ")}`}`,
        );
      }

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

      const results = await runParity({
        entities,
        makeInProcess,
        server,
        sourceTs,
      });
      const limited = await runParity({
        entities: RATE_LIMIT_ENTITIES,
        makeInProcess,
        server,
        sourceTs,
        scenarios: [RATE_LIMIT_SCENARIO],
      });
      const all = [...results, ...limited];
      failures += all.filter(r => !r.ok).length;
      console.info(
        `\nRead parity (${all.length} runs):\n${formatReport(results)}`,
      );
      console.info(
        `\nRate-limited (every request 429 once):\n${formatReport(limited)}`,
      );
      const fallbacks = results
        .filter(r => r.scenario === "default" && r.timestampFallbacks > 0)
        .map(r => `${r.entity} ${r.timestampFallbacks}`);
      console.info(
        `\nRows with no source time (both sides fall back to sync time): ${fallbacks.join(", ") || "none"}`,
      );
      console.info(
        `\nScale, default scenario (folder protocol output):\n${formatScale(results)}`,
      );
      console.info(
        `\nScale, chunked scenario:\n${formatScale(results, "chunked")}`,
      );

      const events = buildWebhookEvents(
        makeInProcess({ api_key: "api_test_list" }).getSupportedWebhookEvents(),
      );
      const webhooks = await webhookParity({
        connector: makeInProcess({ api_key: "api_test_list" }),
        events,
        deliveries: buildDeliveries(events[0].rawPayload),
      });
      if (!webhooks.ok) failures++;
      console.info(
        `\nWebhooks: ${webhooks.eventCount} subscribed events ${webhooks.eventsSame ? "same" : "DIFFERENT"}; ` +
          `${webhooks.outcomes.filter(o => o.same).length}/${webhooks.outcomes.length} events give the same outcome and records; ` +
          `${webhooks.verify.filter(v => v.same).length}/${webhooks.verify.length} signature checks agree`,
      );
      for (const o of webhooks.outcomes.filter(x => !x.same)) {
        console.info(`  DIFF ${o.eventType} (${o.eventId})`);
      }

      if (server.misses.length) {
        failures++;
        console.info(
          `\nCassette misses (${server.misses.length}):\n  ${[...new Set(server.misses)].map(m => m.slice(0, 200)).join("\n  ")}`,
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
  } finally {
    restoreClock();
  }
}

await main();
