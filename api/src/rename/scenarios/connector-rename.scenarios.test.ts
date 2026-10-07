/**
 * SCENARIOS — workspace connector renames: names, cycles, chains, objects
 * never indexed, look-alike ids, and scale. (Credentials are their own
 * suite: connector-credentials.scenarios.test.ts.)
 *
 * Real bare repos + mongodb-memory-server; the sync box answers `spec`
 * without booting anything.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../../connectors/workspace/sync-box", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../connectors/workspace/sync-box")
  >()),
  hasConnectorRuntime: vi.fn(async () => true),
  materializeConnector: vi.fn(async () => "/box/connector"),
  runConnectorCommand: vi.fn(async () => ({
    exitCode: 0,
    malformed: [],
    stderr: "",
    timedOut: false,
    messages: [
      {
        type: "SPEC",
        spec: {
          connectionSpecification: {
            type: "object",
            properties: { apiKey: { type: "string", airbyte_secret: true } },
          },
          mako: { name: "C", version: "1.0.0", entities: {} },
        },
      },
    ],
  })),
}));

const member = vi.hoisted(() => ({ of: [] as string[] }));
vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: "u1" });
    await next();
  },
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async (ws: string) => member.of.includes(ws)),
  },
}));

import { Hono } from "hono";
import {
  ConnectorDefinition,
  SourceConnection,
} from "../../database/workspace-schema";
import { connectorRoutes } from "../../routes/connectors";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import { syncConnectorsFromRepo } from "../../connectors/workspace/reconcile.service";
import { findConnectorDefinitionFor } from "../../connectors/workspace/resolver";
import { renameObject, resolveObjectRef } from "../registry";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS = new Types.ObjectId().toString();
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
const ctx = () => ({ workspaceId: WS, userId: "u1", role: "member" });

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "conn-rename-scenarios-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.NODE_ENV = "development";
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  await ConnectorDefinition.deleteMany({});
  await SourceConnection.deleteMany({});
  await initRepo(repoDirFor(WS), { "README.md": "# workspace\n" });
  await bindTestWorkspaceRepo(WS);
});

const YAML = "runtime: node\nentry: connector.ts\n";
const code = (token: string) =>
  `// CODE:${token}\n${Array.from({ length: 20 }, (_, i) => `export const v${i} = "${token}-${i}-${"x".repeat(40)}";`).join("\n")}\n`;

async function push(mutation: Parameters<typeof commitBlobsOnBranch>[2]) {
  await commitBlobsOnBranch(repoDirFor(WS), DEFAULT_BRANCH, mutation, {
    message: "laptop push",
    author: { name: "Laptop", email: "laptop@example.com" },
  });
}

const folder = (slug: string, token = slug, yaml = YAML) => ({
  [`connectors/${slug}/connector.yaml`]: yaml,
  [`connectors/${slug}/connector.ts`]: code(token),
});

async function defId(slug: string): Promise<string> {
  const row = await ConnectorDefinition.findOne({ workspaceId: WS, slug });
  if (!row) throw new Error(`no definition ${slug}`);
  return String(row._id);
}

const rename = (from: string, to: string) =>
  renameObject(ctx(), "connector", { ref: from, slug: to });

describe("cycles, chains and taken names", () => {
  it("a→b→a; a→b then c→a is refused; a 30-step chain keeps one id and every old name", async () => {
    await push({ writes: { ...folder("a"), ...folder("c") } });
    await syncConnectorsFromRepo(WS);
    const A = await defId("a");
    await rename("a", "b");
    await rename("b", "a");
    expect((await ConnectorDefinition.findById(A))?.toObject()).toMatchObject({
      slug: "a",
      aliases: ["b"],
    });
    await rename("a", "b");
    // c may not take `a`: it is b's old name (its links/connections).
    await expect(rename("c", "a")).rejects.toMatchObject({ status: 409 });
    // A long chain: b → n1 → … → n30.
    let current = "b";
    for (let i = 1; i <= 30; i++) {
      await rename(current, `n${i}`);
      current = `n${i}`;
    }
    const row = await ConnectorDefinition.findById(A);
    expect(row?.slug).toBe("n30");
    expect(row?.aliases).toHaveLength(31); // a, b, n1…n29
    for (const old of ["a", "b", "n1", "n15", "n29"]) {
      expect((await resolveObjectRef(ctx(), "connector", old))?.id).toBe(A);
    }
    expect(await ConnectorDefinition.countDocuments({ workspaceId: WS })).toBe(
      2,
    );
  });

  it("a yaml listing its own slug, or a slug another live connector holds, changes nothing", async () => {
    await push({
      writes: {
        ...folder("a", "a", `${YAML}aliases: [a, c]\n`),
        ...folder("c"),
      },
    });
    await syncConnectorsFromRepo(WS);
    const a = await ConnectorDefinition.findOne({ workspaceId: WS, slug: "a" });
    expect(a?.aliases).toEqual([]);
    expect((await resolveObjectRef(ctx(), "connector", "c"))?.id).toBe(
      await defId("c"),
    );
  });

  it("an object never indexed (pushed, not yet synced) is not renamed blind; once indexed it is", async () => {
    await push({ writes: folder("fresh") });
    const head = await resolveCommit(repoDirFor(WS), MAIN);
    await expect(rename("fresh", "fresh2")).rejects.toMatchObject({
      status: 404,
    });
    expect(await resolveCommit(repoDirFor(WS), MAIN)).toBe(head);
    await syncConnectorsFromRepo(WS);
    const r = await rename("fresh", "fresh2");
    expect(r.after.slug).toBe("fresh2");
  });

  it("names that look like ids: a 24-hex slug is a slug; another workspace's id resolves to nothing", async () => {
    const hexSlug = "abcdefabcdefabcdefabcdef";
    await push({ writes: folder(hexSlug) });
    await syncConnectorsFromRepo(WS);
    const H = await defId(hexSlug);
    expect((await resolveObjectRef(ctx(), "connector", hexSlug))?.id).toBe(H);
    expect(
      (await resolveObjectRef(ctx(), "connector", `ws:${hexSlug}`))?.id,
    ).toBe(H);
    expect(
      await resolveObjectRef(
        ctx(),
        "connector",
        new Types.ObjectId().toString(),
      ),
    ).toBeNull();
    const r = await rename(hexSlug, "readable");
    expect(r.id).toBe(H);
  });
});

describe("old names in the catalog", () => {
  it("the icon of a connection still typed by an OLD slug is the connector's own icon (members only)", async () => {
    const icon = `<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>`;
    await push({
      writes: { ...folder("acme"), "connectors/acme/icon.svg": icon },
    });
    await syncConnectorsFromRepo(WS);
    await rename("acme", "acme-crm");
    const app = new Hono();
    app.route("/api/connectors", connectorRoutes);
    const get = (type: string) =>
      Promise.resolve(
        app.request(`/api/connectors/${type}/icon.svg?workspaceId=${WS}`),
      );
    member.of = [WS];
    for (const type of ["ws:acme-crm", "ws:acme"]) {
      const res = await get(type);
      expect([type, res.status, await res.text()]).toEqual([type, 200, icon]);
    }
    member.of = [];
    expect(await (await get("ws:acme")).text()).not.toBe(icon);
  });
});

describe("scale", () => {
  it("300 connectors × 5 aliases and 3000 connections: a no-change push, a rename and alias lookups stay bounded", async () => {
    const N = 300;
    const writes: Record<string, string> = {};
    for (let i = 0; i < N; i++) {
      Object.assign(
        writes,
        folder(
          `c${i}`,
          `c${i}`,
          `${YAML}aliases: [${Array.from({ length: 5 }, (_, j) => `c${i}-old${j}`).join(", ")}]\n`,
        ),
      );
    }
    await push({ writes });
    let t = Date.now();
    await syncConnectorsFromRepo(WS);
    const firstIndexMs = Date.now() - t;
    expect(await ConnectorDefinition.countDocuments({ workspaceId: WS })).toBe(
      N,
    );
    const rows = await ConnectorDefinition.find({ workspaceId: WS }).lean();
    await SourceConnection.insertMany(
      Array.from({ length: 3000 }, (_, k) => {
        const row = rows[k % N];
        return {
          workspaceId: new Types.ObjectId(WS),
          name: `conn ${k}`,
          type: `ws:${row.slug}`,
          connectorDefinitionId: row._id,
          config: { apiKey: "enc" },
          settings: { sync_batch_size: 100, rate_limit_delay_ms: 0 },
          createdBy: "u1",
        };
      }),
    );

    await push({ writes: { "README.md": "# touched\n" } });
    t = Date.now();
    await syncConnectorsFromRepo(WS);
    const noChangeMs = Date.now() - t;

    t = Date.now();
    await rename("c7", "c7-renamed");
    const renameMs = Date.now() - t;

    t = Date.now();
    for (let i = 0; i < 50; i++) {
      expect(
        (await resolveObjectRef(ctx(), "connector", `c${i}-old3`))?.current
          .slug,
      ).toBe(i === 7 ? "c7-renamed" : `c${i}`);
    }
    const resolveMs = (Date.now() - t) / 50;
    const conn = await SourceConnection.findOne({ type: "ws:c7-renamed" });
    expect((await findConnectorDefinitionFor(WS, conn!))?.row.slug).toBe(
      "c7-renamed",
    );
    console.info(
      `[scale] connectors: index ${N} folders ${firstIndexMs}ms; no-change push ${noChangeMs}ms; rename with ${N} rows / 3000 connections ${renameMs}ms; alias resolve ${resolveMs.toFixed(1)}ms each`,
    );
    expect(noChangeMs).toBeLessThan(30_000);
    expect(renameMs).toBeLessThan(30_000);
    expect(resolveMs).toBeLessThan(500);
  }, 300_000);

  it("the git-history scan behind old names is bounded: 700 commits under connectors/ — found inside the window, honestly not found past it", async () => {
    const repoDir = repoDirFor(WS);
    const noise = async (from: number, n: number) => {
      for (let i = from; i < from + n; i++) {
        await commitBlobsOnBranch(
          repoDir,
          DEFAULT_BRANCH,
          { writes: { [`connectors/noise${i % 7}/n${i}.txt`]: `${i}\n` } },
          { message: `noise ${i}` },
        );
      }
    };
    await push({ writes: { ...folder("old-a"), ...folder("old-b") } });
    // old-a moves, then 600 commits bury it past the 500-commit window.
    await push({
      writes: folder("new-a", "old-a"),
      deletes: [
        "connectors/old-a/connector.yaml",
        "connectors/old-a/connector.ts",
      ],
    });
    await noise(0, 600);
    // old-b moves recently: inside the window.
    await push({
      writes: folder("new-b", "old-b"),
      deletes: [
        "connectors/old-b/connector.yaml",
        "connectors/old-b/connector.ts",
      ],
    });
    await noise(600, 100);
    const { findRenamedFolder } = await import("../git-renames");
    let t = Date.now();
    const recent = await findRenamedFolder(
      repoDir,
      MAIN,
      "connectors",
      "old-b",
      "connector.ts",
      { similarity: 75 },
    );
    const recentMs = Date.now() - t;
    t = Date.now();
    const buried = await findRenamedFolder(
      repoDir,
      MAIN,
      "connectors",
      "old-a",
      "connector.ts",
      { similarity: 75 },
    );
    const buriedMs = Date.now() - t;
    console.info(
      `[scale] connector history scan over 700 commits: found ${recentMs}ms, past the window ${buriedMs}ms`,
    );
    expect(recent).toBe("new-b");
    expect(buried).toBeNull(); // a stale link, never a wrong answer
    expect(recentMs).toBeLessThan(5_000);
    expect(buriedMs).toBeLessThan(5_000);
  }, 600_000);
});
