/**
 * The iteration-4 gate, against mocks: with CONNECTOR_REGISTRY_ENABLED on, a
 * workspace installs `source: mako/stripe@1`, and the bundle it resolves to
 * answers `spec`, `discover`, `check` and a first `read` exactly as the
 * `connectors/stripe/` folder does.
 *
 * What is real: the publish pipeline (file collection, source hash, spec and
 * discover on the built bundle, the catalog and the store on the filesystem
 * artifact store), a bare git repo the workspace pushes to, Mongo, the push
 * reconciler, `SandboxedConnector`, and every protocol command, each a real
 * process under the local sandbox provider. No E2B box is used.
 *
 * What is mocked: the build box. Instead of `npm ci` and esbuild inside a
 * box, the mock runs esbuild here with the build box's own flags, against the
 * folder's installed node_modules (`npm ci --prefix connectors/stripe`, which
 * the harness runs when it is missing). So the gate needs no network beyond
 * what the workspace-connector suites already use.
 *
 * Stripe itself is the replay server over the recorded cassettes in
 * connectors/stripe/fixtures, the same one the parity test uses.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  FOLDER,
  ensureFolderInstalled,
  readBoxed,
  runFolderCommand,
  startReplayServer,
  type ReplayServer,
} from "../../../../../connectors/stripe/fixtures/harness.mjs";
import { checkSetupAttempts } from "../../../../../connectors/stripe/fixtures/setup-attempts.mjs";

vi.mock("../bundle/build-box", async importOriginal => {
  const actual = await importOriginal<typeof import("../bundle/build-box")>();
  return {
    ...actual,
    // The build box, on this machine: the same esbuild flags, over the
    // published files, resolving packages from the folder's node_modules.
    buildBundleInBox: vi.fn(
      async (input: {
        entry: string;
        files: ReadonlyMap<string, Uint8Array>;
      }) => {
        const { default: nodeFs } = await import("node:fs/promises");
        const { default: nodePath } = await import("node:path");
        const { default: nodeOs } = await import("node:os");
        const { createRequire } = await import("node:module");
        const harness =
          await import("../../../../../connectors/stripe/fixtures/harness.mjs");
        const dir = await nodeFs.mkdtemp(
          nodePath.join(nodeOs.tmpdir(), "registry-gate-build-"),
        );
        try {
          for (const [name, bytes] of input.files) {
            const target = nodePath.join(dir, name);
            await nodeFs.mkdir(nodePath.dirname(target), { recursive: true });
            await nodeFs.writeFile(target, bytes);
          }
          await nodeFs.symlink(
            nodePath.join(harness.FOLDER, "node_modules"),
            nodePath.join(dir, "node_modules"),
            "dir",
          );
          // esbuild is not an api dependency; tsx's own copy is.
          const fromApi = createRequire(import.meta.url);
          const esbuild = createRequire(fromApi.resolve("tsx"))("esbuild") as {
            build(options: Record<string, unknown>): Promise<{
              outputFiles: Array<{ contents: Uint8Array }>;
            }>;
          };
          const out = await esbuild.build({
            absWorkingDir: dir,
            entryPoints: [input.entry],
            bundle: true,
            platform: "node",
            format: "esm",
            target: "node22",
            external: ["@makoai/connector-sdk"],
            legalComments: "none",
            logLevel: "warning",
            banner: {
              js: 'import { createRequire as __makoCreateRequire } from "node:module"; const require = __makoCreateRequire(import.meta.url);',
            },
            write: false,
          });
          return { ok: true, bytes: out.outputFiles[0].contents };
        } finally {
          await nodeFs.rm(dir, { recursive: true, force: true });
        }
      },
    ),
  };
});

import {
  ConnectorDefinition,
  type ISourceConnection,
} from "../../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
} from "../../../apps/repository.service";
import { syncConnectorsFromRepo } from "../reconcile.service";
import { SandboxedConnector } from "../SandboxedConnector";
import { CONNECTOR_REGISTRY_FLAG } from "./flag";
import { clearRegistryCatalogCache } from "./registry.service";
import { cleanupPublishBoxes, publishConnector } from "./publish";
import { readCatalog } from "./store";

const WS = new Types.ObjectId().toString();
const API_KEY = "sk_test_conformance";

let mongo: MongoMemoryServer;
let tmpRoot = "";
let server: ReplayServer;

beforeAll(async () => {
  ensureFolderInstalled();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "registry-gate-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.NODE_ENV = "development";
  process.env.DASHBOARD_ARTIFACT_DIR = path.join(tmpRoot, "artifacts");
  process.env[CONNECTOR_REGISTRY_FLAG] = "true";
  clearRegistryCatalogCache();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  server = await startReplayServer();
}, 300_000);

afterAll(async () => {
  await server?.close();
  await cleanupPublishBoxes();
  await mongoose.disconnect();
  await mongo?.stop();
  delete process.env[CONNECTOR_REGISTRY_FLAG];
  delete process.env.DASHBOARD_ARTIFACT_DIR;
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

const first = (messages: Array<Record<string, any>>, type: string) =>
  messages.find(message => message.type === type);

/** The STATE and RECORD stream of one chunk, timestamps aside. */
const records = (messages: Array<Record<string, any>>) =>
  messages
    .filter(message => message.type === "RECORD")
    .map(message => message.record.data);

describe("the gate: mako/stripe@1 installed by reference", () => {
  it("is published, resolved, and runs spec, discover, check and read like the folder", async () => {
    // Release CI, on this machine: build the folder, describe the bundle,
    // store it and write the catalog entry.
    const published = await publishConnector({
      folder: FOLDER,
      slug: "stripe",
      version: "1.5.0",
    });
    expect(published.published).toBe(true);
    const catalog = await readCatalog();
    expect(catalog.connectors.stripe.versions[0]).toMatchObject({
      version: "1.5.0",
      hash: published.hash,
      authType: "api_key",
      changelog: expect.stringContaining("setup_attempts"),
    });
    expect(published.entry.entities).toHaveLength(29);
    expect(published.entry.entities).toEqual(
      expect.arrayContaining([
        "setup_attempts",
        "checkout_sessions_line_items",
        "files",
      ]),
    );

    // The workspace installs it with one committed line.
    await initRepo(
      repoDirFor(WS),
      { "README.md": "# workspace\n" },
      { message: "init" },
    );
    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      {
        writes: {
          "connectors/stripe/connector.yaml": "source: mako/stripe@1\n",
        },
      },
      {
        message: "install mako/stripe",
        author: { name: "Test", email: "test@example.com" },
      },
    );
    const result = await syncConnectorsFromRepo(WS);
    expect(result).toMatchObject({ created: 1, blocked: 0 });

    const row = await ConnectorDefinition.findOne({
      workspaceId: WS,
      slug: "stripe",
    }).lean();
    expect(row?.status).toBe("indexed");
    expect(row?.registry).toMatchObject({
      ref: "mako/stripe@1",
      version: "1.5.0",
      hash: published.hash,
    });
    expect(row?.entities).toEqual(published.entry.entities);

    // spec: what the reconciler captured from the bundle is the folder's.
    const folderSpec = await runFolderCommand("spec");
    expect(folderSpec.code).toBe(0);
    expect(row?.spec).toEqual(first(folderSpec.messages, "SPEC")?.spec);

    // discover, check and a first read, through the run path.
    const config = { api_key: API_KEY, api_base_url: server.url };
    const connection = {
      _id: new Types.ObjectId(),
      workspaceId: new Types.ObjectId(WS),
      name: "Stripe",
      type: "ws:stripe",
      config,
      settings: {},
    };
    const connector = new SandboxedConnector(
      connection as unknown as ISourceConnection,
    );
    await connector.loadDefinition();

    const boxed = (await (
      connector as unknown as { catalog(): Promise<Record<string, any>> }
    ).catalog()) as Record<string, any>;
    const folderDiscover = await runFolderCommand("discover", { config });
    expect(folderDiscover.code).toBe(0);
    expect(boxed).toEqual(first(folderDiscover.messages, "CATALOG"));

    const check = await connector.testConnection();
    const folderCheck = await runFolderCommand("check", { config });
    expect(check.success).toBe(true);
    expect(
      first(folderCheck.messages, "CONNECTION_STATUS")?.connectionStatus
        ?.status,
    ).toBe("SUCCEEDED");

    const rows: unknown[] = [];
    const state = await connector.fetchEntityChunk({
      entity: "customers",
      maxIterations: 1,
      onBatch: async (batch: unknown[]) => {
        rows.push(...batch);
      },
    } as any);
    const folderRead = await runFolderCommand("read", {
      config,
      catalog: {
        streams: [{ stream: { name: "customers" }, sync_mode: "incremental" }],
      },
      maxIterations: 1,
    });
    expect(folderRead.code).toBe(0);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual(records(folderRead.messages));
    expect(state.metadata).toEqual(
      folderRead.messages.filter(m => m.type === "STATE").at(-1)?.state,
    );
    expect(server.misses).toEqual([]);

    await checkSetupAttempts(async ({ config, ...options }) => {
      const setupAttempts = new SandboxedConnector({
        ...connection,
        config,
      } as unknown as ISourceConnection);
      return readBoxed(setupAttempts, { ...options, pageSize: 2 });
    });
  }, 300_000);
});
