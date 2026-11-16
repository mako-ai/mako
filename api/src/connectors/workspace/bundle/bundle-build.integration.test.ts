/**
 * Connector bundles, for real: a tiny connector with one npm dependency
 * (date-fns) is built in a build box, installed into a sync box, and run.
 *
 * Gated, because it needs a network and, for E2B, credentials. It is never
 * part of an offline run (see DELIBERATELY_UNCOVERED in test-coverage.test.ts).
 *
 *   E2B (what ships):  E2B_API_KEY=… RUN_CONNECTOR_BUNDLE_BUILD=e2b \
 *                        node --import tsx --test src/connectors/workspace/bundle/bundle-build.integration.test.ts
 *   On this machine:   RUN_CONNECTOR_BUNDLE_BUILD=local \
 *                        node --import tsx --test src/connectors/workspace/bundle/bundle-build.integration.test.ts
 *
 * The local variant uses the local sandbox provider: npm and esbuild run on
 * this machine against the public registry.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const MODE = process.env.RUN_CONNECTOR_BUNDLE_BUILD;
const ENABLED =
  MODE === "local" || (MODE === "e2b" && Boolean(process.env.E2B_API_KEY));

const CONNECTOR_TS = `
import { defineConnector } from "@makoai/connector-sdk";
import { formatISO } from "date-fns";

export default defineConnector({
  name: "acme-dates",
  version: "1.0.0",
  config: { properties: {} },
  entities: {
    days: {
      primaryKey: ["id"],
      schema: { id: "string", day: "string" },
      async *read() {
        yield {
          records: [{ id: "1", day: formatISO(new Date(Date.UTC(2026, 10, 16)), { representation: "date" }) }],
          hasMore: false,
        };
      },
    },
  },
});
`;

const PACKAGE_JSON = `{
  "name": "acme-dates",
  "private": true,
  "dependencies": {
    "date-fns": "4.1.0"
  }
}
`;

const PACKAGE_LOCK = `{
  "name": "acme-dates",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "acme-dates",
      "dependencies": {
        "date-fns": "4.1.0"
      }
    },
    "node_modules/date-fns": {
      "version": "4.1.0",
      "resolved": "https://registry.npmjs.org/date-fns/-/date-fns-4.1.0.tgz",
      "integrity": "sha512-Ukq0owbQXxa/U3EGtsdVBkR1w7KOQ5gIBqdH2hkvknzZPYvBxb/aa6E8L7tmjFtkwZBu3UXBbjIgPo/Ez4xaNg==",
      "license": "MIT",
      "funding": {
        "type": "github",
        "url": "https://github.com/sponsors/kossnocorp"
      }
    }
  }
}
`;

const WS = "0123456789abcdef0123456a";
let tmpRoot = "";

before(async () => {
  if (!ENABLED) return;
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "connector-bundle-"));
  process.env.APPS_SANDBOX_PROVIDER = MODE === "local" ? "local" : "e2b";
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.NODE_ENV = "development";
});

after(async () => {
  if (!ENABLED) return;
  const { getSandboxProvider } = await import("../../../apps/sandbox/provider");
  const { syncBoxContext } = await import("../sync-box");
  const provider = getSandboxProvider();
  // Build boxes destroy themselves; only the sync box is left.
  await provider
    .destroySession?.(syncBoxContext(WS).sessionKey)
    .catch(() => undefined);
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

void test(
  "a connector with one npm dependency builds, installs and runs",
  {
    skip:
      !ENABLED &&
      "set RUN_CONNECTOR_BUNDLE_BUILD=local, or =e2b with E2B_API_KEY",
    timeout: 600_000,
  },
  async () => {
    const { buildBundleInBox } = await import("./build-box");
    const { bundleSourceHash } = await import("./source-hash");
    const { connectorSdkVersion, ensureConnectorRuntime } =
      await import("../resolver");
    const sync = await import("../sync-box");

    const enc = (text: string) => new TextEncoder().encode(text);
    const files = new Map([
      ["connector.yaml", enc("runtime: node\n")],
      ["connector.ts", enc(CONNECTOR_TS)],
      ["package.json", enc(PACKAGE_JSON)],
      ["package-lock.json", enc(PACKAGE_LOCK)],
    ]);
    const hash = bundleSourceHash({
      files,
      sdkVersion: await connectorSdkVersion(),
    });

    const built = await buildBundleInBox({
      workspaceId: WS,
      slug: "acme-dates",
      hash,
      entry: "connector.ts",
      files,
    });
    assert.ok(built.ok, built.ok ? "" : built.reason);
    if (MODE === "local") {
      // The build's box is gone once the build is over.
      const scratch = path.join(os.tmpdir(), "mako-local-sandbox");
      const left = (await fs.readdir(scratch).catch(() => [])).filter(name =>
        name.includes(WS),
      );
      assert.deepEqual(left, []);
    }
    const text = new TextDecoder().decode(built.bytes);
    // date-fns is inlined; the SDK stays an import the runtime resolves.
    assert.doesNotMatch(text, /from\s+["']date-fns["']/);
    assert.match(text, /from\s+["']@makoai\/connector-sdk["']/);

    const ctx = sync.syncBoxContext(WS);
    const runtimeId = await ensureConnectorRuntime(ctx);
    const { dir, entry } = await sync.installConnectorBundle({
      ctx,
      runtimeId,
      slug: "acme-dates",
      hash,
      load: async () => built.bytes,
    });

    const spec = await sync.runConnectorCommand({
      ctx,
      runtimeId,
      connectorDir: dir,
      entry,
      command: "spec",
    });
    assert.equal(sync.failureMessage(spec), null, spec.stderr);
    const message = sync.firstOfType<{ spec?: { mako?: { name?: string } } }>(
      spec.messages,
      "SPEC",
    );
    assert.equal(message?.spec?.mako?.name, "acme-dates");

    const read = await sync.runConnectorCommand({
      ctx,
      runtimeId,
      connectorDir: dir,
      entry,
      command: "read",
      config: {},
      catalog: {
        streams: [{ stream: { name: "days" }, sync_mode: "full_refresh" }],
      },
    });
    assert.equal(sync.failureMessage(read), null, read.stderr);
    const record = read.messages.find(m => m.type === "RECORD") as
      { record?: { data?: { day?: string } } } | undefined;
    assert.equal(record?.record?.data?.day, "2026-11-16");
  },
);
