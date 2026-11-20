/**
 * The boxed BigQuery connector folder (`connectors/bigquery/`): checks that
 * hold the folder to itself, kept after the in-process connector was removed.
 *
 * The credential test proves the folder authenticates with the connection's
 * service account only: a decoy GOOGLE_APPLICATION_CREDENTIALS in its
 * environment is never read, and the folder's source reads no environment at
 * all. The harness lives with the folder:
 * connectors/bigquery/fixtures/harness.mjs.
 *
 * Sits at the top of api/src/connectors, not in a bigquery/ folder, which the
 * connector family boundary guard would treat as a family.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxedConnector } from "./workspace/SandboxedConnector";
import type { LoadedConnector } from "./workspace/resolver";
import type { ConnectorCommand, RunResult } from "./workspace/sync-box";
import { parseConnectorFile } from "./workspace/connector-file";
import { resolveEntitySchema } from "../sync/sync-orchestrator";
import {
  CASSETTE_DIR,
  CONNECTION_ID,
  CONNECTION_QUERIES,
  FOLDER,
  WORKSPACE_ID,
  ensureFolderInstalled,
  runFolderCommand,
  serviceAccountJson,
  startReplayServer,
  testConfig,
  type BigQueryTestConfig,
  type ReplayServer,
} from "../../../connectors/bigquery/fixtures/harness.mjs";

// The harness signs against a local token server. The key validator accepts a
// loopback token_uri only under NODE_ENV=test (src/connections/google-service-account.ts).
process.env.NODE_ENV = "test";

class BoxlessBigQuery extends SandboxedConnector {
  static spec: Record<string, any> | undefined;
  /** Every config a command was given, to prove what reaches a box. */
  static configs: Array<Record<string, unknown>> = [];

  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "bigquery",
      runtime: "node",
      entry: "connector.ts",
      sha: "folder",
      sourceSha: "folder",
      spec: BoxlessBigQuery.spec,
      entities: Object.keys(BoxlessBigQuery.spec?.mako?.entities ?? {}),
      status: "indexed",
    } as LoadedConnector;
    return this.loaded;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    if (options?.config) BoxlessBigQuery.configs.push(options.config);
    const result = await runFolderCommand(command, options);
    return {
      exitCode: result.code ?? 1,
      messages: result.messages as RunResult["messages"],
      malformed: [],
      stderr: result.stderr,
      timedOut: false,
    };
  }
}

const makeBoxed = (config: BigQueryTestConfig) =>
  new BoxlessBigQuery({
    _id: CONNECTION_ID,
    name: "BigQuery folder",
    type: "ws:bigquery",
    workspaceId: WORKSPACE_ID,
    config,
  } as any);

const CONFIG = {
  project_id: "parity-project",
  service_account_json: "{}",
  queries: CONNECTION_QUERIES,
};
const ENTITIES = CONNECTION_QUERIES.map(q => q.name);

let server: ReplayServer;
let spec: Record<string, any> | undefined;

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
  BoxlessBigQuery.spec = spec;
});

after(async () => {
  await server?.close();
});

void test("connector.yaml is a node folder with its entry", () => {
  const parsed = parseConnectorFile(
    fs.readFileSync(path.join(FOLDER, "connector.yaml"), "utf8"),
  );
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  assert.equal(parsed.value.runtime, "node");
  assert.equal(parsed.value.entry, "connector.ts");
});

void test("no schema: rows land as they come", async () => {
  const box = makeBoxed(CONFIG as unknown as BigQueryTestConfig);
  await box.loadDefinition();
  for (const entity of ENTITIES) {
    assert.equal(await box.resolveSchema(entity), null, entity);
    assert.equal(
      await resolveEntitySchema({
        entity,
        workspaceId: WORKSPACE_ID,
        connector: box,
        sourceConnection: { type: "ws:bigquery" },
        context: "folder",
      }),
      null,
    );
  }
});

void test("only the connection's service account reaches Google", async () => {
  // A decoy ambient credential: a service account of another identity.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-bq-ambient-"));
  const decoy = path.join(dir, "adc.json");
  fs.writeFileSync(
    decoy,
    serviceAccountJson("ambient-decoy", server).replace(
      "parity-project.iam",
      "other-project.iam",
    ),
  );
  try {
    const run = "folder-ambient-check";
    const result = await runFolderCommand("check", {
      config: {
        ...testConfig(run, server),
        __connection_id: CONNECTION_ID,
        __workspace_id: WORKSPACE_ID,
      },
      env: {
        GOOGLE_APPLICATION_CREDENTIALS: decoy,
        GCE_METADATA_HOST: new URL(server.url).host,
        CLOUDSDK_CONFIG: dir,
      },
    });
    const status = result.messages.find(m => m.type === "CONNECTION_STATUS");
    assert.equal(status?.connectionStatus?.status, "SUCCEEDED");
    const requests = server.requests(run);
    assert.equal(requests.length, 2);
    assert.match(
      requests[0],
      /^POST \/token jwt iss=folder-ambient-check@parity-project\.iam\.gserviceaccount\.com scope=https:\/\/www\.googleapis\.com\/auth\/bigquery\.readonly /,
    );
    assert.deepEqual(server.requests("ambient-decoy"), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The folder reads no environment and no Google client library.
  for (const file of ["connector.ts", "client.ts"]) {
    const source = fs.readFileSync(path.join(FOLDER, file), "utf8");
    assert.doesNotMatch(source, /process\.env|google-auth|@google-cloud/, file);
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.join(FOLDER, "package.json"), "utf8"),
  );
  assert.equal(pkg.dependencies, undefined);
});

void test("a box gets the connection's config and its ids, nothing else", async () => {
  BoxlessBigQuery.configs = [];
  const box = makeBoxed(testConfig("folder-config-keys", server));
  await box.testConnection();
  await box.fetchEntityChunk({
    entity: "empty",
    maxIterations: 1,
    onBatch: async () => {},
  } as any);
  const keys = new Set(BoxlessBigQuery.configs.flatMap(c => Object.keys(c)));
  assert.deepEqual([...keys].sort(), [
    "__connection_id",
    "__workspace_id",
    "api_base_url",
    "project_id",
    "queries",
    "service_account_json",
  ]);
});

void test("the cassettes hold no token and no key", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /ya29\.|PRIVATE KEY|assertion=/, file);
  }
});
