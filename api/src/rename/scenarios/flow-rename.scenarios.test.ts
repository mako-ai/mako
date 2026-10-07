/**
 * Graceful rename of FLOWS — the scenario matrix (mako-ai/mako#1037).
 *
 * Every entry point (the UI's REST route, `rename_object` as the in-product
 * agent holds it, `rename_object` over MCP, and a laptop `git mv` pushed into
 * the workspace repo and synced as the git endpoint would) × every operation
 * (title, slug, both, back, onto taken names, case variants, twice, delete +
 * recreate, copy, never synced, no-op), against the real services: a bare
 * repo, a memory Mongo, real routes, real git.
 *
 * After every cell the flow's identity is checked as a stream: same id, the
 * CDC checkpoints, run history, webhook events, inbound webhook URL and
 * secret, schedules and the scheduler's claim all intact; NO teardown
 * (`flow.cancel`, runtime rows disposed) and NO second stream into the same
 * destination, ever. Roles, links (old URL → current, reused, ambiguous,
 * another workspace) and cross-workspace isolation follow.
 *
 * Hostile names, partial failures, concurrency, cycles and scale are in
 * flow-rename-hostile.scenarios.test.ts.
 */
import fs from "node:fs/promises";
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

vi.hoisted(() => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ??
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
});

vi.mock("../../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
// The mirror stand-in of flow-sync.repo.test.ts: when `mirror.main` is set,
// only that commit verifies as the mirror's main.
const mirror = vi.hoisted(() => ({ main: null as string | null }));
vi.mock("../../apps/cloud-repo.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/cloud-repo.service")>();
  return {
    ...actual,
    assertTreeAtMirrorMain: async (workspaceId: string, sha: string) => {
      if (mirror.main === null) {
        return actual.assertTreeAtMirrorMain(workspaceId, sha);
      }
      if (sha !== mirror.main) {
        throw new actual.TreeNotVerifiedError(
          `read at ${sha.slice(0, 8)}, mirror main is ${mirror.main.slice(0, 8)}`,
        );
      }
    },
  };
});
const inngestSent = vi.hoisted(() => [] as Array<{ name: string }>);
vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(async (event: { name: string }) => {
      inngestSent.push(event);
    }),
    createFunction: vi.fn(() => ({})),
  },
}));
const published = vi.hoisted(() => [] as Array<{ type: string }>);
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn((_ws: string, event: { type: string }) => {
    published.push(event);
  }),
}));
// Who is calling: the REST route's auth middleware reads this, and the
// workspace service answers membership from `members`.
const auth = vi.hoisted(() => ({
  authType: "session" as "session" | "apiKey" | "mcpOAuth",
  user: undefined as { id: string } | undefined,
}));
const members = vi.hoisted(() => new Map<string, string>());
vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", auth.authType);
    if (auth.user) c.set("user", auth.user);
    await next();
  },
  isSessionAuth: (c: { get: (k: string) => unknown }) =>
    c.get("authType") === "session",
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async (ws: string, userId: string) =>
      members.has(`${ws}:${String(userId)}`),
    ),
    getMember: vi.fn(async (ws: string, userId: string) => {
      const role = members.get(`${ws}:${String(userId)}`);
      return role ? { role } : null;
    }),
    hasRole: vi.fn(async (ws: string, userId: string, roles: string[]) =>
      roles.includes(members.get(`${ws}:${String(userId)}`) ?? ""),
    ),
  },
}));

import { Hono } from "hono";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  CdcEntityState,
  Flow,
  FlowExecution,
  WebhookEvent,
} from "../../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
} from "../../apps/repository.service";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import {
  derivedFlowId,
  loadLiveFlowById,
  loadLiveFlows,
  resetFreshenOnMissThrottle,
  syncFlowsFromRepo,
} from "../../services/flow-sync.service";
import {
  flowRenameTarget,
  flowToFile,
  parseFlowFile,
} from "../../services/flow-config-files";
import { objectRoutes } from "../../routes/objects";
import { createRenameTools } from "../../agent-lib/tools/rename-tools";
import { buildMakoMcpServer } from "../../mcp/mako-mcp-server";
import { StatelessMcpTransport } from "../../mcp/stateless-transport";
import type { WorkspaceApiKeyScope } from "../../auth/api-key-scopes";
import { resolveFlowRef } from "../flow-rename";
import type { RenameResult } from "../types";
import {
  Laptop,
  commitCountOf,
  fileAtMain,
  headOf,
  pathsAtMain,
  pathsTouchedBy,
  tmpRootFor,
} from "./scenario-rig";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS: string;

const OWNER = new Types.ObjectId().toString();
const ADMIN = new Types.ObjectId().toString();
const EDITOR = new Types.ObjectId().toString();
const VIEWER = new Types.ObjectId().toString();
const STRANGER = new Types.ObjectId().toString();
const CONNECTOR = new Types.ObjectId().toString();
const DEST = new Types.ObjectId().toString();

/**
 * A complete CDC webhook flow. `tag` picks the destination dataset, so
 * every flow a scenario seeds is its own stream — two rows with one target
 * is exactly the duplicate this suite must never see.
 */
function flowYaml(name: string, tag: string, extra = ""): string {
  return [
    `name: ${name}`,
    "type: webhook",
    "source:",
    "  type: connector",
    `  connector_id: ${CONNECTOR}`,
    "destination:",
    `  connection_id: ${DEST}`,
    "  table:",
    `    schema: raw_${tag}`,
    "    create_if_not_exists: true",
    "backfill_schedule:",
    "  cron: 0 3 * * *",
    "  timezone: UTC",
    "webhook:",
    "  enabled: true",
    "sync:",
    "  mode: incremental",
    "  write_mode: append_dedup",
    "  engine: cdc",
    "entities:",
    "  layouts:",
    "    - entity: leads",
    "      partitionField: _syncedAt",
    "      partitionGranularity: day",
    "      enabled: true",
    extra,
    "",
  ].join("\n");
}

async function push(
  writes: Record<string, string>,
  deletes: string[] = [],
): Promise<void> {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes, deletes },
    { message: "laptop push" },
  );
}

const LAST_RUN = new Date("2026-09-30T03:00:00.000Z");

/** A synced flow with a stream's worth of runtime keyed by its id. */
async function seedFlow(slug: string, name: string, tag = slug) {
  await push({ [`flows/${slug}.yml`]: flowYaml(name, tag) });
  await syncFlowsFromRepo(WS, OWNER);
  const row = await Flow.findOne({ workspaceId: WS, slug });
  expect(row, `seeded ${slug}`).not.toBeNull();
  const flowId = row!._id;
  const workspaceId = new Types.ObjectId(WS);
  await CdcEntityState.create({
    workspaceId,
    flowId,
    entity: "leads",
    mode: "steady",
    lastIngestSeq: 42,
    lastMaterializedSeq: 42,
    backlogCount: 0,
    lifetimeEventsProcessed: 1,
    lifetimeRowsApplied: 1,
    mergeIntervalSeconds: 30,
    consecutiveFailures: 0,
  });
  await FlowExecution.create({
    workspaceId,
    flowId,
    startedAt: new Date(),
    status: "completed",
    success: true,
  });
  await WebhookEvent.create({
    workspaceId,
    flowId,
    eventId: `evt_${slug}`,
    eventType: "lead.created",
    status: "completed",
    rawPayload: { id: 1 },
    applyStatus: "applied",
  });
  // Runtime the file never carries: the provider's signing secret and the
  // scheduler's claim. A rename must move neither.
  await Flow.updateOne(
    { _id: flowId },
    {
      $set: {
        "webhookConfig.secret": "whsec_scenario",
        "backfillSchedule.lastRunAt": LAST_RUN,
      },
    },
  );
  return (await Flow.findById(flowId))!;
}

interface StreamState {
  id: string;
  slug?: string;
  name?: string;
  aliases: string[];
  endpoint?: string;
  secret?: string;
  backfillCron?: string;
  backfillLastRunAt?: string;
  runtime: number[];
}

async function streamState(id: Types.ObjectId | string): Promise<StreamState> {
  const row = await Flow.findById(id).lean();
  expect(row, `flow ${String(id)} still exists`).not.toBeNull();
  const flowId = new Types.ObjectId(String(id));
  return {
    id: String(row!._id),
    slug: row!.slug,
    name: row!.name,
    aliases: row!.aliases ?? [],
    endpoint: row!.webhookConfig?.endpoint,
    secret: row!.webhookConfig?.secret,
    backfillCron: row!.backfillSchedule?.cron,
    backfillLastRunAt: row!.backfillSchedule?.lastRunAt?.toISOString(),
    runtime: await Promise.all([
      CdcEntityState.countDocuments({ flowId }),
      FlowExecution.countDocuments({ flowId }),
      WebhookEvent.countDocuments({ flowId }),
    ]),
  };
}

/**
 * The stream survived: same id, same runtime, same webhook URL and secret,
 * the scheduler's claim kept. Name/slug/aliases are the caller's to check.
 */
function webhookPath(endpoint: string | undefined): string | undefined {
  return endpoint === undefined
    ? undefined
    : new URL(endpoint, "http://host.invalid").pathname;
}

async function expectSameStream(before: StreamState): Promise<StreamState> {
  const after = await streamState(before.id);
  expect(after.id).toBe(before.id);
  expect(after.runtime).toEqual(before.runtime);
  // The inbound identity is the path (/api/webhooks/<ws>/<flow id>); the
  // host is the deployment's, and GET/PUT re-derive it from the request.
  expect(webhookPath(after.endpoint)).toBe(webhookPath(before.endpoint));
  expect(after.endpoint).toContain(`/api/webhooks/${WS}/${before.id}`);
  expect(after.secret).toBe(before.secret);
  expect(after.backfillLastRunAt).toBe(before.backfillLastRunAt);
  return after;
}

/** No teardown and no second stream into one destination — in any cell. */
async function expectNoTeardownNoDuplicate(): Promise<void> {
  expect(inngestSent.map(e => e.name)).not.toContain("flow.cancel");
  const rows = await Flow.find({ workspaceId: WS });
  const targets = rows.map(row => flowRenameTarget(flowToFile(row)));
  expect(new Set(targets).size, `targets ${targets.join(" | ")}`).toBe(
    targets.length,
  );
}

async function resolves(ref: string): Promise<string | null> {
  return (await resolveFlowRef({ workspaceId: WS }, ref))?.id ?? null;
}

// ---- entry points ---------------------------------------------------------

type Entry = "rest" | "tool" | "mcp";
const ENTRIES: Entry[] = ["rest", "tool", "mcp"];

interface Outcome {
  ok: boolean;
  /** HTTP status for REST; 200/0 for the tool and MCP. */
  status: number;
  result?: RenameResult;
  error?: string;
}

const objectsApp = new Hono();
objectsApp.route("/api/workspaces/:workspaceId/objects", objectRoutes);

async function rest(
  method: "GET" | "POST",
  url: string,
  userId: string | undefined,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  auth.authType = "session";
  auth.user = userId ? { id: userId } : undefined;
  const res = await objectsApp.request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

async function mcpCall(
  args: Record<string, unknown>,
  context: {
    userId?: string;
    memberRole?: string;
    scopes?: WorkspaceApiKeyScope[];
  },
): Promise<{ isError: boolean; text: string }> {
  const server = buildMakoMcpServer({
    workspaceId: WS,
    userId: context.userId,
    memberRole: context.memberRole,
    scopes: context.scopes ?? ["mcp", "query:read"],
  });
  const transport = new StatelessMcpTransport();
  await server.connect(transport);
  try {
    const [response] = (await transport.handle(
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "rename_object", arguments: args },
        },
      ] as unknown as JSONRPCMessage[],
      60_000,
    )) as unknown as Array<{
      result?: { isError?: boolean; content: Array<{ text: string }> };
      error?: { message: string };
    }>;
    if (response.error) return { isError: true, text: response.error.message };
    return {
      isError: Boolean(response.result?.isError),
      text: response.result?.content?.[0]?.text ?? "",
    };
  } finally {
    await server.close();
  }
}

async function renameVia(
  entry: Entry,
  request: { ref: string; title?: string; slug?: string },
  as: string = OWNER,
): Promise<Outcome> {
  if (entry === "rest") {
    const { status, json } = await rest(
      "POST",
      `/api/workspaces/${WS}/objects/flow/rename`,
      as,
      request,
    );
    return {
      ok: status === 200,
      status,
      result: json.result as RenameResult | undefined,
      error: json.error as string | undefined,
    };
  }
  if (entry === "tool") {
    const tool = createRenameTools(WS, as).rename_object;
    const out = (await tool.execute!(
      { kind: "flow", ...request },
      { toolCallId: "t", messages: [] },
    )) as { success: boolean; error?: string } & Partial<RenameResult>;
    return out.success
      ? { ok: true, status: 200, result: out as unknown as RenameResult }
      : { ok: false, status: 0, error: out.error };
  }
  const out = await mcpCall(
    { kind: "flow", ...request },
    { userId: as, memberRole: members.get(`${WS}:${as}`) },
  );
  if (out.isError) return { ok: false, status: 0, error: out.text };
  const parsed = JSON.parse(out.text) as { success: boolean; error?: string };
  return parsed.success
    ? { ok: true, status: 200, result: parsed as unknown as RenameResult }
    : { ok: false, status: 0, error: parsed.error };
}

// ---- rig ------------------------------------------------------------------

beforeAll(async () => {
  tmpRoot = await tmpRootFor("flow-rename-scenarios");
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Flow.init();
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  inngestSent.length = 0;
  published.length = 0;
  mirror.main = null;
  delete process.env.APPS_CONNECTED_REPO_PUSH;
  delete process.env.APPS_GITHUB_REMOTE_BASE;
  resetFreshenOnMissThrottle();
  members.clear();
  members.set(`${WS}:${OWNER}`, "owner");
  members.set(`${WS}:${ADMIN}`, "admin");
  members.set(`${WS}:${EDITOR}`, "member");
  members.set(`${WS}:${VIEWER}`, "viewer");
  await Promise.all([
    Flow.deleteMany({}),
    CdcEntityState.deleteMany({}),
    FlowExecution.deleteMany({}),
    WebhookEvent.deleteMany({}),
  ]);
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

// ---- the matrix: service entry points ------------------------------------

describe.each(ENTRIES)("entry point: %s", entry => {
  it("title only: name: rewritten in place, one commit touching one file, same stream", async () => {
    const row = await seedFlow("close-crm", "Close CRM");
    const before = await streamState(row._id);
    const commits = await commitCountOf(WS);
    const out = await renameVia(entry, {
      ref: "close-crm",
      title: "Close → BigQuery",
    });
    expect(out.error).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({
      id: before.id,
      aliasesAdded: [],
      after: { title: "Close → BigQuery", slug: "close-crm" },
    });
    expect(await commitCountOf(WS)).toBe(commits + 1);
    expect(await pathsTouchedBy(WS, await headOf(WS))).toEqual([
      "flows/close-crm.yml",
    ]);
    expect(await fileAtMain(WS, "flows/close-crm.yml")).toBe(
      flowYaml("Close CRM", "close-crm").replace(
        "name: Close CRM",
        "name: Close → BigQuery",
      ),
    );
    const after = await expectSameStream(before);
    expect(after).toMatchObject({
      slug: "close-crm",
      name: "Close → BigQuery",
      aliases: [],
    });
    expect(published.some(e => e.type === "flow.updated")).toBe(true);
    // The push sync that follows the mirror push changes nothing.
    expect(await syncFlowsFromRepo(WS, OWNER)).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 1,
    });
    await expectNoTeardownNoDuplicate();
  });

  it("slug only: git mv + alias in ONE commit; old slug resolves; same stream", async () => {
    const row = await seedFlow("close-crm", "Close CRM");
    await seedFlow("other", "Other");
    const before = await streamState(row._id);
    const commits = await commitCountOf(WS);
    const out = await renameVia(entry, { ref: "close-crm", slug: "crm-sync" });
    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({
      id: before.id,
      aliasesAdded: ["close-crm"],
      before: { slug: "close-crm" },
      after: { slug: "crm-sync", url: `/f/${before.id}` },
    });
    expect(await commitCountOf(WS)).toBe(commits + 1);
    // Nothing else touched: the two sides of the move, no other file.
    expect(await pathsTouchedBy(WS, await headOf(WS))).toEqual([
      "flows/close-crm.yml",
      "flows/crm-sync.yml",
    ]);
    expect(await pathsAtMain(WS, "flows")).toEqual([
      "flows/crm-sync.yml",
      "flows/other.yml",
    ]);
    expect(
      parseFlowFile((await fileAtMain(WS, "flows/crm-sync.yml")) ?? "")
        ?.aliases,
    ).toEqual(["close-crm"]);
    const after = await expectSameStream(before);
    expect(after).toMatchObject({ slug: "crm-sync", aliases: ["close-crm"] });
    expect(await resolves("close-crm")).toBe(before.id);
    expect(await resolves("crm-sync")).toBe(before.id);
    expect(await resolves(before.id)).toBe(before.id);
    // GET/list from git and the next push sync agree.
    expect((await loadLiveFlowById(WS, before.id))?.def.slug).toBe("crm-sync");
    expect(
      (await loadLiveFlows(WS)).map(l => [l.def.slug, String(l.id)]),
    ).toContainEqual(["crm-sync", before.id]);
    await syncFlowsFromRepo(WS, OWNER);
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });

  it("title + slug together: one commit", async () => {
    const row = await seedFlow("stripe", "Stripe");
    const before = await streamState(row._id);
    const commits = await commitCountOf(WS);
    const out = await renameVia(entry, {
      ref: before.id,
      title: "Stripe payments",
      slug: "stripe-payments",
    });
    expect(out.error).toBeUndefined();
    expect(await commitCountOf(WS)).toBe(commits + 1);
    const after = await expectSameStream(before);
    expect(after).toMatchObject({
      slug: "stripe-payments",
      name: "Stripe payments",
      aliases: ["stripe"],
    });
    await syncFlowsFromRepo(WS, OWNER);
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });

  it("rename back to the previous name: the current slug never sits among its own aliases", async () => {
    const row = await seedFlow("one", "One");
    const before = await streamState(row._id);
    expect((await renameVia(entry, { ref: "one", slug: "two" })).ok).toBe(true);
    // Its own old name is free for it (c): back to it.
    const back = await renameVia(entry, { ref: "two", slug: "one" });
    expect(back.error).toBeUndefined();
    expect(back.result?.aliasesAdded).toEqual(["two"]);
    const after = await expectSameStream(before);
    expect(after).toMatchObject({ slug: "one", aliases: ["two"] });
    expect(
      parseFlowFile((await fileAtMain(WS, "flows/one.yml")) ?? "")?.aliases,
    ).toEqual(["two"]);
    expect(await resolves("two")).toBe(before.id);
    await syncFlowsFromRepo(WS, OWNER);
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });

  it("onto (a) another flow's live slug and (b) another flow's old name: refused, nothing changes", async () => {
    const a = await seedFlow("a", "A");
    const b = await seedFlow("b", "B");
    expect((await renameVia(entry, { ref: "b", slug: "b-new" })).ok).toBe(true);
    const beforeA = await streamState(a._id);
    const commits = await commitCountOf(WS);
    for (const slug of ["b-new", "b"]) {
      const out = await renameVia(entry, { ref: "a", slug });
      expect(out.ok, `onto ${slug}`).toBe(false);
      if (entry === "rest") expect(out.status).toBe(409);
      expect(out.error).toMatch(
        slug === "b" ? /old name of flow "B"/ : /already the file name/,
      );
    }
    expect(await commitCountOf(WS)).toBe(commits);
    const afterA = await expectSameStream(beforeA);
    expect(afterA).toMatchObject({ slug: "a", aliases: [] });
    expect(await resolves("b")).toBe(String(b._id));
    await expectNoTeardownNoDuplicate();
  });

  it("twice quickly (a→b→c): every old name resolves; one commit each", async () => {
    const row = await seedFlow("a", "A");
    const before = await streamState(row._id);
    const commits = await commitCountOf(WS);
    expect((await renameVia(entry, { ref: "a", slug: "b" })).ok).toBe(true);
    expect((await renameVia(entry, { ref: "b", slug: "c" })).ok).toBe(true);
    expect(await commitCountOf(WS)).toBe(commits + 2);
    const after = await expectSameStream(before);
    expect(after).toMatchObject({ slug: "c", aliases: ["a", "b"] });
    for (const ref of ["a", "b", "c", before.id]) {
      expect(await resolves(ref), ref).toBe(before.id);
    }
    await syncFlowsFromRepo(WS, OWNER);
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });

  it("no-op (same title, same slug, padded ref): success, no commit, nothing touched", async () => {
    const row = await seedFlow("stripe", "Stripe");
    const before = await streamState(row._id);
    const commits = await commitCountOf(WS);
    for (const request of [
      { ref: "stripe", title: "Stripe" },
      { ref: "stripe", slug: "stripe" },
      { ref: `  ${before.id}  `, title: "  Stripe ", slug: " stripe" },
    ]) {
      const out = await renameVia(entry, request);
      expect(out.error, JSON.stringify(request)).toBeUndefined();
      expect(out.result?.commit).toBeUndefined();
      expect(out.result?.id).toBe(before.id);
      expect(out.result?.warnings.join(" ")).toMatch(/Nothing/);
    }
    expect(await commitCountOf(WS)).toBe(commits);
    expect(await expectSameStream(before)).toMatchObject({
      slug: "stripe",
      name: "Stripe",
    });
    await expectNoTeardownNoDuplicate();
  });

  it("a flow that was never synced (its file is at main, no row yet) is refused with the reason; nothing is committed", async () => {
    await seedFlow("synced", "Synced");
    await push({ "flows/git-only.yml": flowYaml("Git only", "git-only") });
    const commits = await commitCountOf(WS);
    const out = await renameVia(entry, { ref: "git-only", slug: "renamed" });
    expect(out.ok).toBe(false);
    if (entry === "rest") expect(out.status).toBe(409);
    expect(out.error).toMatch(/not synced yet|only in git/);
    expect(await commitCountOf(WS)).toBe(commits);
    expect(await fileAtMain(WS, "flows/renamed.yml")).toBeNull();
    // …while resolve still names it (the list shows it), and a no-op on it
    // is a no-op, not an error.
    expect((await resolveFlowRef({ workspaceId: WS }, "git-only"))?.via).toBe(
      "current",
    );
    const noop = await renameVia(entry, { ref: "git-only", slug: "git-only" });
    expect(noop.ok).toBe(true);
    // The id the list hands out for it resolves to it too.
    const listed = (await loadLiveFlows(WS)).find(
      l => l.def.slug === "git-only",
    );
    expect(await resolves(String(listed!.id))).toBe(String(listed!.id));
    await expectNoTeardownNoDuplicate();
  });

  it("an unknown ref is a 404, a ref of ANOTHER workspace's flow is unknown here", async () => {
    await seedFlow("mine", "Mine");
    const otherWs = WS;
    const foreign = await Flow.findOne({ workspaceId: otherWs, slug: "mine" });
    // A second workspace with the same names.
    WS = new Types.ObjectId().toString();
    members.set(`${WS}:${OWNER}`, "owner");
    await initRepo(repoDirFor(WS), { "README.md": "x\n" });
    await bindTestWorkspaceRepo(WS);
    await seedFlow("theirs", "Theirs");
    for (const ref of ["ghost", String(foreign!._id), "mine"]) {
      const out = await renameVia(entry, { ref, slug: "stolen" });
      expect(out.ok, ref).toBe(false);
      if (entry === "rest") expect(out.status).toBe(404);
    }
    // The other workspace is untouched.
    expect(
      (await Flow.findById(foreign!._id))?.slug,
      "foreign flow unchanged",
    ).toBe("mine");
    expect(await pathsAtMain(otherWs, "flows")).toEqual(["flows/mine.yml"]);
  });
});

// ---- the matrix: REST-only cells ------------------------------------------

describe("operations through the UI route", () => {
  it("case: another flow's slug in other case is not a slug (400); its title in other case is just a title", async () => {
    await seedFlow("billing", "Billing");
    const row = await seedFlow("invoices", "Invoices");
    const before = await streamState(row._id);
    const upper = await renameVia("rest", { ref: "invoices", slug: "Billing" });
    expect(upper.status).toBe(400);
    expect(upper.error).toMatch(/not a valid file name/);
    // Display names are not identities (create allows two "Stripe"s too).
    const title = await renameVia("rest", {
      ref: "invoices",
      title: "BILLING",
    });
    expect(title.ok).toBe(true);
    expect(await expectSameStream(before)).toMatchObject({
      slug: "invoices",
      name: "BILLING",
    });
    await expectNoTeardownNoDuplicate();
  });

  it("case: its own name in other case — a title change is a real change; the slug in other case is refused", async () => {
    const row = await seedFlow("close-crm", "Close CRM");
    const before = await streamState(row._id);
    const title = await renameVia("rest", {
      ref: "close-crm",
      title: "close crm",
    });
    expect(title.ok).toBe(true);
    expect(title.result?.commit).toMatch(/^[0-9a-f]{40}$/);
    const slug = await renameVia("rest", {
      ref: "close-crm",
      slug: "Close-CRM",
    });
    expect(slug.status).toBe(400);
    expect(await expectSameStream(before)).toMatchObject({
      slug: "close-crm",
      name: "close crm",
    });
  });

  it("nothing but the two owned values changes: comments on name:/aliases:, inside the alias list and on its items survive title + slug renames", async () => {
    const annotated = flowYaml("Close", "close").replace(
      "name: Close\n",
      [
        "name: Close  # shown in the sidebar",
        "aliases:  # every name it had",
        "  # from the 2025 migration",
        "  - close-legacy # v1",
        "",
      ].join("\n"),
    );
    await push({ "flows/close.yml": annotated });
    await syncFlowsFromRepo(WS, OWNER);
    const row = await Flow.findOne({ workspaceId: WS, slug: "close" });
    const out = await renameVia("rest", {
      ref: "close",
      title: "Close CRM",
      slug: "close-crm",
    });
    expect(out.error).toBeUndefined();
    expect(await fileAtMain(WS, "flows/close-crm.yml")).toBe(
      annotated
        .replace("name: Close  #", "name: Close CRM  #")
        .replace(
          "  - close-legacy # v1\n",
          "  - close-legacy # v1\n  - close\n",
        ),
    );
    expect((await Flow.findById(row!._id))?.aliases).toEqual([
      "close-legacy",
      "close",
    ]);
  });

  it("delete, then recreate at the old name: the new flow is a new id; the old id is gone, the old name names the new flow", async () => {
    // (Not the only flow: an EMPTY flows/ is read as "not adopted", never
    // as "everything deleted" — that guard is by design.)
    await seedFlow("keeper", "Keeper");
    const row = await seedFlow("old-flow", "Old");
    const oldId = String(row._id);
    // Delete (the user's act — this teardown is intended): file removed.
    await push({}, ["flows/old-flow.yml"]);
    await syncFlowsFromRepo(WS, OWNER);
    expect(await Flow.findById(oldId)).toBeNull();
    inngestSent.length = 0;
    // Recreated (another stream, another dataset) under the old name.
    await push({ "flows/old-flow.yml": flowYaml("Old reborn", "reborn") });
    await syncFlowsFromRepo(WS, OWNER);
    const reborn = await Flow.findOne({ workspaceId: WS, slug: "old-flow" });
    expect(reborn).not.toBeNull();
    // Its own id — never the deleted flow's (which a file-born flow's id,
    // derived from its file name, would otherwise be): the old /f/<id>
    // links, notification rules and webhook URL stay dead.
    expect(String(reborn!._id)).not.toBe(oldId);
    expect(reborn!.webhookConfig?.endpoint).not.toContain(oldId);
    expect(await resolves("old-flow")).toBe(String(reborn!._id));
    expect(await resolves(oldId)).toBeNull();
    expect(await loadLiveFlowById(WS, oldId)).toBeNull();
    expect(await CdcEntityState.countDocuments({ flowId: reborn!._id })).toBe(
      0,
    );
    await expectNoTeardownNoDuplicate();
  });
});

// ---- the matrix: laptop pushes --------------------------------------------

describe("entry point: laptop git mv + push", () => {
  async function laptop(): Promise<Laptop> {
    return Laptop.clone(WS, path.join(tmpRoot, "laptops"));
  }

  async function pushAndSync(l: Laptop) {
    const pushed = await l.push();
    expect(pushed.stderr).toBe("");
    expect(pushed.ok).toBe(true);
    return syncFlowsFromRepo(WS, EDITOR);
  }

  it("title only (edit name:)", async () => {
    const row = await seedFlow("hubspot", "HubSpot");
    const before = await streamState(row._id);
    const l = await laptop();
    await l.write(
      "flows/hubspot.yml",
      (await l.read("flows/hubspot.yml")).replace(
        "name: HubSpot",
        "name: HubSpot CRM",
      ),
    );
    await l.commit("retitle");
    const result = await pushAndSync(l);
    expect(result).toMatchObject({ created: 0, updated: 1 });
    expect(await expectSameStream(before)).toMatchObject({
      slug: "hubspot",
      name: "HubSpot CRM",
    });
    await expectNoTeardownNoDuplicate();
  });

  it("slug only (plain git mv): re-keyed in place, the old slug recorded and resolving", async () => {
    const row = await seedFlow("hubspot", "HubSpot");
    const before = await streamState(row._id);
    const l = await laptop();
    await l.mv("flows/hubspot.yml", "flows/hubspot-crm.yml");
    await l.commit("git mv");
    published.length = 0;
    const result = await pushAndSync(l);
    // Open flow stores are told, as after a rename through the service.
    expect(published.map(e => e.type)).toContain("flow.updated");
    expect(result.created).toBe(0);
    expect(await expectSameStream(before)).toMatchObject({
      slug: "hubspot-crm",
      aliases: ["hubspot"],
    });
    expect(await resolves("hubspot")).toBe(before.id);
    // The id GET/list handed out for the new file before the sync still
    // opens this flow.
    expect(
      String(
        (await loadLiveFlowById(WS, String(derivedFlowId(WS, "hubspot-crm"))))
          ?.id,
      ),
    ).toBe(before.id);
    await expectNoTeardownNoDuplicate();
  });

  it("title + slug (git mv + edit name:)", async () => {
    const row = await seedFlow("hubspot", "HubSpot");
    const before = await streamState(row._id);
    const l = await laptop();
    await l.mv("flows/hubspot.yml", "flows/crm.yml");
    await l.write(
      "flows/crm.yml",
      (await l.read("flows/crm.yml")).replace("name: HubSpot", "name: CRM"),
    );
    await l.commit("git mv + retitle");
    await pushAndSync(l);
    expect(await expectSameStream(before)).toMatchObject({
      slug: "crm",
      name: "CRM",
      aliases: ["hubspot"],
    });
    await expectNoTeardownNoDuplicate();
  });

  it("rename + a real edit in ONE commit (cron, a new entity, a comment): same stream", async () => {
    const row = await seedFlow("close", "Close");
    const before = await streamState(row._id);
    const l = await laptop();
    await l.mv("flows/close.yml", "flows/close-leads.yml");
    const edited = (await l.read("flows/close-leads.yml"))
      .replace("name: Close", "name: Close leads")
      .replace("cron: 0 3 * * *", "cron: 30 4 * * *")
      .replace(
        "    - entity: leads",
        [
          "    # opportunities added with the move",
          "    - entity: opportunities",
          "      partitionField: _syncedAt",
          "      partitionGranularity: day",
          "      enabled: true",
          "    - entity: leads",
        ].join("\n"),
      );
    await l.write("flows/close-leads.yml", edited);
    await l.commit("move + edit");
    await pushAndSync(l);
    const after = await expectSameStream(before);
    expect(after).toMatchObject({
      slug: "close-leads",
      name: "Close leads",
      backfillCron: "30 4 * * *",
      aliases: ["close"],
    });
    await expectNoTeardownNoDuplicate();
  });

  it("rename back (git mv a b, push; git mv b a, push)", async () => {
    const row = await seedFlow("one", "One");
    const before = await streamState(row._id);
    const l = await laptop();
    await l.mv("flows/one.yml", "flows/two.yml");
    await l.commit("one → two");
    await pushAndSync(l);
    await l.mv("flows/two.yml", "flows/one.yml");
    await l.commit("two → one");
    await pushAndSync(l);
    expect(await expectSameStream(before)).toMatchObject({
      slug: "one",
      aliases: ["two"],
    });
    expect(await resolves("two")).toBe(before.id);
    await expectNoTeardownNoDuplicate();
  });

  it("twice before one push (a→b, b→c in two commits): one re-key, same stream", async () => {
    const row = await seedFlow("a", "A");
    const before = await streamState(row._id);
    const l = await laptop();
    await l.mv("flows/a.yml", "flows/b.yml");
    await l.commit("a → b");
    await l.mv("flows/b.yml", "flows/c.yml");
    await l.commit("b → c");
    await pushAndSync(l);
    expect(await expectSameStream(before)).toMatchObject({
      slug: "c",
      aliases: ["a"],
    });
    await expectNoTeardownNoDuplicate();
  });

  it("onto a live name: git refuses the move; forced, it is a delete of one file and an edit of the other (reported, never a guess)", async () => {
    const a = await seedFlow("a", "A");
    const b = await seedFlow("b", "B");
    const l = await laptop();
    await expect(l.mv("flows/a.yml", "flows/b.yml")).rejects.toThrow(
      /destination exists/,
    );
    // Nothing was pushed: both streams are as they were.
    expect(await streamState(a._id)).toMatchObject({ slug: "a" });
    expect(await streamState(b._id)).toMatchObject({ slug: "b" });
    await expectNoTeardownNoDuplicate();
  });

  it("onto another flow's OLD name: current wins — the mover takes it, the old holder stops answering to it", async () => {
    const x = await seedFlow("x", "X");
    const a = await seedFlow("a", "A");
    expect((await renameVia("rest", { ref: "x", slug: "x2" })).ok).toBe(true);
    await syncFlowsFromRepo(WS, OWNER);
    expect(await resolves("x")).toBe(String(x._id));
    const beforeA = await streamState(a._id);
    const beforeX = await streamState(x._id);
    const l = await laptop();
    await l.mv("flows/a.yml", "flows/x.yml");
    await l.commit("a takes x");
    await pushAndSync(l);
    expect(await expectSameStream(beforeA)).toMatchObject({
      slug: "x",
      aliases: ["a"],
    });
    expect(await resolves("x")).toBe(String(a._id));
    const afterX = await expectSameStream(beforeX);
    expect(afterX.aliases).not.toContain("x");
    // …and when A moves on, its old name x is A's — not ambiguous, and
    // never handed back to X behind A's back.
    expect((await renameVia("rest", { ref: "x", slug: "a2" })).ok).toBe(true);
    await syncFlowsFromRepo(WS, OWNER);
    expect(await resolves("x")).toBe(String(a._id));
    await expectNoTeardownNoDuplicate();
  });

  it("move into a sub-folder (flows/team/a.yml): never a teardown — the flow is parked with the reason, and moving back restores it", async () => {
    await seedFlow("keeper", "Keeper");
    const row = await seedFlow("a", "A");
    const before = await streamState(row._id);
    const l = await laptop();
    await l.mv("flows/a.yml", "flows/team/a.yml");
    await l.commit("into a folder");
    const result = await pushAndSync(l);
    expect(result.deferred).toEqual([]);
    const parked = await expectSameStream(before);
    expect(parked.slug).toBe("a");
    const parkedRow = await Flow.findById(row._id);
    expect(parkedRow?.definitionInvalid?.reason).toMatch(/flows\/team\/a\.yml/);
    await expectNoTeardownNoDuplicate();
    // Back where flows live: the same stream again.
    await l.mv("flows/team/a.yml", "flows/a.yml");
    await l.commit("back");
    await pushAndSync(l);
    const back = await Flow.findById(row._id);
    expect(back?.definitionInvalid?.reason).toBeUndefined();
    await expectSameStream(before);
    await expectNoTeardownNoDuplicate();
  });

  it("copy (with aliases): the copy is a new flow that inherits no alias; the original keeps its old names", async () => {
    await push({
      "flows/orig.yml": flowYaml("Orig", "orig", "aliases: [legacy]"),
    });
    await syncFlowsFromRepo(WS, OWNER);
    const orig = await Flow.findOne({ workspaceId: WS, slug: "orig" });
    const l = await laptop();
    // A duplicate is edited to point somewhere else (a pure copy into the
    // same dataset would be a second stream into one destination by the
    // author's own hand — not something a rename produces).
    await l.write(
      "flows/orig-copy.yml",
      (await l.read("flows/orig.yml"))
        .replace("name: Orig", "name: Orig copy")
        .replace("schema: raw_orig", "schema: raw_orig_copy"),
    );
    await l.commit("copy");
    const result = await pushAndSync(l);
    expect(result.created).toBe(1);
    const copy = await Flow.findOne({ workspaceId: WS, slug: "orig-copy" });
    expect(String(copy!._id)).not.toBe(String(orig!._id));
    expect(copy!.aliases ?? []).toEqual([]);
    expect((await Flow.findById(orig!._id))?.aliases).toEqual(["legacy"]);
    expect(await resolves("legacy")).toBe(String(orig!._id));
    await expectNoTeardownNoDuplicate();
  });

  it("rename + retarget in one commit: with `aliases:` the author's word is honoured (same stream); without, it is another stream — the old one is not handed over", async () => {
    await seedFlow("keeper", "Keeper");
    const a = await seedFlow("a", "A");
    const beforeA = await streamState(a._id);
    const l = await laptop();
    await l.mv("flows/a.yml", "flows/a-eu.yml");
    await l.write(
      "flows/a-eu.yml",
      (await l.read("flows/a-eu.yml"))
        .replace("schema: raw_a", "schema: raw_a_eu")
        .replace("name: A", "name: A EU\naliases: [a]"),
    );
    await l.commit("move + retarget, with the old name");
    await pushAndSync(l);
    expect(await expectSameStream(beforeA)).toMatchObject({ slug: "a-eu" });
    // Without `aliases:`, a different destination is a different stream:
    // never paired by content, so the old row is not handed to it.
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    const b = await seedFlow("b", "B");
    const beforeB = await streamState(b._id);
    await l.pull();
    await l.mv("flows/b.yml", "flows/b-eu.yml");
    await l.write(
      "flows/b-eu.yml",
      (await l.read("flows/b-eu.yml")).replace(
        "schema: raw_b",
        "schema: raw_b_eu",
      ),
    );
    await l.commit("move + retarget, no old name");
    const pushed = await l.push();
    expect(pushed.ok).toBe(true);
    const result = await syncFlowsFromRepo(WS, EDITOR);
    const bEu = await Flow.findOne({ workspaceId: WS, slug: "b-eu" });
    expect(String(bEu!._id)).not.toBe(beforeB.id);
    expect(await CdcEntityState.countDocuments({ flowId: bEu!._id })).toBe(0);
    // The old stream's removal is the reconciler's (here deferred behind
    // the unverifiable mirror: the row and its state are kept, untouched).
    expect(result.deferred).toEqual(["b"]);
    expect(await expectSameStream(beforeB)).toMatchObject({ slug: "b" });
  });

  it("a push that touches no flow changes nothing (no-op)", async () => {
    const row = await seedFlow("stripe", "Stripe");
    const before = await streamState(row._id);
    const l = await laptop();
    await l.write("README.md", "y\n");
    await l.commit("docs");
    published.length = 0;
    expect(await pushAndSync(l)).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 1,
    });
    // Nothing changed: nobody is told to refetch.
    expect(published.map(e => e.type)).not.toContain("flow.updated");
    expect(await expectSameStream(before)).toMatchObject({ slug: "stripe" });
    await expectNoTeardownNoDuplicate();
  });

  it("a laptop holding the old tree: its push is refused (non-fast-forward), its edit then lands on the renamed file", async () => {
    const row = await seedFlow("orders", "Orders");
    const before = await streamState(row._id);
    const l = await laptop();
    // Meanwhile, in the UI: a rename.
    expect(
      (await renameVia("rest", { ref: "orders", slug: "orders-v2" })).ok,
    ).toBe(true);
    await l.write(
      "flows/orders.yml",
      (await l.read("flows/orders.yml")).replace(
        "cron: 0 3 * * *",
        "cron: 0 5 * * *",
      ),
    );
    await l.commit("edit the old file");
    const refused = await l.push();
    expect(refused.ok).toBe(false);
    expect(refused.stderr).toMatch(/rejected|fetch first|non-fast-forward/);
    await l.pull();
    const result = await pushAndSync(l);
    expect(result.created).toBe(0);
    expect(await pathsAtMain(WS, "flows")).toEqual(["flows/orders-v2.yml"]);
    expect(await expectSameStream(before)).toMatchObject({
      slug: "orders-v2",
      backfillCron: "0 5 * * *",
    });
    await expectNoTeardownNoDuplicate();
  });
});

// ---- roles ----------------------------------------------------------------

describe("roles", () => {
  it("UI route: owner, admin, editor and viewer may rename a flow (the flow write routes' rule: workspace access); a non-member may not", async () => {
    const row = await seedFlow("f", "F");
    const before = await streamState(row._id);
    let n = 0;
    for (const who of [OWNER, ADMIN, EDITOR, VIEWER]) {
      n++;
      const out = await renameVia(
        "rest",
        { ref: before.id, title: `F${n}` },
        who,
      );
      expect(out.status, who).toBe(200);
    }
    const stranger = await renameVia(
      "rest",
      { ref: before.id, title: "X" },
      STRANGER,
    );
    expect(stranger.status).toBe(403);
    expect((await streamState(before.id)).name).toBe("F4");
  });

  it("UI route: an API key or an MCP OAuth token is refused (they rename through rename_object)", async () => {
    const row = await seedFlow("f", "F");
    for (const authType of ["apiKey", "mcpOAuth"] as const) {
      auth.authType = authType;
      auth.user = { id: OWNER };
      const res = await objectsApp.request(
        `/api/workspaces/${WS}/objects/flow/rename`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref: String(row._id), title: "X" }),
        },
      );
      expect(res.status, authType).toBe(403);
    }
    expect((await Flow.findById(row._id))?.name).toBe("F");
  });

  it("MCP: a key with only `mcp query:read` may rename a flow (no extra grant, as the flow tools); so may the agent of a viewer", async () => {
    const row = await seedFlow("f", "F");
    const viaMcp = await mcpCall(
      { kind: "flow", ref: String(row._id), slug: "f-renamed" },
      { userId: EDITOR, memberRole: "member", scopes: ["mcp", "query:read"] },
    );
    expect(viaMcp.isError).toBe(false);
    expect(JSON.parse(viaMcp.text)).toMatchObject({
      success: true,
      id: String(row._id),
    });
    const viaTool = await renameVia(
      "tool",
      { ref: "f-renamed", title: "F!" },
      VIEWER,
    );
    expect(viaTool.ok).toBe(true);
    expect(await streamState(row._id)).toMatchObject({
      slug: "f-renamed",
      name: "F!",
    });
  });

  it("resolve: members read it; a non-member gets 403; it never answers for another workspace", async () => {
    const row = await seedFlow("f", "F");
    await renameVia("rest", { ref: "f", slug: "g" });
    const url = (ref: string, ws = WS) =>
      `/api/workspaces/${ws}/objects/resolve?kind=flow&ref=${encodeURIComponent(ref)}`;
    for (const who of [OWNER, VIEWER]) {
      const res = await rest("GET", url("f"), who);
      expect(res.status, who).toBe(200);
      expect(res.json.resolved).toMatchObject({
        id: String(row._id),
        via: "alias",
        current: { slug: "g", url: `/f/${row._id}` },
      });
    }
    expect((await rest("GET", url("f"), STRANGER)).status).toBe(403);
    // A member of THIS workspace asking about another workspace's flow by
    // id, by slug, or through the other workspace's URL.
    const other = new Types.ObjectId().toString();
    expect((await rest("GET", url("f", other), OWNER)).status).toBe(403);
    const mine = WS;
    WS = other;
    members.set(`${WS}:${OWNER}`, "owner");
    await initRepo(repoDirFor(WS), { "README.md": "x\n" });
    await bindTestWorkspaceRepo(WS);
    for (const ref of [String(row._id), "g", "f"]) {
      expect((await rest("GET", url(ref), OWNER)).status, ref).toBe(404);
    }
    WS = mine;
  });
});

// ---- links ----------------------------------------------------------------

describe("links", () => {
  it("old URL → current; after the old name is reused → the newcomer; the renamed flow keeps its /f/<id>", async () => {
    const row = await seedFlow("foo", "Foo");
    await renameVia("rest", { ref: "foo", slug: "bar" });
    expect(
      (await resolveFlowRef({ workspaceId: WS }, "foo"))?.current.url,
    ).toBe(`/f/${row._id}`);
    // A NEW flow takes the old name (another stream).
    await push({ "flows/foo.yml": flowYaml("Foo again", "foo-again") });
    await syncFlowsFromRepo(WS, OWNER);
    const newcomer = await Flow.findOne({ workspaceId: WS, slug: "foo" });
    expect(String(newcomer!._id)).not.toBe(String(row._id));
    expect(await resolves("foo")).toBe(String(newcomer!._id));
    expect(await resolves(String(row._id))).toBe(String(row._id));
    expect((await loadLiveFlowById(WS, String(row._id)))?.def.slug).toBe("bar");
    await expectNoTeardownNoDuplicate();
  });

  it("an ambiguous old URL (two files claim one old name, no row holds it) resolves to nothing", async () => {
    await push({
      "flows/p.yml": flowYaml("P", "p", "aliases: [shared-old]"),
      "flows/q.yml": flowYaml("Q", "q", "aliases: [shared-old]"),
    });
    await syncFlowsFromRepo(WS, OWNER);
    // The sync gives an alias to at most one row; with neither row holding
    // it (cleared here), the files alone are two claimants.
    await Flow.updateMany({ workspaceId: WS }, { $unset: { aliases: 1 } });
    expect(await resolves("shared-old")).toBeNull();
    const res = await rest(
      "GET",
      `/api/workspaces/${WS}/objects/resolve?kind=flow&ref=shared-old`,
      OWNER,
    );
    expect(res.status).toBe(404);
  });

  it("the same names in two workspaces never interfere", async () => {
    const wsA = WS;
    const a = await seedFlow("shared", "Shared A");
    const wsB = new Types.ObjectId().toString();
    WS = wsB;
    members.set(`${WS}:${OWNER}`, "owner");
    await initRepo(repoDirFor(WS), { "README.md": "x\n" });
    await bindTestWorkspaceRepo(WS);
    const b = await seedFlow("shared", "Shared B");
    const beforeB = await streamState(b._id);
    WS = wsA;
    expect((await renameVia("rest", { ref: "shared", slug: "moved" })).ok).toBe(
      true,
    );
    await syncFlowsFromRepo(wsA, OWNER);
    WS = wsB;
    await syncFlowsFromRepo(wsB, OWNER);
    expect(await expectSameStream(beforeB)).toMatchObject({
      slug: "shared",
      aliases: [],
    });
    expect(await resolves("shared")).toBe(String(b._id));
    expect(await resolves("moved")).toBeNull();
    expect(await pathsAtMain(wsB, "flows")).toEqual(["flows/shared.yml"]);
    WS = wsA;
    expect(await resolves("shared")).toBe(String(a._id));
  });
});
