/**
 * The boxed PostHog connector folder (`connectors/posthog/`): checks that
 * hold the folder to itself, kept after the in-process connector was removed.
 *
 * - the folder is a node connector with 5 entities, 6 golden files each;
 * - every entity reads the replay cassettes into its golden rows, byte for
 *   byte, in 3 scenarios: the default read, an incremental read (`since`)
 *   and one request per chunk (rewrite them, after an intended change, with
 *   `node connectors/posthog/fixtures/golden.mjs --write`);
 * - the credential form, the 8 system columns, the table layout and the
 *   incremental mode of every entity;
 * - `check` accepts a valid key and a key without survey scope, and refuses
 *   a revoked one, with the requests each sends;
 * - a project API key travels in `POSTHOG-API-TOKEN`;
 * - a read session (`SandboxedConnector` with the box swapped for a local
 *   process) reads the golden rows and closes every session;
 * - the cassettes hold no key.
 *
 * The folder declares no webhooks, so there is no verification test here.
 * The harness lives with the folder: connectors/posthog/fixtures/harness.mjs.
 * Sits at the top of api/src/connectors, not in a posthog/ folder, which the
 * connector family boundary guard would treat as a family.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MAKO_SYSTEM_FIELDS } from "./base/BaseConnector";
import { SandboxedConnector } from "./workspace/SandboxedConnector";
import type { LoadedConnector } from "./workspace/resolver";
import type { ConnectorCommand, RunResult } from "./workspace/sync-box";
import { parseConnectorFile } from "./workspace/connector-file";
import {
  connectionSpecificationToForm,
  jsonSchemaToEntitySchema,
} from "./workspace/spec-translation";
import { LocalSessionTransport } from "./workspace/test-support/local-session";
import {
  CASSETTE_DIR,
  CHECK_VARIANTS,
  FOLDER,
  NO_SURVEYS_PROJECT_ID,
  RUNNER,
  SINCE,
  canonicalJson,
  ensureFolderInstalled,
  readFolder,
  runFolderCommand,
  startReplayServer,
  testConfig,
  type PosthogTestConfig,
  type ReplayServer,
} from "../../../connectors/posthog/fixtures/harness.mjs";

/** golden.mjs has a top-level await, so it loads at run time. */
const loadGolden = () =>
  import("../../../connectors/posthog/fixtures/golden.mjs");

const ENTITIES = [
  "surveys",
  "survey_responses",
  "feature_flags",
  "experiments",
  "annotations",
];

let server: ReplayServer;
let streams: Array<Record<string, any>> = [];
let spec: Record<string, any> | undefined;

/**
 * The PostHog folder as a workspace connector, with the box swapped for a
 * local process running the same SDK runner on the same files. Everything
 * else is `SandboxedConnector` as production runs it.
 */
class BoxlessPosthog extends SandboxedConnector {
  protected async definition(): Promise<LoadedConnector> {
    this.loaded ??= {
      slug: "posthog",
      runtime: "node",
      entry: "connector.ts",
      sha: "test",
      sourceSha: "test",
      spec,
      entities: Object.keys(spec?.mako?.entities ?? {}),
      status: "indexed",
    } as LoadedConnector;
    return this.loaded;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
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

/**
 * The same folder through a read session (CONNECTOR_SESSION_READS): one
 * runner process per entity read. Any `read` that reaches a chunk process
 * is counted: there must be none.
 */
class SessionPosthog extends BoxlessPosthog {
  static transports: LocalSessionTransport[] = [];
  static chunkReads = 0;
  private transport: LocalSessionTransport | null = null;

  protected async sessionTransport() {
    if (!this.transport) {
      this.transport = new LocalSessionTransport({
        runner: RUNNER,
        connector: path.join(FOLDER, "connector.ts"),
        cwd: FOLDER,
      });
      SessionPosthog.transports.push(this.transport);
    }
    return this.transport;
  }

  protected async run(
    command: ConnectorCommand,
    options: Parameters<SandboxedConnector["run"]>[1],
  ): Promise<RunResult> {
    if (command === "read") SessionPosthog.chunkReads++;
    return super.run(command, options);
  }
}

const makeBoxed = (
  config: PosthogTestConfig,
  Connector: typeof BoxlessPosthog = BoxlessPosthog,
) =>
  new Connector({
    id: "ds_test",
    name: "PostHog test",
    type: "ws:posthog",
    workspaceId: "ws_test",
    config,
  } as any);

const LIST_CONFIG = {
  api_key: "phx_test_list",
  api_base_url: "",
  project_id: "41234",
};

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  const discover = await runFolderCommand("discover", {
    config: { api_key: "phx_test_schema", project_id: "41234" },
  });
  streams =
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? [];
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
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

void test("5 entities, each with a label and 6 golden files", async () => {
  const { GOLDEN_DIR, GOLDEN_SCENARIOS, goldenFile } = await loadGolden();
  assert.deepEqual(
    streams.map(s => s.name),
    ENTITIES,
  );
  for (const name of ENTITIES) {
    assert.ok(spec?.mako?.entities?.[name]?.label, `${name} has a label`);
  }
  assert.deepEqual(
    fs.readdirSync(GOLDEN_DIR).sort(),
    ENTITIES.flatMap(e => GOLDEN_SCENARIOS.map(s => goldenFile(e, s))).sort(),
  );
});

void test("the credential form asks for a secret key, a project and an address", () => {
  const fields = connectionSpecificationToForm(
    spec?.connectionSpecification,
  ).fields;
  assert.deepEqual(
    fields.map(f => f.name),
    ["api_base_url", "project_id", "api_key", "auth_type"],
  );
  const apiKey = fields.find(f => f.name === "api_key");
  assert.equal(apiKey?.encrypted, true);
  assert.equal(apiKey?.required, true);
  assert.equal(fields.find(f => f.name === "project_id")?.required, true);
  // Only the key is a secret.
  assert.deepEqual(
    fields.filter(f => f.encrypted).map(f => f.name),
    ["api_key"],
  );
});

void test("every entity has the 8 system columns and a key", async () => {
  const system = Object.keys(MAKO_SYSTEM_FIELDS);
  assert.equal(system.length, 8);
  const boxed = makeBoxed({ ...LIST_CONFIG, api_key: "phx_test_schema" });
  for (const entity of ENTITIES) {
    const translated = jsonSchemaToEntitySchema(
      entity,
      streams.find(s => s.name === entity),
    );
    const viaBox = await boxed.resolveSchema(entity);
    assert.ok(translated && viaBox, entity);
    for (const schema of [translated, viaBox]) {
      assert.deepEqual(schema.keyColumns, ["id"], entity);
      for (const name of system) {
        assert.ok(schema.fields[name], `${entity} has ${name}`);
      }
      assert.ok(schema.fields.id, `${entity} has id`);
    }
    assert.equal(
      canonicalJson(translated),
      canonicalJson(viaBox),
      `${entity}: the schema through the box is the translated one`,
    );
  }
});

void test("every entity is upserted in place, with its incremental mode", async () => {
  const boxed = makeBoxed(LIST_CONFIG);
  await boxed.loadDefinition();
  const layouts = Object.fromEntries(
    boxed.getEntityMetadata().map(e => [e.name, e.layoutSuggestion ?? null]),
  );
  assert.deepEqual(Object.keys(layouts), ENTITIES);
  for (const entity of ENTITIES) {
    assert.ok(layouts[entity], `${entity} has a layout`);
  }
  const caps = boxed.getIncrementalCapabilities();
  assert.equal(caps.supported, true);
  const mode = (entity: string) => caps.perEntity?.[entity]?.mode ?? caps.mode;
  assert.equal(mode("survey_responses"), "native");
  for (const entity of [
    "surveys",
    "feature_flags",
    "experiments",
    "annotations",
  ]) {
    assert.equal(mode(entity), "created-anchor", entity);
  }
});

void test("check accepts a valid key and a key without survey scope, and refuses a revoked one", async () => {
  const outcomes = [];
  for (const variant of CHECK_VARIANTS) {
    const suffix = variant === "valid" ? "" : `_${variant}`;
    const apiKey = `phx_test_folder_check${suffix}`;
    const project =
      variant === "nosurveys" ? { projectId: NO_SURVEYS_PROJECT_ID } : {};
    const run = await runFolderCommand("check", {
      config: testConfig(apiKey, server, project),
    });
    const status = run.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    outcomes.push([
      variant,
      status?.status === "SUCCEEDED",
      server.requests(apiKey).length,
    ]);
  }
  assert.deepEqual(outcomes, [
    // One survey, and nothing else.
    ["valid", true, 1],
    // A 403 on surveys, then the HogQL probe.
    ["nosurveys", true, 2],
    // A 401 on surveys, then a 401 on the probe.
    ["revoked", false, 2],
  ]);
});

void test("every entity reads the cassettes into its golden rows, byte for byte, in 6 scenarios", async () => {
  const { GOLDEN_DIR, buildGolden } = await loadGolden();
  const actual = await buildGolden();
  assert.equal(Object.keys(actual).length, ENTITIES.length * 6);
  for (const [file, text] of Object.entries(actual)) {
    const expected = fs.readFileSync(path.join(GOLDEN_DIR, file), "utf8");
    assert.equal(text, expected, `${file} differs from fixtures/golden/`);
  }
  // The fixtures cross pages, chunk boundaries and the survey walk, and
  // `since` narrows every entity.
  const parsed = (file: string) => JSON.parse(actual[file]);
  assert.equal(parsed("survey_responses.json").length, 286);
  assert.equal(parsed("annotations.json").length, 105);
  assert.equal(parsed("survey_responses.chunked.json").chunks.length, 15);
  assert.equal(parsed("annotations.chunked.json").chunks.length, 2);
  for (const entity of ENTITIES) {
    const all = parsed(`${entity}.json`).length;
    const since = parsed(`${entity}.since.json`).length;
    assert.ok(since > 0 && since < all, `${entity}: ${since} of ${all}`);
    assert.equal(parsed(`${entity}.chunked.json`).rows, all, entity);
  }
});

void test("a project API key travels in POSTHOG-API-TOKEN, a personal one as a bearer token", async () => {
  const own = await startReplayServer();
  try {
    for (const authType of [undefined, "project_api_key"]) {
      const apiKey = `phx_test_style_${authType ?? "personal"}`;
      await readFolder({
        entity: "surveys",
        maxIterations: 1,
        config: {
          ...testConfig(apiKey, own, { authType }),
          __rate_limit_delay_ms: 1,
        },
      });
      const requests = own.requests(apiKey);
      assert.ok(requests.length > 0);
      const style = authType ? "project-token" : "bearer";
      assert.ok(
        requests.every(r => r.endsWith(`(${style})`)),
        `${authType ?? "personal"}: ${requests.join(", ")}`,
      );
    }
    assert.deepEqual(own.misses, []);
  } finally {
    await own.close();
  }
});

void test("two-row pages resume from an offset, and the flow's 2000-row pages read the same rows since the anchor", async () => {
  const { GOLDEN_DIR } = await loadGolden();
  const own = await startReplayServer();
  try {
    for (const entity of ["annotations", "feature_flags"]) {
      const golden = JSON.parse(
        fs.readFileSync(path.join(GOLDEN_DIR, `${entity}.json`), "utf8"),
      );
      const small = await readFolder({
        entity,
        maxIterations: 1,
        config: {
          ...testConfig(`phx_test_small_${entity}`, own),
          __page_size: 2,
          __rate_limit_delay_ms: 1,
        },
      });
      assert.ok(small.chunks.length >= 2, `${entity} never resumed`);
      assert.equal(small.rows.length, golden.length, entity);

      const flow = await readFolder({
        entity,
        since: SINCE,
        maxIterations: 10,
        config: {
          ...testConfig(`phx_test_flow_${entity}`, own),
          __page_size: 2000,
          __rate_limit_delay_ms: 1,
        },
      });
      const sinceGolden = JSON.parse(
        fs.readFileSync(path.join(GOLDEN_DIR, `${entity}.since.json`), "utf8"),
      );
      assert.equal(flow.rows.length, sinceGolden.length, entity);
    }
    assert.deepEqual(own.misses, []);
  } finally {
    await own.close();
  }
});

void test("a read session reads the golden rows and closes every session", async () => {
  const { GOLDEN_DIR } = await loadGolden();
  const own = await startReplayServer();
  try {
    for (const entity of ENTITIES) {
      const connector = makeBoxed(
        testConfig(`phx_test_session_${entity}`, own),
        SessionPosthog,
      );
      await connector.resolveSchema(entity);
      const rows: unknown[] = [];
      let state: any;
      do {
        state = await connector.fetchEntityChunk({
          entity,
          maxIterations: 10,
          rateLimitDelay: 1,
          state,
          onBatch: async (batch: unknown[]) => {
            rows.push(...batch);
          },
        } as any);
      } while (state.hasMore);
      const golden = JSON.parse(
        fs.readFileSync(path.join(GOLDEN_DIR, `${entity}.json`), "utf8"),
      );
      assert.equal(rows.length, golden.length, entity);
      assert.equal(
        canonicalJson(JSON.parse(JSON.stringify(rows))),
        canonicalJson(golden),
        `${entity}: the session read differs from the golden rows`,
      );
    }
    assert.deepEqual(own.misses, []);
    // Every read went through a session, one per entity, and every session
    // was closed at the end of its read.
    assert.equal(SessionPosthog.chunkReads, 0);
    const calls = SessionPosthog.transports.flatMap(t => t.calls);
    assert.equal(calls.filter(c => c === "start").length, ENTITIES.length);
    assert.equal(calls.filter(c => c === "close").length, ENTITIES.length);
    assert.ok(calls.filter(c => c.startsWith("pull")).length > 0);
    assert.deepEqual(
      SessionPosthog.transports.map(t => t.open()),
      SessionPosthog.transports.map(() => 0),
    );
  } finally {
    await own.close();
  }
});

void test("the cassettes hold no key", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /\bph[xc]_/, file);
  }
});
