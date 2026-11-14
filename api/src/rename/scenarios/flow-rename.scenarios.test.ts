/**
 * Renaming a FLOW, end to end: real git (a bare workspace repo, a laptop
 * clone, a `file://` mirror, a second instance's clone) and real Mongo.
 *
 * The invariant every scenario holds a rename to: the stream is the SAME
 * stream. Same id, CDC checkpoints, executions, webhook events, inbound
 * URL, secret and provider subscription, schedules and their claims;
 * nothing torn down, nothing re-provisioned, no second stream on the same
 * target.
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
import { Hono } from "hono";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.mock("../../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
const hooks = vi.hoisted(() => ({
  /** Runs once, after the next freshen that precedes a write to main. */
  afterFreshen: null as null | (() => Promise<void>),
  /** Runs once, before the next commit on main (after its caller's reads). */
  beforeCommit: null as null | (() => Promise<void>),
  queuedPushes: 0,
  events: [] as string[],
}));
const once = (key: "afterFreshen" | "beforeCommit") => {
  const fn = hooks[key];
  hooks[key] = null;
  return fn ? fn() : Promise.resolve();
};
vi.mock("../../apps/cloud-repo.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/cloud-repo.service")>();
  return {
    ...actual,
    // Held, never run: "the mirror does not have the commit yet" is then a
    // state a test can stay in. A test lands the push with `mirrorPushNow`.
    queueMirrorPush: () => {
      hooks.queuedPushes++;
    },
    freshenBeforeMainWrite: async (workspaceId: string) => {
      await actual.freshenBeforeMainWrite(workspaceId);
      await once("afterFreshen");
    },
  };
});
vi.mock("../../apps/repository.service", async importOriginal => {
  const actual =
    await importOriginal<typeof import("../../apps/repository.service")>();
  return {
    ...actual,
    commitBlobsOnBranch: async (
      ...args: Parameters<typeof actual.commitBlobsOnBranch>
    ) => {
      await once("beforeCommit");
      return actual.commitBlobsOnBranch(...args);
    },
  };
});
vi.mock("../../inngest/client", () => ({
  inngest: {
    send: vi.fn(async (event: { name: string } | { name: string }[]) => {
      hooks.events.push(...[event].flat().map(e => e.name));
    }),
    createFunction: vi.fn(() => ({})),
  },
}));
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("../../auth/unified-auth.middleware", () => ({
  unifiedAuthMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("authType", "session");
    c.set("user", { id: "owner1" });
    await next();
  },
  isSessionAuth: () => true,
}));
vi.mock("../../services/workspace.service", () => ({
  workspaceService: {
    hasAccess: vi.fn(async () => true),
    getMember: vi.fn(async () => ({ role: "owner" })),
    hasRole: vi.fn(async () => true),
  },
}));

import {
  CdcEntityState,
  Flow,
  FlowExecution,
  RetiredObjectId,
  WebhookEvent,
} from "../../database/workspace-schema";
import { checkFlowFiles } from "../../agent-lib/tools/flow-file-tools";
import { createFlowSyncTools } from "../../agent-lib/tools/flow-sync-tools";
import { bindTestWorkspaceRepo } from "../../apps/bind-test-workspace-repo";
import { mirrorPushNow } from "../../apps/cloud-repo.service";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
} from "../../apps/repository.service";
import { flowRoutes } from "../../routes/flows";
import { reserveFlowSlug } from "../../services/flow-identity.service";
import { commitFlowFile } from "../../services/flow-config.service";
import {
  ensureFlowDerivedCache,
  isFlowMarkedInvalid,
  loadLiveFlowById,
  loadLiveFlows,
  syncFlowsFromRepo,
} from "../../services/flow-sync.service";
import { renameObject, resolveObjectRef } from "../registry";
import { RenameError } from "../types";
import {
  Laptop,
  commitCountOf,
  fileAtMain,
  headOf,
  mirrorMain,
  pathsAtMain,
  pathsTouchedBy,
  seedMirror,
  tmpRootFor,
} from "./scenario-rig";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let remotesRoot: string;
let WS: string;
const CONNECTOR = new Types.ObjectId().toString();
const DEST = new Types.ObjectId().toString();
const LAST_RESYNC = new Date("2026-09-30T03:00:00.000Z");
const ctx = () => ({ workspaceId: WS, userId: "owner1", role: "owner" });

/** A CDC flow file as master writes it today (format 2: `live`, `resync`). */
function flowYaml(name: string, tag: string, extra?: string): string {
  return [
    `name: ${name}`,
    ...(extra ? [extra] : []),
    "source:",
    "  type: connector",
    `  connection_id: ${CONNECTOR}`,
    "destination:",
    `  connection_id: ${DEST}`,
    "  table:",
    `    schema: raw_${tag}`,
    "    create_if_not_exists: true",
    "live:",
    "  poll: '*/15 * * * *'",
    "  timezone: UTC",
    "  webhook: 'on'",
    `  provider_webhook_id: we_${tag}`,
    "resync:",
    "  cron: 0 3 * * *",
    "  timezone: UTC",
    "sync:",
    "  mode: incremental",
    "  write_mode: append_dedup",
    "entities:",
    "  layouts:",
    "    - entity: leads",
    "      partitionField: _syncedAt",
    "      partitionGranularity: day",
    "      enabled: true",
    "",
  ].join("\n");
}

/**
 * Another definition for the same source and destination, in the older
 * format and with other triggers and entities: nothing git would call a
 * rename of `flowYaml(name, tag)`.
 */
function recreatedYaml(name: string, tag: string, extra?: string): string {
  return [
    `name: ${name}`,
    ...(extra ? [extra] : []),
    "type: scheduled",
    "destination:",
    "  table:",
    "    create_if_not_exists: true",
    `    schema: raw_${tag}`,
    `  connection_id: ${DEST}`,
    "source:",
    `  connector_id: ${CONNECTOR}`,
    "  type: connector",
    "schedule:",
    "  timezone: Europe/Zurich",
    "  cron: 5 * * * *",
    "entities:",
    "  layouts:",
    "    - entity: invoices",
    "      partitionField: created",
    "      partitionGranularity: month",
    "      enabled: true",
    "    - entity: leads",
    "      partitionField: created",
    "      partitionGranularity: month",
    "      enabled: true",
    "sync:",
    "  engine: cdc",
    "  write_mode: append_dedup",
    "  mode: incremental",
    "",
  ].join("\n");
}

async function push(writes: Record<string, string>, deletes: string[] = []) {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes, deletes },
    { message: "laptop push" },
  );
}

/** A synced flow with a life behind it: checkpoints, a run, an event, a secret. */
async function seedFlow(
  slug: string,
  name = slug,
  tag = slug,
  contents = flowYaml(name, tag),
) {
  await push({ [`flows/${slug}.yml`]: contents });
  await syncFlowsFromRepo(WS, "owner1");
  const row = await Flow.findOne({ workspaceId: WS, slug });
  expect(row, `seeded ${slug}`).not.toBeNull();
  const ids = { workspaceId: new Types.ObjectId(WS), flowId: row!._id };
  await CdcEntityState.create({
    ...ids,
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
    ...ids,
    startedAt: new Date(),
    status: "completed",
    success: true,
  });
  await WebhookEvent.create({
    ...ids,
    eventId: `evt_${slug}`,
    eventType: "lead.created",
    status: "completed",
    rawPayload: { id: 1 },
    applyStatus: "applied",
  });
  await Flow.updateOne(
    { _id: row!._id },
    {
      $set: {
        "webhookConfig.secret": "whsec_scenario",
        "backfillSchedule.lastRunAt": LAST_RESYNC,
      },
    },
  );
  hooks.events.length = 0;
  return (await Flow.findById(row!._id))!;
}

/** Everything a rename must leave exactly as it was. */
async function stream(id: Types.ObjectId | string) {
  const row = await Flow.findById(id).lean();
  expect(row, `flow ${String(id)} still exists`).not.toBeNull();
  const flowId = new Types.ObjectId(String(id));
  return {
    id: String(row!._id),
    endpoint: row!.webhookConfig?.endpoint,
    secret: row!.webhookConfig?.secret,
    subscription: row!.webhookConfig?.providerWebhookId,
    webhookOn: row!.webhookConfig?.enabled,
    poll: row!.schedule?.cron,
    resync: row!.backfillSchedule?.cron,
    resyncClaim: row!.backfillSchedule?.lastRunAt?.toISOString(),
    checkpoint: (await CdcEntityState.findOne({ flowId }).lean())
      ?.lastIngestSeq,
    executions: await FlowExecution.countDocuments({ flowId }),
    webhookEvents: await WebhookEvent.countDocuments({ flowId }),
  };
}

/** No teardown, no provider call, and no two flows on one target. */
async function expectUntouched(before: Awaited<ReturnType<typeof stream>>) {
  expect(await stream(before.id)).toEqual(before);
  expect(before.checkpoint).toBe(42);
  expect(hooks.events).toEqual([]);
  const schemas = (await Flow.find({ workspaceId: WS }).lean()).map(
    row => row.tableDestination?.schema,
  );
  expect(new Set(schemas).size, `one flow per target: ${schemas}`).toBe(
    schemas.length,
  );
}

const slugOf = async (id: Types.ObjectId | string) =>
  (await Flow.findById(id).lean())?.slug;
const resolves = async (ref: string) =>
  (await resolveObjectRef(ctx(), "flow", ref))?.id ?? null;
const rename = (request: { ref: string; title?: string; slug?: string }) =>
  renameObject(ctx(), "flow", request);
const refused = async (run: Promise<unknown>) => {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RenameError);
  return (error as RenameError).status;
};

const flowsApp = new Hono();
flowsApp.route("/api/workspaces/:workspaceId/flows", flowRoutes);
const flowsApi = (id: unknown, method: string, body?: unknown) =>
  flowsApp.request(`/api/workspaces/${WS}/flows/${String(id)}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  tmpRoot = await tmpRootFor("flow-rename-scenarios");
  remotesRoot = path.join(tmpRoot, "remotes");
  // Offline and instant: a freshen with no mirror there fails locally.
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${remotesRoot}`;
  delete process.env.APPS_REQUIRE_CONNECTED_REPO;
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
  Object.assign(hooks, { afterFreshen: null, beforeCommit: null });
  hooks.queuedPushes = 0;
  hooks.events.length = 0;
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "instance-a");
  delete process.env.APPS_CONNECTED_REPO_PUSH;
  await fs.rm(remotesRoot, { recursive: true, force: true });
  await Promise.all([
    Flow.deleteMany({}),
    CdcEntityState.deleteMany({}),
    FlowExecution.deleteMany({}),
    WebhookEvent.deleteMany({}),
    RetiredObjectId.deleteMany({}),
  ]);
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

describe("renaming through the service", () => {
  it("title + slug: one commit moves the file and lists the old name; the row is re-keyed in place", async () => {
    const annotated = flowYaml("Close", "close", "owner: data-team # ours")
      .replace("name: Close", "name: Close # shown in the sidebar")
      .concat("# keep me\n");
    const row = await seedFlow("close", "Close", "close", annotated);
    const before = await stream(row._id);
    const commits = await commitCountOf(WS);

    const result = await rename({
      ref: "close",
      title: "Close CRM",
      slug: "close-crm",
    });

    expect(result).toMatchObject({
      id: before.id,
      aliasesAdded: ["close"],
      warnings: [],
      before: { slug: "close", path: "flows/close.yml" },
      after: {
        title: "Close CRM",
        slug: "close-crm",
        path: "flows/close-crm.yml",
        url: `/f/${before.id}`,
      },
    });
    expect(await commitCountOf(WS)).toBe(commits + 1);
    expect(await pathsTouchedBy(WS, result.commit!)).toEqual([
      "flows/close-crm.yml",
      "flows/close.yml",
    ]);
    // Only the two lines a rename owns changed: comments and a key the
    // parser does not model are still there.
    expect(await fileAtMain(WS, "flows/close-crm.yml")).toBe(
      annotated.replace(
        "name: Close # shown in the sidebar",
        "name: Close CRM # shown in the sidebar\naliases:\n  - close",
      ),
    );
    await expectUntouched(before);
    const after = await Flow.findById(before.id).lean();
    expect(after).toMatchObject({
      slug: "close-crm",
      name: "Close CRM",
      aliases: ["close"],
      lastRenameCommit: result.commit,
    });
    // id, then the current slug, then the old one.
    for (const ref of [before.id, "close-crm", "close"]) {
      expect(await resolves(ref)).toBe(before.id);
    }
    expect((await resolveObjectRef(ctx(), "flow", "close"))?.via).toBe("alias");
    // The sync tools take the old slug as well.
    const { flow_read } = createFlowSyncTools({
      workspaceId: WS,
    }) as unknown as {
      flow_read: { execute: (input: { flow: string }) => Promise<unknown> };
    };
    expect(await flow_read.execute({ flow: "close" })).toMatchObject({
      success: true,
      id: before.id,
    });
    // The same request again: nothing to do, and no commit.
    const again = await rename({ ref: before.id, slug: "close-crm" });
    expect(again.commit).toBeUndefined();
    expect(await commitCountOf(WS)).toBe(commits + 1);
  });

  it("old names: never the current one, the newest 24, and a live name always wins", async () => {
    await seedFlow("keeper");
    const row = await seedFlow("a");
    await rename({ ref: "a", slug: "b" });
    await rename({ ref: "b", slug: "a" });
    expect((await Flow.findById(row._id).lean())?.aliases).toEqual(["b"]);
    for (let i = 1; i <= 26; i++) {
      await rename({ ref: String(row._id), slug: `n${i}` });
    }
    const aliases = (await Flow.findById(row._id).lean())?.aliases ?? [];
    // b, a, n1 … n25 were left behind: the newest 24 are kept.
    expect(aliases).toEqual(Array.from({ length: 24 }, (_, i) => `n${i + 2}`));
    expect(await fileAtMain(WS, "flows/n26.yml")).toContain("  - n25\n");
    // Dropped names resolve to nothing, never to another flow.
    for (const dropped of ["b", "a", "n1"]) {
      expect(await resolves(dropped)).toBeNull();
    }
    expect(await resolves("n10")).toBe(String(row._id));

    // Another flow's current name or old name is refused; nothing changes.
    expect(await refused(rename({ ref: "keeper", slug: "n26" }))).toBe(409);
    expect(await refused(rename({ ref: "keeper", slug: "n10" }))).toBe(409);

    // A NEW flow pushed at an old name has it while it exists...
    await push({ "flows/n10.yml": flowYaml("Newcomer", "newcomer") });
    const gitOnly = await resolves("n10");
    expect(gitOnly).not.toBe(String(row._id));
    await syncFlowsFromRepo(WS, "owner1");
    const newcomer = await Flow.findOne({ workspaceId: WS, slug: "n10" });
    expect(String(newcomer?._id)).toBe(gitOnly);
    expect(await resolves("n10")).toBe(gitOnly);
    // ...and the old name is the renamed flow's again once it is gone.
    await push({}, ["flows/n10.yml"]);
    await syncFlowsFromRepo(WS, "owner1");
    expect(await resolves("n10")).toBe(String(row._id));

    // An old name two flows claim is nobody's.
    await Flow.updateOne({ slug: "keeper" }, { $set: { aliases: ["n11"] } });
    expect(await resolves("n11")).toBeNull();

    // The renamed flow was born from flows/a.yml and keeps the id derived
    // from that name; a new flows/a.yml is another flow with its own id.
    await push({ "flows/a.yml": flowYaml("Another a", "another") });
    expect(await syncFlowsFromRepo(WS, "owner1")).toMatchObject({
      created: 1,
      invalid: [],
    });
    const another = await Flow.findOne({ workspaceId: WS, slug: "a" });
    expect(another).not.toBeNull();
    expect(String(another?._id)).not.toBe(String(row._id));
    expect(await slugOf(row._id)).toBe("n26");
  });

  it("names YAML would read as a number, a date or a boolean stay strings", async () => {
    const row = await seedFlow("a");
    const before = await stream(row._id);
    const chain = ["2026", "true", "no", "012", "2026-10-06", "1e3"];
    for (const slug of chain) {
      const result = await rename({ ref: before.id, slug, title: slug });
      expect(result.after).toMatchObject({ slug, title: slug });
    }
    const file = await fileAtMain(WS, "flows/1e3.yml");
    expect(file).toContain("name: '1e3'");
    expect(file).toContain("  - '2026'\n  - 'true'\n  - 'no'\n  - '012'");
    expect((await Flow.findById(before.id).lean())?.aliases).toEqual([
      "a",
      ...chain.slice(0, -1),
    ]);
    for (const old of chain.slice(0, -1)) {
      expect(await resolves(old)).toBe(before.id);
    }
    await syncFlowsFromRepo(WS, "owner1");
    await expectUntouched(before);
  });

  it("refuses what it cannot do, with the status, and changes nothing", async () => {
    const row = await seedFlow("a");
    await push({ "flows/only-git.yml": flowYaml("Only git", "onlygit") });
    const commits = await commitCountOf(WS);
    const cases: Array<[Record<string, string>, number]> = [
      [{ ref: "a", slug: "Not A Slug" }, 400],
      [{ ref: "a", slug: "con" }, 400], // a Windows device name
      [{ ref: "a", slug: "0123456789abcdef01234567" }, 400], // reads as an id
      [{ ref: "a", title: "x".repeat(201) }, 400],
      [{ ref: "a", title: "two\nlines" }, 400],
      [{ ref: "a", slug: "only-git" }, 409], // a file at main, not synced yet
      [{ ref: "only-git", title: "Renamed" }, 409],
      [{ ref: "nothing-here", title: "Renamed" }, 404],
    ];
    for (const [request, status] of cases) {
      expect(
        await refused(rename(request as { ref: string })),
        JSON.stringify(request),
      ).toBe(status);
    }
    expect(await commitCountOf(WS)).toBe(commits);
    expect(await slugOf(row._id)).toBe("a");
    // Creation never mints such a file name either.
    expect(await reserveFlowSlug(WS, "CON")).toBe("con-2");
    // The editor's own name field: refused, never cut short.
    const res = await flowsApi(row._id, "PUT", { name: "x".repeat(201) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "The name is longer than 200 characters.",
    });
    expect((await Flow.findById(row._id).lean())?.name).toBe("a");
  });

  it("a committed rename whose row update fails: success with a warning, a retry is a no-op, the next read converges", async () => {
    await seedFlow("keeper");
    const row = await seedFlow("a");
    const before = await stream(row._id);
    const commits = await commitCountOf(WS);
    const failOnce = () =>
      vi.spyOn(Flow, "updateOne").mockRejectedValueOnce(new Error("away"));
    let failing = failOnce();
    const result = await rename({ ref: "a", slug: "b" });
    failing.mockRestore();
    expect(result.commit).toBeDefined();
    expect(result.warnings).toEqual([
      `The rename is committed (${result.commit!.slice(0, 8)}), but the flow's record could not be updated just now; it catches up on the next read or sync, with the same id. Retrying is safe.`,
    ]);
    expect(await slugOf(row._id)).toBe("a");

    const retry = await rename({ ref: before.id, slug: "b" });
    expect(retry.commit).toBeUndefined();
    expect(await commitCountOf(WS)).toBe(commits + 1);
    expect(await slugOf(row._id)).toBe("b");

    // The same failure, left to a read: the list pairs the row with the
    // file that names it and re-keys it.
    failing = failOnce();
    await rename({ ref: "b", slug: "c" });
    failing.mockRestore();
    expect(await slugOf(row._id)).toBe("b");
    const live = await loadLiveFlowById(WS, before.id);
    expect(live?.row?.slug).toBe("c");
    expect(live?.def.slug).toBe("c");
    await syncFlowsFromRepo(WS, "owner1");
    await expectUntouched(before);
    expect((await Flow.findById(before.id).lean())?.aliases).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("a rename made on a laptop and pushed", () => {
  it("a plain `git mv`, a move with an edit and `aliases:`, and a copy + delete are each re-keyed in place", async () => {
    await seedFlow("keeper");
    const row = await seedFlow("a");
    const before = await stream(row._id);
    const laptop = await Laptop.clone(WS, tmpRoot);

    // GIT: the file moved, nothing else.
    await laptop.mv("flows/a.yml", "flows/b.yml");
    await laptop.push("mv a b");
    const first = await syncFlowsFromRepo(WS, "owner1");
    expect(first).toMatchObject({ created: 0, deferred: [] });
    expect(await slugOf(row._id)).toBe("b");
    expect(await resolves("a")).toBe(before.id);

    // ALIAS: moved AND edited past git's similarity; the file says where
    // it came from.
    await laptop.rm("flows/b.yml");
    await laptop.write(
      "flows/c.yml",
      flowYaml("Rewritten", "a", "aliases: [b]").replace(
        "write_mode: append_dedup",
        "write_mode: append_dedup\n  batch_size: 500",
      ),
    );
    await laptop.push("mv b c + edit");
    expect((await syncFlowsFromRepo(WS, "owner1")).created).toBe(0);
    expect(await Flow.findById(row._id).lean()).toMatchObject({
      slug: "c",
      name: "Rewritten",
      aliases: ["b", "a"],
      batchSize: 500,
    });

    // IDENTICAL: the same definition under another name and title.
    const moved = (await laptop.read("flows/c.yml")).replace(
      "name: Rewritten",
      "name: Copied over",
    );
    await laptop.rm("flows/c.yml");
    await laptop.write("flows/d.yml", moved.replace("aliases: [b]\n", ""));
    await laptop.push("copy c d, delete c");
    expect((await syncFlowsFromRepo(WS, "owner1")).created).toBe(0);
    expect(await slugOf(row._id)).toBe("d");
    for (const old of ["a", "b", "c"]) {
      expect(await resolves(old)).toBe(before.id);
    }
    await expectUntouched(before);
  });

  it("two candidates are never guessed: the flow is torn down and both files are new flows", async () => {
    await seedFlow("keeper");
    const row = await seedFlow("a");
    const laptop = await Laptop.clone(WS, tmpRoot);
    const contents = await laptop.read("flows/a.yml");
    await laptop.rm("flows/a.yml");
    await laptop.write("flows/b.yml", contents);
    await laptop.write("flows/c.yml", contents);
    await laptop.push("a became b and c");
    const result = await syncFlowsFromRepo(WS, "owner1");
    expect(result.created).toBe(2);
    expect(await Flow.findById(row._id)).toBeNull();
    expect(hooks.events).toContain("flow.cancel");
  });

  it("delete + recreate with the same target is a teardown and a create; `aliases:` makes it a rename", async () => {
    await seedFlow("keeper");
    const old = await seedFlow("stripe", "Stripe", "stripe");
    const recreated = recreatedYaml("Stripe v2", "stripe");
    const change = {
      files: [{ path: "flows/stripe-v2.yml", contents: recreated }],
      deletedPaths: ["flows/stripe.yml"],
    };

    // Asked before the push, the checker says what it would do and how to
    // make it a rename instead.
    const check = await checkFlowFiles({ workspaceId: WS, ...change });
    expect(check.wouldTeardown).toEqual(["stripe"]);
    expect(check.wouldCreate).toEqual(["stripe-v2"]);
    expect(check.notes.join("\n")).toContain(
      "`stripe` would be torn down and `stripe-v2` created with the same source and destination",
    );
    expect(check.notes.join("\n")).toContain("aliases: [stripe]");

    await push({ [change.files[0].path]: recreated }, change.deletedPaths);
    const result = await syncFlowsFromRepo(WS, "owner1");
    expect(result).toMatchObject({ created: 1, deferred: [] });
    // Another flow: a new id, the old one gone with its checkpoints (so
    // the new one backfills), its subscription removed.
    expect(await Flow.findById(old._id)).toBeNull();
    expect(hooks.events).toEqual(
      expect.arrayContaining(["flow.cancel", "flow.webhook.unsubscribe"]),
    );
    const fresh = await Flow.findOne({ workspaceId: WS, slug: "stripe-v2" });
    expect(String(fresh!._id)).not.toBe(String(old._id));
    expect(await CdcEntityState.countDocuments({ flowId: fresh!._id })).toBe(0);
    expect(await CdcEntityState.countDocuments({ flowId: old._id })).toBe(0);

    // The same push with the old name listed: the same flow, re-keyed.
    const kept = await seedFlow("close", "Close", "close");
    const before = await stream(kept._id);
    const renamed = recreatedYaml("Close v2", "close", "aliases: [close]");
    const aliased = await checkFlowFiles({
      workspaceId: WS,
      files: [{ path: "flows/close-v2.yml", contents: renamed }],
      deletedPaths: ["flows/close.yml"],
    });
    expect(aliased.wouldTeardown).toEqual([]);
    expect(aliased.wouldCreate).toEqual([]);
    expect(aliased.notes.join("\n")).toContain(
      "`close` would be renamed to `close-v2` in place",
    );
    await push({ "flows/close-v2.yml": renamed }, ["flows/close.yml"]);
    expect((await syncFlowsFromRepo(WS, "owner1")).created).toBe(0);
    expect(await slugOf(kept._id)).toBe("close-v2");
    expect(await stream(kept._id)).toMatchObject({
      id: before.id,
      checkpoint: 42,
      endpoint: before.endpoint,
      secret: before.secret,
      executions: 1,
      resyncClaim: before.resyncClaim,
    });
    expect(hooks.events).not.toContain("flow.webhook.unsubscribe");
  });
});

describe("another instance, before the mirror has the rename", () => {
  const INSTANCE_B = () => path.join(tmpRoot, `instance-b-${WS}`);
  const onInstanceA = () =>
    (process.env.APPS_GIT_ROOT = path.join(tmpRoot, "instance-a"));
  const onInstanceB = () => (process.env.APPS_GIT_ROOT = INSTANCE_B());

  /** Two flows on instance A, a mirror that has them, and B level with it. */
  async function twoInstances() {
    await seedFlow("keeper");
    const row = await seedFlow("a");
    process.env.APPS_CONNECTED_REPO_PUSH = "allow";
    await seedMirror(WS, remotesRoot);
    onInstanceB();
    expect(await syncFlowsFromRepo(WS, "owner1")).toMatchObject({
      created: 0,
      unchanged: 2,
    });
    onInstanceA();
    return { row, before: await stream(row._id) };
  }

  it("the rename answers without waiting for the mirror push", async () => {
    const { before } = await twoInstances();
    const mirrorBefore = await mirrorMain(remotesRoot);
    const result = await rename({ ref: "a", slug: "b" });
    expect(result.warnings).toEqual([]);
    // Queued like every other write to main, and not run by the request.
    expect(hooks.queuedPushes).toBe(1);
    expect(await mirrorMain(remotesRoot)).toBe(mirrorBefore);
    expect(await headOf(WS)).toBe(result.commit);
    await expectUntouched(before);
  });

  it("a tree that predates the rename tears nothing down, creates nothing, and still serves and runs the flow", async () => {
    const { row, before } = await twoInstances();
    const result = await rename({ ref: "a", slug: "b" });

    // Instance B: its main IS the mirror's main, so the reconciler's
    // "verified against the mirror" check passes. Only the rename guard
    // stands between this tree and a teardown plus a second stream.
    onInstanceB();
    const stale = await syncFlowsFromRepo(WS, "owner1");
    expect(stale).toMatchObject({ created: 0, deferred: [], invalid: [] });
    expect(await headOf(WS)).not.toBe(result.commit);
    await expectUntouched(before);
    expect(await slugOf(row._id)).toBe("b");
    const listed = await loadLiveFlows(WS);
    expect(listed.map(item => String(item.id)).sort()).toEqual(
      (await Flow.find({ workspaceId: WS }).lean())
        .map(flow => String(flow._id))
        .sort(),
    );
    expect((await loadLiveFlowById(WS, before.id))?.row?.slug).toBe("b");
    const current = (await Flow.findById(row._id))!;
    expect(await ensureFlowDerivedCache(current)).toBe("ok");
    expect(isFlowMarkedInvalid((await Flow.findById(row._id))!)).toBe(false);
    // A save or a delete here would write or strand a file: both wait.
    current.batchSize = 250;
    expect(await commitFlowFile(current, "owner1")).toMatchObject({
      ok: false,
      conflict: true,
    });
    expect((await flowsApi(row._id, "DELETE")).status).toBe(409);
    expect(await pathsAtMain(WS, "flows")).toEqual([
      "flows/a.yml",
      "flows/keeper.yml",
    ]);
    await expectUntouched(before);

    // The push lands; B fetches it on its next sync and is level.
    onInstanceA();
    await mirrorPushNow(WS);
    expect(await mirrorMain(remotesRoot)).toBe(result.commit);
    onInstanceB();
    expect(await syncFlowsFromRepo(WS, "owner1")).toMatchObject({
      created: 0,
      deferred: [],
    });
    expect(await headOf(WS)).toBe(result.commit);
    expect((await loadLiveFlowById(WS, before.id))?.def.slug).toBe("b");
    await expectUntouched(before);
  });

  it("a rename whose commit never reaches the mirror is undone in place once the guard expires", async () => {
    const { row, before } = await twoInstances();
    await rename({ ref: "a", slug: "b", title: "Renamed" });
    await Flow.updateOne(
      { _id: row._id },
      { $set: { lastRenameAt: new Date(Date.now() - 11 * 60 * 1000) } },
    );
    onInstanceB();
    const result = await syncFlowsFromRepo(WS, "owner1");
    expect(result).toMatchObject({ created: 0, deferred: [] });
    expect(await Flow.findById(row._id).lean()).toMatchObject({
      slug: "a",
      name: "a",
    });
    await expectUntouched(before);
  });
});

describe("races", () => {
  const deleteFlow = (id: unknown) => flowsApi(id, "DELETE");

  it("a rename that lands while a DELETE is in flight: the delete follows it, and the flow stays gone", async () => {
    await seedFlow("keeper");
    const row = await seedFlow("doomed");
    // The delete has read the row (slug `doomed`); the rename lands before
    // the delete looks at the file.
    hooks.afterFreshen = async () => {
      await rename({ ref: "doomed", slug: "moved" });
    };
    expect((await deleteFlow(row._id)).status).toBe(200);
    expect(await pathsAtMain(WS, "flows")).toEqual(["flows/keeper.yml"]);
    await syncFlowsFromRepo(WS, "owner1");
    expect((await Flow.find({ workspaceId: WS })).map(r => r.slug)).toEqual([
      "keeper",
    ]);
    expect(await resolves(String(row._id))).toBeNull();
  });

  it("a rename that lands between a DELETE's read of the file and its commit: the delete is refused, the flow is whole", async () => {
    await seedFlow("keeper");
    const row = await seedFlow("doomed");
    const before = await stream(row._id);
    hooks.beforeCommit = async () => {
      await rename({ ref: "doomed", slug: "moved" });
    };
    const res = await deleteFlow(row._id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("nothing was deleted"),
    });
    await syncFlowsFromRepo(WS, "owner1");
    expect(await slugOf(row._id)).toBe("moved");
    await expectUntouched(before);
  });

  it("a DELETE that lands while a rename is in flight: the rename is refused, the flow stays gone and its id is never reused", async () => {
    await seedFlow("keeper");
    const row = await seedFlow("doomed");
    // The rename has read the row and the file; the delete lands before
    // its commit.
    hooks.beforeCommit = async () => {
      expect((await deleteFlow(row._id)).status).toBe(200);
    };
    expect(await refused(rename({ ref: "doomed", slug: "moved" }))).toBe(409);
    expect(await pathsAtMain(WS, "flows")).toEqual(["flows/keeper.yml"]);
    await syncFlowsFromRepo(WS, "owner1");
    expect(await Flow.findById(row._id)).toBeNull();

    // Recreated at the old name: another flow, with another id and URL.
    await push({ "flows/doomed.yml": flowYaml("Reborn", "reborn") });
    const listedAs = (await loadLiveFlows(WS)).find(
      item => item.def.slug === "doomed",
    )!.id;
    await syncFlowsFromRepo(WS, "owner1");
    const reborn = await Flow.findOne({ workspaceId: WS, slug: "doomed" });
    expect(String(reborn!._id)).not.toBe(String(row._id));
    expect(String(reborn!._id)).toBe(String(listedAs));
    expect(reborn!.webhookConfig?.endpoint).not.toContain(String(row._id));
    expect(await resolves(String(row._id))).toBeNull();
  });

  it("a rename and an editor save: whichever is second is refused; never two files, never a second stream", async () => {
    await seedFlow("keeper");
    const row = await seedFlow("a");
    const before = await stream(row._id);

    // The save read the row, then the rename landed.
    const stale = (await Flow.findById(row._id))!;
    stale.batchSize = 250;
    hooks.afterFreshen = async () => {
      await rename({ ref: "a", slug: "b" });
    };
    expect(await commitFlowFile(stale, "owner1")).toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(await pathsAtMain(WS, "flows")).toEqual([
      "flows/b.yml",
      "flows/keeper.yml",
    ]);

    // The rename read the file, then a save landed.
    const editing = (await Flow.findById(row._id))!;
    editing.batchSize = 500;
    hooks.beforeCommit = async () => {
      hooks.beforeCommit = null;
      expect(await commitFlowFile(editing, "owner1")).toMatchObject({
        ok: true,
        changed: true,
      });
    };
    expect(await refused(rename({ ref: "b", slug: "c" }))).toBe(409);
    expect(await pathsAtMain(WS, "flows")).toEqual([
      "flows/b.yml",
      "flows/keeper.yml",
    ]);
    expect((await syncFlowsFromRepo(WS, "owner1")).created).toBe(0);
    expect(await slugOf(row._id)).toBe("b");
    await expectUntouched(before);
  });
});
