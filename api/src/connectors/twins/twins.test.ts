/**
 * Deleted built-in types resolve to their registry twins.
 *
 * - Both registries still know `close`, `stripe`, … and build a
 *   `RegistryTwinConnector`, a `SandboxedConnector` on the same connection
 *   read as `ws:<type>`.
 * - The config schema is the frozen built-in one, so stored credentials
 *   decrypt by the field list they were encrypted by.
 * - The twin is the workspace's own folder when it has one, else
 *   `mako/<type>@1` from the registry, whose spec runs once per hash.
 *
 * Run: node --import tsx src/connectors/twins/twins.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorRegistry } from "../registry";
import { syncConnectorRegistry } from "../../sync/connector-registry";
import { SandboxedConnector } from "../workspace/SandboxedConnector";
import type { LoadedConnector } from "../workspace/resolver";
import type { RegistryCatalog } from "../workspace/registry/store";
import { isSecretField } from "../source-connection-create.service";
import { BUILTIN_TWIN_CATALOG } from "./builtin-catalog";
import {
  RegistryTwinConnector,
  registryTwinClass,
} from "./RegistryTwinConnector";
import {
  clearTwinSpecCache,
  loadTwinDefinition,
  type TwinResolverDeps,
} from "./resolve";
import { BUILTIN_TWIN_TYPES, isBuiltinTwinType } from "./types";

const WORKSPACE = "64b000000000000000000001";

const connection = (type: string, config: Record<string, unknown> = {}) =>
  ({
    _id: "64b0000000000000000000aa",
    name: `${type} test`,
    type,
    workspaceId: WORKSPACE,
    config,
    settings: {},
  }) as any;

/** The secret fields each deleted built-in stored encrypted. */
const SECRETS: Record<string, string[]> = {
  close: ["api_key"],
  stripe: ["api_key"],
  pandadoc: ["api_key"],
  claap: ["api_key"],
  posthog: ["api_key"],
  wise: ["api_key", "sca_private_key"],
  calendly: ["access_token"],
};

void test("the seven deleted types are twins, and nothing else is", () => {
  assert.deepEqual([...BUILTIN_TWIN_TYPES].sort(), Object.keys(SECRETS).sort());
  for (const type of [
    "rest",
    "custom_api",
    "gcs",
    "ws:close",
    "",
    "toString",
  ]) {
    assert.equal(isBuiltinTwinType(type), false, type);
  }
});

void test("the API registry lists each type and builds its twin", async () => {
  await connectorRegistry.ready();
  for (const type of BUILTIN_TWIN_TYPES) {
    assert.ok(connectorRegistry.hasConnector(type), type);
    const metadata = connectorRegistry.getMetadata(type)!;
    assert.equal(
      metadata.metadata.name,
      BUILTIN_TWIN_CATALOG[type].metadata.name,
    );
    assert.deepEqual(
      metadata.metadata.incremental,
      BUILTIN_TWIN_CATALOG[type].incremental,
    );
    const connector = connectorRegistry.getConnectorFor(connection(type))!;
    assert.ok(connector instanceof RegistryTwinConnector, type);
    assert.ok(connector instanceof SandboxedConnector, type);
    // The box run carries the workspace type; the stored one is kept.
    assert.equal((connector as any).sourceConnection.type, `ws:${type}`);
    assert.equal((connector as RegistryTwinConnector).builtinType, type);
    // Before the definition loads: the built-in's entities, never [].
    assert.deepEqual(
      connector.getAvailableEntities(),
      BUILTIN_TWIN_CATALOG[type].metadata.supportedEntities,
    );
  }
});

void test("config schemas are the frozen built-in ones, secrets included", async () => {
  for (const type of BUILTIN_TWIN_TYPES) {
    const fromClass = (registryTwinClass(type) as any).getConfigSchema();
    const fromSync = await syncConnectorRegistry.getConfigSchemaForType(type);
    assert.deepEqual(fromClass, BUILTIN_TWIN_CATALOG[type].configSchema);
    assert.deepEqual(fromSync, fromClass);
    const secrets = (fromClass.fields as any[])
      .filter(field => isSecretField(field))
      .map(field => field.name);
    assert.deepEqual(secrets, SECRETS[type], type);
  }
  // A caller mutating the schema cannot change the next one.
  const first = (registryTwinClass("close") as any).getConfigSchema();
  first.fields.length = 0;
  assert.equal(
    (registryTwinClass("close") as any).getConfigSchema().fields.length,
    1,
  );
});

void test("the sync registry builds the twin for a decrypted connection", async () => {
  const Twin = registryTwinClass("stripe");
  // loadDefinition needs Mongo; the class wiring is what is under test.
  const connector = new Twin(connection("stripe", { api_key: "sk_test" }));
  assert.ok(connector instanceof SandboxedConnector);
  assert.throws(
    () => new RegistryTwinConnector(connection("rest")),
    /not a built-in type/,
  );
});

const HASH = "a".repeat(64);
const catalog: RegistryCatalog = {
  schemaVersion: 1,
  updatedAt: "2026-11-18T00:00:00.000Z",
  connectors: {
    close: {
      slug: "close",
      name: "Close",
      versions: [
        {
          version: "2.0.0",
          hash: "c".repeat(64),
          sha256: "d".repeat(64),
          bytes: 1,
          sdkVersion: "1.0.0",
          entry: "connector.ts",
          entities: ["leads"],
          authType: "api_key",
          publishedAt: "2026-11-18T00:00:00.000Z",
        },
        {
          version: "1.2.0",
          hash: HASH,
          sha256: "b".repeat(64),
          bytes: 1,
          sdkVersion: "1.0.0",
          entry: "connector.ts",
          entities: ["leads"],
          authType: "api_key",
          publishedAt: "2026-11-17T00:00:00.000Z",
        },
      ],
    },
  },
};

const SPEC = {
  connectionSpecification: {
    properties: { api_key: { type: "string", airbyte_secret: true } },
  },
  mako: { entities: { leads: {}, contacts: {} } },
};

function deps(overrides: Partial<TwinResolverDeps> = {}) {
  const calls = { spec: 0, folder: 0 };
  const value: TwinResolverDeps = {
    hasWorkspaceFolder: async () => false,
    loadWorkspaceFolder: async () => {
      calls.folder++;
      return { slug: "close", sourceSha: "folder" } as LoadedConnector;
    },
    registryEnabled: () => true,
    catalog: async () => catalog,
    runSpec: async () => {
      calls.spec++;
      return { ok: true, spec: SPEC };
    },
    ...overrides,
  };
  return { value, calls };
}

void test("a workspace folder of the same slug is the twin", async () => {
  clearTwinSpecCache();
  const { value, calls } = deps({ hasWorkspaceFolder: async () => true });
  const loaded = await loadTwinDefinition(WORKSPACE, "close", value);
  assert.equal(loaded.sourceSha, "folder");
  assert.equal(calls.folder, 1);
  assert.equal(calls.spec, 0);
});

void test("without a folder, mako/<type>@1 from the registry, its spec run once per hash", async () => {
  clearTwinSpecCache();
  const { value, calls } = deps();
  const first = await loadTwinDefinition(WORKSPACE, "close", value);
  const second = await loadTwinDefinition(WORKSPACE, "close", value);
  assert.equal(calls.spec, 1);
  assert.equal(first.registry?.version, "1.2.0", "stays inside major 1");
  assert.equal(first.registry?.hash, HASH);
  assert.equal(first.registry?.ref, "mako/close@1");
  assert.deepEqual(first.entities, ["leads", "contacts"]);
  assert.equal(first.status, "indexed");
  assert.equal(first.sourceSha, second.sourceSha);
});

void test("the registry path refuses clearly when it cannot run", async () => {
  clearTwinSpecCache();
  await assert.rejects(
    loadTwinDefinition(
      WORKSPACE,
      "close",
      deps({ registryEnabled: () => false }).value,
    ),
    /CONNECTOR_REGISTRY_ENABLED/,
  );
  await assert.rejects(
    loadTwinDefinition(WORKSPACE, "stripe", deps().value),
    /no connector mako\/stripe/,
  );
  // A failed spec is not cached: the next call runs it again.
  let runs = 0;
  const failing = deps({
    runSpec: async () => {
      runs++;
      return { ok: false, reason: "boom" };
    },
  }).value;
  await assert.rejects(loadTwinDefinition(WORKSPACE, "close", failing), /boom/);
  await assert.rejects(loadTwinDefinition(WORKSPACE, "close", failing), /boom/);
  assert.equal(runs, 2);
});

void test("only the keys the twin's spec declares reach the box", () => {
  const Twin = registryTwinClass("stripe");
  const connector = new Twin(
    connection("stripe", { api_key: "sk_test", legacy_flag: "x" }),
  ) as any;
  // Spec not loaded yet: nothing to filter by, the config passes through.
  assert.deepEqual(Object.keys(connector.config()).sort(), [
    "api_key",
    "legacy_flag",
  ]);
  connector.loaded = { spec: SPEC };
  assert.deepEqual(connector.config(), { api_key: "sk_test" });
});
