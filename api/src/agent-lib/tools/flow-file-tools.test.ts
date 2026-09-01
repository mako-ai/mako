/**
 * `check_flow_files`: the pre-push check an agent authoring `flows/<slug>.yml`
 * calls before it commits.
 *
 * Two kinds of assertion here, and the second kind is the point.
 *
 * BEHAVIOUR — above all, that a PARTIAL input never reports a teardown. The
 * plan derives removals from absence, so a tool that read "the two files I
 * changed" as "the whole of flows/" would tell an agent it is about to delete
 * every other pipeline in the workspace. The converse is pinned too: a
 * deletion the caller actually asks about IS reported, because a check that
 * never reports a teardown passes the first test trivially and is worthless.
 *
 * WIRING — that the tool is registered, classified, bridged and reachable.
 * The two functions this composes were both shipped, tested and unreachable:
 * `dryRunFlowReconcile` had zero non-test callers. A green unit test on the
 * helper is exactly what that failure looks like, so the tool is exercised
 * through the MCP toolset the server actually builds, not just through its
 * own export.
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

const state = vi.hoisted(() => ({
  sent: [] as Array<{ name: string; data: unknown }>,
}));

// No mirror: `ensureLocalRepo` must not reach for a remote, and the local
// bare repo below is authoritative.
vi.mock("../../services/workspace-repos.service", () => ({
  getWorkspaceRepo: vi.fn(async () => null),
  findWorkspaceIdByRepoBinding: vi.fn(async () => null),
}));
// A read-only tool must send no events. Observed rather than assumed.
vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(async (event: { name: string; data: unknown }) => {
      state.sent.push(event);
    }),
  },
}));

import {
  CdcEntityState,
  Connector,
  DatabaseConnection,
  Flow,
} from "../../database/workspace-schema";
import { initRepo, repoDirFor } from "../../apps/repository.service";
import { checkFlowFiles, createFlowFileTools } from "./flow-file-tools";
import { buildMakoMcpToolset } from "../../mcp/mako-mcp-server";
import {
  MCP_BRIDGE_POLICY,
  assertBridgePolicyCovers,
  assertBridgePolicyNotStale,
  mcpExposedToolNames,
  mcpReadOnlyHint,
} from "../../mcp/bridge-policy";
import { collectLiveAgentToolNames } from "../../mcp/bridge-inventory";
import { DEFERRED_BUILTIN_TOOL_NAMES } from "../../agents/modes/registry";
import { unifiedAgentFactory } from "../../agents/unified";
import { READ_ONLY_TOOL_NAMES } from "@mako/agent-tools";
import type { AgentContext } from "../../agents/types";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS: Types.ObjectId;
let CONNECTOR: Types.ObjectId;
let DEST: Types.ObjectId;

/** A file that parses, resolves, and produces a row the schema accepts. */
function flowYaml(name: string, entities?: string[]): string {
  const lines = [
    `name: ${name}`,
    "type: scheduled",
    "source:",
    "  type: connector",
    `  connector_id: ${CONNECTOR.toString()}`,
    "destination:",
    `  connection_id: ${DEST.toString()}`,
    "sync:",
    "  mode: incremental",
    "  engine: cdc",
  ];
  if (entities) {
    lines.push("entities:", "  filter:");
    for (const entity of entities) lines.push(`    - ${entity}`);
  }
  return `${lines.join("\n")}\n`;
}

async function seedRow(slug: string, entityFilter?: string[]) {
  return Flow.create({
    workspaceId: WS,
    slug,
    name: slug,
    type: "scheduled",
    sourceType: "connector",
    dataSourceId: CONNECTOR,
    destinationDatabaseId: DEST,
    syncEngine: "cdc",
    // No cron, matching a file with no `schedule:` block — `schedule.cron` is
    // required only while the schedule is enabled.
    schedule: { enabled: false },
    entityFilter,
    createdBy: "u1",
  });
}

/** Everything a read must leave exactly as it found it. */
async function snapshot() {
  return JSON.stringify({
    flows: await Flow.find({}).sort({ slug: 1 }).lean(),
    entities: await CdcEntityState.find({}).sort({ entity: 1 }).lean(),
  });
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-file-tools-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  WS = new Types.ObjectId();
  CONNECTOR = new Types.ObjectId();
  DEST = new Types.ObjectId();
  state.sent = [];
  await Promise.all([
    Flow.deleteMany({}),
    CdcEntityState.deleteMany({}),
    Connector.deleteMany({}),
    DatabaseConnection.deleteMany({}),
  ]);
  await Connector.create({
    _id: CONNECTOR,
    workspaceId: WS,
    name: "Close",
    type: "close",
    config: {},
    settings: { rate_limit_delay_ms: 100, sync_batch_size: 100 },
    createdBy: "u1",
  });
  await DatabaseConnection.create({
    _id: DEST,
    workspaceId: WS,
    name: "Warehouse",
    type: "bigquery",
    connection: { projectId: "p", keyFilename: "k" },
    createdBy: "u1",
  });
});

/** Seed the workspace repo's main with the given files. */
async function seedRepo(files: Record<string, string>) {
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS.toString()), {
    "README.md": "x\n",
    ...files,
  });
}

describe("partial input never reports a phantom teardown", () => {
  it("reads the rest of flows/ from the repo and merges the caller's files on top", async () => {
    await seedRepo({
      "flows/alpha.yml": flowYaml("alpha"),
      "flows/beta.yml": flowYaml("beta"),
      "flows/gamma.yml": flowYaml("gamma"),
    });
    await seedRow("alpha");
    await seedRow("beta");
    await seedRow("gamma");

    // The agent edited ONE of three files and passes only that one — the
    // case that would report a two-flow teardown under directory semantics.
    const result = await checkFlowFiles({
      workspaceId: WS.toString(),
      files: [{ path: "flows/beta.yml", contents: flowYaml("beta renamed") }],
    });

    expect(result.wouldTeardown).toEqual([]);
    expect(result.preExisting.wouldTeardown).toEqual([]);
    expect(result.wouldCreate).toEqual([]);
    expect(result.overlay.replaced).toEqual(["flows/beta.yml"]);
    expect(result.baseline.flowFiles).toBe(3);
    expect(result.ok).toBe(true);
  });

  it("still reports a teardown the caller actually asks about", async () => {
    await seedRepo({
      "flows/alpha.yml": flowYaml("alpha"),
      "flows/beta.yml": flowYaml("beta"),
    });
    await seedRow("alpha");
    await seedRow("beta");

    const result = await checkFlowFiles({
      workspaceId: WS.toString(),
      files: [],
      deletedPaths: ["flows/beta.yml"],
    });

    expect(result.wouldTeardown).toEqual(["beta"]);
    expect(result.overlay.deleted).toEqual(["flows/beta.yml"]);
    expect(
      result.notes.some(n => n.includes("disposes its CDC checkpoints")),
    ).toBe(true);
  });

  it("attributes a fileless flow to the repo, not to the caller", async () => {
    // `orphan` has a row and no file: a push tears it down with or without
    // this change, so it must not be reported as caused by these files.
    await seedRepo({ "flows/alpha.yml": flowYaml("alpha") });
    await seedRow("alpha");
    await seedRow("orphan");

    const result = await checkFlowFiles({
      workspaceId: WS.toString(),
      files: [{ path: "flows/alpha.yml", contents: flowYaml("alpha v2") }],
    });

    expect(result.wouldTeardown).toEqual([]);
    expect(result.preExisting.wouldTeardown).toEqual(["orphan"]);
  });
});

describe("the destructive half an agent cannot see otherwise", () => {
  it("reports an entity dropped from the selection BEFORE the row is applied", async () => {
    await seedRepo({
      "flows/alpha.yml": flowYaml("alpha", ["leads", "contacts"]),
    });
    const row = await seedRow("alpha", ["leads", "contacts"]);
    for (const entity of ["leads", "contacts"]) {
      await CdcEntityState.create({
        workspaceId: WS,
        flowId: row._id,
        entity,
        lastIngestSeq: 5,
      });
    }

    // Same directory, one entity removed from the file. Nothing has been
    // applied to the row yet — reading the row would answer "nothing would
    // happen", which is the failure mode this exists to catch.
    const result = await checkFlowFiles({
      workspaceId: WS.toString(),
      files: [
        { path: "flows/alpha.yml", contents: flowYaml("alpha", ["leads"]) },
      ],
    });

    expect(result.wouldReconfigure).toEqual([
      { slug: "alpha", entities: ["contacts"] },
    ]);

    // And the converse: the same file unchanged plans nothing.
    const unchanged = await checkFlowFiles({
      workspaceId: WS.toString(),
      files: [
        {
          path: "flows/alpha.yml",
          contents: flowYaml("alpha", ["leads", "contacts"]),
        },
      ],
    });
    expect(unchanged.wouldReconfigure).toEqual([]);
    expect(unchanged.overlay.unchanged).toEqual(["flows/alpha.yml"]);
  });

  it("says the guard is UNEVALUATED before a push, never verified", async () => {
    await seedRepo({
      "flows/alpha.yml": flowYaml("alpha"),
      "flows/beta.yml": flowYaml("beta"),
    });
    await seedRow("alpha");
    await seedRow("beta");

    const destructive = await checkFlowFiles({
      workspaceId: WS.toString(),
      files: [],
      deletedPaths: ["flows/beta.yml"],
    });
    expect(destructive.guard.required).toBe(true);
    expect(destructive.guard.verdict).toBe("unevaluated");
    expect(destructive.guard.reason).toMatch(/have not been pushed/);

    const harmless = await checkFlowFiles({
      workspaceId: WS.toString(),
      files: [{ path: "flows/alpha.yml", contents: flowYaml("alpha v2") }],
    });
    expect(harmless.guard.verdict).toBe("not-needed");
  });
});

describe("the three validation layers", () => {
  it("catches an id that does not resolve in this workspace", async () => {
    await seedRepo({});
    const stranger = new Types.ObjectId().toString();
    const result = await checkFlowFiles({
      workspaceId: WS.toString(),
      files: [
        {
          path: "flows/new-one.yml",
          contents: flowYaml("new one").replace(CONNECTOR.toString(), stranger),
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(
      result.problems.some(p => p.reason.includes("does not name a connector")),
    ).toBe(true);
  });

  it("catches a file the row schema would refuse on save", async () => {
    await seedRepo({});
    // Parses, every id resolves — and `entityLayouts.0.partitionField` is
    // required, so `doc.save()` throws and the push silently changes nothing.
    const contents = `${flowYaml("layouts")}entities:\n  layouts:\n    - entity: leads\n`;
    const result = await checkFlowFiles({
      workspaceId: WS.toString(),
      files: [{ path: "flows/layouts.yml", contents }],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.reason.includes("partitionField"))).toBe(
      true,
    );
  });

  it("treats a file that does not parse as the removal the push path makes it", async () => {
    // The reactor drops an unparseable file from its desired set while
    // leaving the rest of the tree in it, and the reconciler reads that
    // absence as a removal. So a YAML typo in an existing flow's file is a
    // teardown, not a no-op — a pre-existing behaviour this check surfaces
    // rather than hides. (`beta` keeps the desired set non-empty; an EMPTY
    // one returns early and is never a deletion.)
    await seedRepo({
      "flows/alpha.yml": flowYaml("alpha"),
      "flows/beta.yml": flowYaml("beta"),
    });
    await seedRow("alpha");
    await seedRow("beta");

    const result = await checkFlowFiles({
      workspaceId: WS.toString(),
      files: [{ path: "flows/alpha.yml", contents: "name: [broken" }],
    });

    expect(result.ok).toBe(false);
    expect(result.wouldTeardown).toEqual(["alpha"]);
    expect(result.notes.some(n => n.includes("does not parse"))).toBe(true);
  });
});

describe("read-only", () => {
  it("changes nothing and sends nothing, including for a teardown", async () => {
    await seedRepo({
      "flows/alpha.yml": flowYaml("alpha", ["leads", "contacts"]),
      "flows/beta.yml": flowYaml("beta"),
    });
    const row = await seedRow("alpha", ["leads", "contacts"]);
    await seedRow("beta");
    await CdcEntityState.create({
      workspaceId: WS,
      flowId: row._id,
      entity: "contacts",
      lastIngestSeq: 9,
    });

    const before = await snapshot();
    const result = await checkFlowFiles({
      workspaceId: WS.toString(),
      files: [
        { path: "flows/alpha.yml", contents: flowYaml("alpha", ["leads"]) },
      ],
      deletedPaths: ["flows/beta.yml"],
    });
    // The call planned the two destructive operations…
    expect(result.wouldTeardown).toEqual(["beta"]);
    expect(result.wouldReconfigure).toEqual([
      { slug: "alpha", entities: ["contacts"] },
    ]);
    // …and performed neither.
    expect(await snapshot()).toBe(before);
    expect(state.sent).toEqual([]);
    expect(await Flow.countDocuments({ workspaceId: WS })).toBe(2);
  });
});

describe("wiring: registered, classified, bridged, reachable", () => {
  it("is classified everywhere a built-in tool must be", () => {
    // Bridge policy: classified, and classified as BRIDGED.
    expect(MCP_BRIDGE_POLICY.check_flow_files?.status).toBe("bridge");
    expect(mcpExposedToolNames()).toContain("check_flow_files");
    assertBridgePolicyCovers(collectLiveAgentToolNames());
    assertBridgePolicyNotStale(collectLiveAgentToolNames());
    // Inventory: the factory is one the policy tests actually walk.
    expect(collectLiveAgentToolNames()).toContain("check_flow_files");
    // Tier policy (CLAUDE.md): core | mode | deferred, or permanently dormant.
    expect(DEFERRED_BUILTIN_TOOL_NAMES).toContain("check_flow_files");
    // Read-only classification drives the plan-mode gate and the MCP hint.
    expect(READ_ONLY_TOOL_NAMES.has("check_flow_files")).toBe(true);
    expect(mcpReadOnlyHint("check_flow_files", "read")).toBe(true);
  });

  it("is registered by the in-product agent factory", () => {
    const tools = unifiedAgentFactory({
      workspaceId: WS.toString(),
      userId: "u1",
      consoles: [],
    } as unknown as AgentContext).tools;
    expect(Object.keys(tools)).toContain("check_flow_files");
  });

  it("is reachable — and correct — through the MCP toolset the server builds", async () => {
    await seedRepo({
      "flows/alpha.yml": flowYaml("alpha"),
      "flows/beta.yml": flowYaml("beta"),
    });
    await seedRow("alpha");
    await seedRow("beta");

    const toolset = buildMakoMcpToolset({
      workspaceId: WS.toString(),
      scopes: ["mcp"],
    } as Parameters<typeof buildMakoMcpToolset>[0]);
    const exposed = toolset.check_flow_files as unknown as {
      execute: (input: unknown) => Promise<Record<string, unknown>>;
    };
    expect(exposed).toBeTruthy();

    const result = await exposed.execute({
      files: [{ path: "flows/gamma.yml", contents: flowYaml("gamma") }],
    });
    // The same partial-input property, asserted through the bridged tool:
    // one new file, two untouched flows, no teardown.
    expect(result.wouldCreate).toEqual(["gamma"]);
    expect(result.wouldTeardown).toEqual([]);
    expect((result.overlay as { added: string[] }).added).toEqual([
      "flows/gamma.yml",
    ]);
  });

  it("exposes exactly one tool from its own factory", () => {
    expect(Object.keys(createFlowFileTools(WS.toString()))).toEqual([
      "check_flow_files",
    ]);
  });
});
