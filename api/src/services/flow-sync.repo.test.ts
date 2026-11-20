/**
 * `syncFlowsFromRepo` against a real repo and a real Mongoose model.
 *
 * The existing `flow-sync.test.ts` asserts on the module's SOURCE TEXT. That
 * is how a create path that had never once worked stayed green: `createdBy`
 * is required on `FlowSchema`, `new Flow({ workspaceId, slug })` never set
 * it, and `save()` threw a ValidationError that escaped the per-file loop —
 * so the first NEW `flows/<slug>.yml` anyone pushed created no row, skipped
 * every file after it, skipped the reconciler, and logged one WARN. Every
 * production verification had been of EXISTING flows, where the row already
 * carried a `createdBy` from the UI.
 *
 * So these cases drive the real function: a bare repo, a commit on main, a
 * memory Mongo, and assertions on what rows exist afterwards.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { MongoMemoryReplSet } from "mongodb-memory-server";

vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
vi.mock("../inngest/client", () => ({
  inngest: { send: vi.fn(async () => undefined) },
}));

import {
  DatabaseConnection,
  Flow,
  SourceConnection,
  WebhookEvent,
} from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  initRepo,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../apps/repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../apps/bind-test-workspace-repo";
import {
  derivedFlowId,
  ensureFlowDerivedCache,
  isFlowMarkedInvalid,
  liveFlowToPlain,
  loadLiveFlowById,
  loadLiveFlows,
  resolveLiveFlowRow,
  syncFlowsFromRepo,
  type InternalBindingGuard,
} from "./flow-sync.service";
import { flowToFile } from "./flow-config-files";
import { isCronDue } from "./cron-due";
import { BigQueryDestinationAdapter } from "../sync-cdc/adapters/bigquery";
import {
  closeInlineWebhookAdmission,
  retainClosedInlineWebhook,
} from "../sync-cdc/inline-webhook-admission";

let mongo: MongoMemoryReplSet;
let tmpRoot: string;
let WS: string;

const CONNECTOR = new Types.ObjectId().toString();
const DEST = new Types.ObjectId().toString();

/** A complete, loadable CDC flow in the on-disk (snake_case) format. */
function flowYaml(name: string, extra = ""): string {
  return [
    `name: ${name}`,
    "type: webhook",
    "source:",
    "  type: connector",
    `  connector_id: ${CONNECTOR}`,
    "destination:",
    `  connection_id: ${DEST}`,
    "  table:",
    "    schema: raw_close",
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

async function push(writes: Record<string, string>): Promise<void> {
  await commitBlobsOnBranch(
    repoDirFor(WS),
    DEFAULT_BRANCH,
    { writes },
    { message: "laptop push" },
  );
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-sync-repo-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

/** The connections a flow file names, in workspace `ws`. */
async function seedConnections(
  ws: string,
  ids: { source: string; dest: string },
): Promise<void> {
  const workspaceId = new Types.ObjectId(ws);
  await SourceConnection.collection.insertOne({
    _id: new Types.ObjectId(ids.source),
    workspaceId,
    name: "Close",
    type: "close",
  } as any);
  await DatabaseConnection.collection.insertOne({
    _id: new Types.ObjectId(ids.dest),
    workspaceId,
    name: "Warehouse",
    type: "bigquery",
  } as any);
}

beforeEach(async () => {
  WS = new Types.ObjectId().toString();
  await Flow.deleteMany({});
  await SourceConnection.collection.deleteMany({});
  await DatabaseConnection.collection.deleteMany({});
  await seedConnections(WS, { source: CONNECTOR, dest: DEST });
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

describe("retained delivery binding contract", () => {
  it.each(["repo sync", "cache refresh"] as const)(
    "%s keeps the full effective definition across reload and stale refresh",
    async writer => {
      const nextSource = new Types.ObjectId();
      await SourceConnection.collection.insertOne({
        _id: nextSource,
        workspaceId: new Types.ObjectId(WS),
        name: "Second source",
        type: "close",
      } as never);
      const oldFile = flowYaml("Original");
      const desiredFile = flowYaml("Desired")
        .replace(CONNECTOR, nextSource.toString())
        .replace("entity: leads", "entity: contacts")
        .replace("write_mode: append_dedup", "write_mode: append");
      await push({ "flows/binding.yml": oldFile });
      await syncFlowsFromRepo(WS, "user-42");
      const stale = await Flow.findOne({ workspaceId: WS, slug: "binding" });
      expect(stale).not.toBeNull();
      await WebhookEvent.create({
        flowId: stale!._id,
        workspaceId: WS,
        eventId: "retained-1",
        eventType: "lead.updated",
        status: "dormant",
        applyStatus: "dormant",
        dataSourceId: CONNECTOR,
        rawPayload: { id: "lead-1" },
      });
      const effective = (row: typeof stale) => ({
        definition: row ? flowToFile(row) : null,
        sourceBlobSha: row?.sourceBlobSha,
      });
      const prior = effective(stale);
      await push({ "flows/binding.yml": desiredFile });
      if (writer === "repo sync") {
        await syncFlowsFromRepo(WS, "user-42", {});
      } else {
        await ensureFlowDerivedCache(stale!, {});
      }
      const reloaded = await Flow.findById(stale!._id);
      expect
        .soft(effective(reloaded), "effective definition after reload")
        .toEqual(prior);
      const head = await resolveCommit(
        repoDirFor(WS),
        `refs/heads/${DEFAULT_BRANCH}`,
      );
      const desired = await readBlob(
        repoDirFor(WS),
        head!,
        "flows/binding.yml",
      );
      expect
        .soft(desired.contents, "desired revision remains observable in Git")
        .toBe(desiredFile);
      expect
        .soft(
          blobOid(desired.contents),
          "desired revision differs from effective revision",
        )
        .not.toBe(reloaded?.sourceBlobSha);
      const stored = await Flow.collection.findOne({ _id: stale!._id });
      expect
        .soft(
          (stored as unknown as { bindingApply?: { desiredBlobSha?: string } })
            .bindingApply?.desiredBlobSha,
        )
        .toBe(blobOid(desiredFile));
      await ensureFlowDerivedCache(stale!, {});
      const afterStale = await Flow.findById(stale!._id);
      expect
        .soft(
          effective(afterStale),
          "stale refresh preserves effective definition",
        )
        .toEqual(prior);
      expect
        .soft(
          await WebhookEvent.countDocuments({
            flowId: stale!._id,
            status: "dormant",
          }),
        )
        .toBe(1);
      await push({ "flows/binding.yml": oldFile });
      await ensureFlowDerivedCache(afterStale!, {});
      const reverted = await Flow.collection.findOne({ _id: stale!._id });
      expect(
        (reverted as unknown as { bindingApply?: { desiredBlobSha?: string } })
          .bindingApply?.desiredBlobSha,
      ).toBeUndefined();
    },
  );
});

describe("guarded preflight and failures", () => {
  it("guarded repo sync refuses a new flow with a mismatching layout", async () => {
    const spy = vi
      .spyOn(BigQueryDestinationAdapter.prototype, "describeLiveTable")
      .mockResolvedValue({
        exists: true,
        timePartitioning: { field: "date_created", type: "DAY" },
        clusterFields: [],
      });
    try {
      const file = flowYaml("New mismatch").replace(
        "  table:\n",
        `  table:\n    connection_id: ${DEST}\n`,
      );
      await push({ "flows/new-mismatch.yml": file });
      const result = await syncFlowsFromRepo(WS, "user-42", {});
      expect(result.invalid).toEqual(["new-mismatch"]);
      expect(
        await Flow.findOne({ workspaceId: WS, slug: "new-mismatch" }),
      ).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["repo", "cache"] as const)(
    "a newer layout refusal stops older %s and keeps pending",
    async olderWriter => {
      const withTable = (name: string) =>
        flowYaml(name).replace(
          "  table:\n",
          `  table:\n    connection_id: ${DEST}\n`,
        );
      const nextSource = new Types.ObjectId();
      await SourceConnection.collection.insertOne({
        _id: nextSource,
        workspaceId: new Types.ObjectId(WS),
        name: "Next",
        type: "close",
      } as never);
      const spy = vi
        .spyOn(BigQueryDestinationAdapter.prototype, "describeLiveTable")
        .mockResolvedValue({ exists: false, clusterFields: [] });
      try {
        const original = withTable("Original");
        await push({ "flows/refusal-order.yml": original });
        await syncFlowsFromRepo(WS, "user-42");
        const row = (await Flow.findOne({
          workspaceId: WS,
          slug: "refusal-order",
        }))!;
        const prior = flowToFile(row);
        await WebhookEvent.create({
          flowId: row._id,
          workspaceId: WS,
          eventId: "held-refusal",
          eventType: "lead.updated",
          status: "dormant",
          applyStatus: "dormant",
          dataSourceId: CONNECTOR,
          rawPayload: { id: "lead-1" },
        });
        spy.mockResolvedValue({
          exists: true,
          timePartitioning: { field: "_syncedAt", type: "DAY" },
          clusterFields: [],
        });
        const pending = withTable("Pending").replace(
          CONNECTOR,
          nextSource.toString(),
        );
        await push({ "flows/refusal-order.yml": pending });
        await ensureFlowDerivedCache(row, {});
        await push({ "flows/refusal-order.yml": withTable("Older valid") });
        let release!: () => void;
        let read!: () => void;
        const paused = new Promise<void>(resolve => {
          read = resolve;
        });
        const resume = new Promise<void>(resolve => {
          release = resolve;
        });
        const guard = {
          afterCandidateRead: async () => {
            read();
            await resume;
          },
        };
        const older =
          olderWriter === "repo"
            ? syncFlowsFromRepo(WS, "user-42", guard)
            : ensureFlowDerivedCache(row, guard);
        try {
          await paused;
          const refused = withTable("Newer refused").replace(
            "partitionGranularity: day",
            "partitionGranularity: hour",
          );
          await push({ "flows/refusal-order.yml": refused });
          if (olderWriter === "repo") await ensureFlowDerivedCache(row, {});
          else await syncFlowsFromRepo(WS, "user-42", {});
          const head = await resolveCommit(
            repoDirFor(WS),
            `refs/heads/${DEFAULT_BRANCH}`,
          );
          const observed = await Flow.collection.findOne({ _id: row._id });
          const state = (
            observed as unknown as {
              bindingApply?: {
                commit?: string;
                desiredBlobSha?: string;
                layoutRefusedBlobSha?: string;
              };
            }
          ).bindingApply;
          expect(state?.commit).toBe(head);
          expect(state?.desiredBlobSha).toBe(blobOid(pending));
          expect(state?.layoutRefusedBlobSha).toBe(blobOid(refused));
        } finally {
          release();
          await older;
        }
        const after = (await Flow.findById(row._id))!;
        expect(flowToFile(after)).toEqual(prior);
        expect(after.sourceBlobSha).toBe(blobOid(original));
        const stored = await Flow.collection.findOne({ _id: row._id });
        expect(
          (stored as unknown as { bindingApply?: { desiredBlobSha?: string } })
            .bindingApply?.desiredBlobSha,
        ).toBe(blobOid(pending));
      } finally {
        spy.mockRestore();
      }
    },
  );
  it.each(["repo", "cache"] as const)(
    "%s rechecks layout when its snapshot moves",
    async writer => {
      const withTable = (name: string) =>
        flowYaml(name).replace(
          "  table:\n",
          `  table:\n    connection_id: ${DEST}\n`,
        );
      const spy = vi
        .spyOn(BigQueryDestinationAdapter.prototype, "describeLiveTable")
        .mockResolvedValue({ exists: false, clusterFields: [] });
      try {
        const original = withTable("Original");
        await push({ "flows/layout-race.yml": original });
        await syncFlowsFromRepo(WS, "user-42");
        const row = (await Flow.findOne({
          workspaceId: WS,
          slug: "layout-race",
        }))!;
        spy.mockResolvedValue({
          exists: true,
          timePartitioning: { field: "date_created", type: "DAY" },
          clusterFields: [],
        });
        await push({ "flows/layout-race.yml": withTable("Desired") });
        let entered!: () => void;
        let release!: () => void;
        const paused = new Promise<void>(resolve => {
          entered = resolve;
        });
        const resume = new Promise<void>(resolve => {
          release = resolve;
        });
        const guard = {
          afterLayoutPreflight: async () => {
            entered();
            await resume;
          },
        };
        const applying =
          writer === "repo"
            ? syncFlowsFromRepo(WS, "user-42", guard)
            : ensureFlowDerivedCache(row, guard);
        try {
          await paused;
          await Flow.collection.updateOne(
            { _id: row._id },
            { $set: { "entityLayouts.0.partitionField": "date_created" } },
          );
        } finally {
          release();
          await applying;
        }
        const stored = await Flow.findById(row._id);
        expect(stored?.name).toBe("Original");
        expect(stored?.entityLayouts?.[0]?.partitionField).toBe("date_created");
        expect(stored?.sourceBlobSha).toBe(blobOid(original));
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each(["repo", "cache"] as const)(
    "%s keeps pending state after a transaction error",
    async writer => {
      const nextSource = new Types.ObjectId();
      await SourceConnection.collection.insertOne({
        _id: nextSource,
        workspaceId: new Types.ObjectId(WS),
        name: "Next",
        type: "close",
      } as never);
      const original = flowYaml("Original");
      const pending = flowYaml("Pending").replace(
        CONNECTOR,
        nextSource.toString(),
      );
      await push({ "flows/failure.yml": original });
      await syncFlowsFromRepo(WS, "user-42");
      const row = (await Flow.findOne({ workspaceId: WS, slug: "failure" }))!;
      await WebhookEvent.create({
        flowId: row._id,
        workspaceId: WS,
        eventId: "held-failure",
        eventType: "lead.updated",
        status: "dormant",
        applyStatus: "dormant",
        dataSourceId: CONNECTOR,
        rawPayload: { id: "lead-1" },
      });
      await push({ "flows/failure.yml": pending });
      await ensureFlowDerivedCache(row, {});
      const before = await Flow.collection.findOne({ _id: row._id });
      await push({
        "flows/failure.yml": pending.replace("name: Pending", "name: Newer"),
      });
      const guard = {
        beforeFlowWrite: async () => {
          throw new Error("injected transaction failure");
        },
      };
      const applying =
        writer === "repo"
          ? syncFlowsFromRepo(WS, "user-42", guard)
          : ensureFlowDerivedCache(row, guard);
      await expect(applying).rejects.toThrow("injected transaction failure");
      const after = await Flow.collection.findOne({ _id: row._id });
      expect(after?.definitionInvalid?.reason).toBeUndefined();
      expect(after?.sourceBlobSha).toBe(blobOid(original));
      expect(
        (after as unknown as { bindingApply?: unknown }).bindingApply,
      ).toEqual((before as unknown as { bindingApply?: unknown }).bindingApply);
    },
  );
});

describe("guarded Git candidate ordering", () => {
  it.each([
    ["repo", "invalid"],
    ["repo", "valid"],
    ["cache", "invalid"],
    ["cache", "valid"],
  ] as const)(
    "orders an older %s %s observation",
    async (writer, olderKind) => {
      await push({ "flows/invalid-order.yml": flowYaml("Original") });
      await syncFlowsFromRepo(WS, "user-42");
      const row = (await Flow.findOne({
        workspaceId: WS,
        slug: "invalid-order",
      }))!;
      await push({
        "flows/invalid-order.yml":
          olderKind === "invalid" ? "name: [broken" : flowYaml("Older valid"),
      });
      let release!: () => void;
      let read!: () => void;
      const paused = new Promise<void>(resolve => {
        read = resolve;
      });
      const resume = new Promise<void>(resolve => {
        release = resolve;
      });
      const guard = {
        afterCandidateRead: async () => {
          read();
          await resume;
        },
      };
      const older =
        writer === "repo"
          ? syncFlowsFromRepo(WS, "user-42", guard)
          : ensureFlowDerivedCache(row, guard);
      try {
        await paused;
        await push({
          "flows/invalid-order.yml":
            olderKind === "invalid"
              ? flowYaml("Newest valid")
              : "name: [broken",
        });
        if (writer === "repo") await ensureFlowDerivedCache(row, {});
        else await syncFlowsFromRepo(WS, "user-42", {});
      } finally {
        release();
        await older;
      }
      const stored = await Flow.findById(row._id);
      if (olderKind === "invalid") {
        expect(stored?.name).toBe("Newest valid");
        expect(isFlowMarkedInvalid(stored!)).toBe(false);
      } else {
        expect(stored?.name).toBe("Original");
        expect(stored?.definitionInvalid?.reason).toBe("unparseable flow file");
      }
    },
  );

  it("rebuilds a newer candidate from the row after an intervening apply", async () => {
    const original = flowYaml("Original");
    await push({ "flows/interleaved.yml": original });
    await syncFlowsFromRepo(WS, "user-42");
    const row = (await Flow.findOne({ workspaceId: WS, slug: "interleaved" }))!;
    await push({ "flows/interleaved.yml": flowYaml("Intervening") });
    let allowOlder!: () => void;
    let olderRead!: () => void;
    const olderPaused = new Promise<void>(resolve => {
      olderRead = resolve;
    });
    const olderResume = new Promise<void>(resolve => {
      allowOlder = resolve;
    });
    const older = syncFlowsFromRepo(WS, "user-42", {
      afterCandidateRead: async () => {
        olderRead();
        await olderResume;
      },
    });
    await olderPaused;
    const newest = original.replace(
      "write_mode: append_dedup",
      "write_mode: append",
    );
    await push({ "flows/interleaved.yml": newest });
    let allowNewer!: () => void;
    let newerRead!: () => void;
    const newerPaused = new Promise<void>(resolve => {
      newerRead = resolve;
    });
    const newerResume = new Promise<void>(resolve => {
      allowNewer = resolve;
    });
    const newer = ensureFlowDerivedCache(row, {
      afterRowRead: async () => {
        newerRead();
        await newerResume;
      },
    });
    try {
      await newerPaused;
      allowOlder();
      await older;
      expect((await Flow.findById(row._id))?.name).toBe("Intervening");
    } finally {
      allowOlder();
      allowNewer();
      await newer;
    }
    const stored = await Flow.findById(row._id);
    expect(stored?.name).toBe("Original");
    expect(stored?.writeMode).toBe("append");
    expect(stored?.sourceBlobSha).toBe(blobOid(newest));
  });
  it.each(["desired", "effective"] as const)(
    "rejects an older snapshot after a newer %s observation",
    async observation => {
      const sourceA = new Types.ObjectId();
      const sourceB = new Types.ObjectId();
      await SourceConnection.collection.insertMany(
        [sourceA, sourceB].map(_id => ({
          _id,
          workspaceId: new Types.ObjectId(WS),
          name: "Alternative",
          type: "close",
        })) as never,
      );
      await push({ "flows/ordered.yml": flowYaml("Original") });
      await syncFlowsFromRepo(WS, "user-42");
      const row = (await Flow.findOne({ workspaceId: WS, slug: "ordered" }))!;
      if (observation === "desired") {
        await WebhookEvent.create({
          flowId: row._id,
          workspaceId: WS,
          eventId: "retained-ordering",
          eventType: "lead.updated",
          status: "dormant",
          applyStatus: "dormant",
          dataSourceId: CONNECTOR,
          rawPayload: { id: "lead-1" },
        });
      }
      const older = flowYaml("Older").replace(CONNECTOR, sourceA.toString());
      const newer = flowYaml("Newer").replace(CONNECTOR, sourceB.toString());
      await push({ "flows/ordered.yml": older });
      let release!: () => void;
      let read!: () => void;
      const paused = new Promise<void>(resolve => {
        read = resolve;
      });
      const resume = new Promise<void>(resolve => {
        release = resolve;
      });
      const olderApply = syncFlowsFromRepo(WS, "user-42", {
        afterCandidateRead: async () => {
          read();
          await resume;
        },
      });
      try {
        await paused;
        await push({ "flows/ordered.yml": newer });
        await ensureFlowDerivedCache(row, {});
      } finally {
        release();
        await olderApply;
      }
      const { stdout } = await promisify(execFile)(process.execPath, [
        "-e",
        `const mongoose = require('mongoose');
        (async () => {
          const db = await mongoose.createConnection(process.argv[1]).asPromise();
          const row = await db.db.collection(process.argv[2]).findOne({ _id: new mongoose.Types.ObjectId(process.argv[3]) });
          process.stdout.write(JSON.stringify(row));
          await db.close();
        })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });`,
        mongo.getUri(),
        Flow.collection.collectionName,
        String(row._id),
      ]);
      const stored = JSON.parse(stdout) as {
        bindingApply?: { desiredBlobSha?: string };
        dataSourceId?: string;
        sourceBlobSha?: string;
      };
      expect(stored.bindingApply?.desiredBlobSha).toBe(
        observation === "desired" ? blobOid(newer) : undefined,
      );
      expect(stored.dataSourceId).toBe(
        observation === "desired" ? CONNECTOR : sourceB.toString(),
      );
      expect(stored.sourceBlobSha).toBe(
        observation === "desired"
          ? blobOid(flowYaml("Original"))
          : blobOid(newer),
      );
    },
  );
});

describe("transactional retained binding prototype", () => {
  it.each([
    ["retention", "repo"],
    ["retention", "cache"],
    ["replacement", "repo"],
    ["replacement", "cache"],
  ] as const)(
    "%s commits first against %s without accepting the wrong source",
    async (first, writer) => {
      const nextSource = new Types.ObjectId();
      await SourceConnection.collection.insertOne({
        _id: nextSource,
        workspaceId: new Types.ObjectId(WS),
        name: "Alternative",
        type: "close",
      } as never);
      const original = flowYaml("Original");
      const desired = flowYaml("Desired")
        .replace(CONNECTOR, nextSource.toString())
        .replace("write_mode: append_dedup", "write_mode: append");
      await push({ "flows/transactional.yml": original });
      await syncFlowsFromRepo(WS, "user-42");
      const row = (await Flow.findOne({
        workspaceId: WS,
        slug: "transactional",
      }))!;
      const priorDefinition = flowToFile(row);
      const scope = {
        workspaceId: new Types.ObjectId(WS),
        flowId: row._id,
        sourceConnectionId: new Types.ObjectId(CONNECTOR),
      };
      const workerA = await mongoose
        .createConnection(mongo.getUri())
        .asPromise();
      const workerB = await mongoose
        .createConnection(mongo.getUri())
        .asPromise();
      try {
        await closeInlineWebhookAdmission(workerA, scope);
        await push({ "flows/transactional.yml": desired });
        let entered!: () => void;
        let release!: () => void;
        const locked = new Promise<void>(resolve => {
          entered = resolve;
        });
        const resume = new Promise<void>(resolve => {
          release = resolve;
        });
        const hold = async () => {
          entered();
          await resume;
        };
        const delivery = {
          sourceConnectionId: scope.sourceConnectionId,
          eventId: "race-delivery",
          eventType: "lead.updated",
          rawPayload: { id: "lead-1" },
        };
        let admitted: "retained" | "duplicate" | undefined;
        let failure: unknown;
        const apply = (guard: InternalBindingGuard) =>
          writer === "repo"
            ? syncFlowsFromRepo(WS, "user-42", guard)
            : ensureFlowDerivedCache(row, guard);
        if (first === "retention") {
          const retaining = retainClosedInlineWebhook(
            workerA,
            scope,
            delivery,
            { afterFlowWrite: hold },
          );
          await locked;
          let candidateRead!: () => void;
          const candidate = new Promise<void>(resolve => {
            candidateRead = resolve;
          });
          const applying = apply({
            connection: workerB,
            beforeFlowWrite: async () => {
              candidateRead();
            },
          });
          await candidate;
          release();
          admitted = await retaining;
          await applying;
        } else {
          const applying = apply({
            connection: workerA,
            afterFlowWrite: hold,
          });
          await locked;
          let retentionReady!: () => void;
          const retentionAtWrite = new Promise<void>(resolve => {
            retentionReady = resolve;
          });
          const retaining = retainClosedInlineWebhook(
            workerB,
            scope,
            delivery,
            {
              beforeFlowWrite: async () => {
                retentionReady();
              },
            },
          ).then(
            value => {
              admitted = value;
            },
            error => {
              failure = error;
            },
          );
          await retentionAtWrite;
          release();
          await applying;
          await retaining;
        }
        const { stdout } = await promisify(execFile)(process.execPath, [
          "-e",
          `const mongoose = require('mongoose');
          (async () => {
            const db = await mongoose.createConnection(process.argv[1]).asPromise();
            const id = new mongoose.Types.ObjectId(process.argv[2]);
            const row = await db.db.collection('flows').findOne({ _id: id });
            const count = await db.db.collection('webhookevents').countDocuments({ flowId: id, eventId: 'race-delivery' });
            process.stdout.write(JSON.stringify({ row, count }));
            await db.close();
          })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });`,
          mongo.getUri(),
          String(row._id),
        ]);
        const { row: stored, count } = JSON.parse(stdout) as {
          row: {
            dataSourceId?: string;
            name?: string;
            writeMode?: string;
            sourceBlobSha?: string;
            bindingApply?: { desiredBlobSha?: string };
          };
          count: number;
        };
        if (first === "retention") {
          expect(admitted).toBe("retained");
          expect(count).toBe(1);
          expect(stored.dataSourceId).toBe(CONNECTOR);
          expect(flowToFile(Flow.hydrate(stored))).toEqual(priorDefinition);
          expect(stored.name).toBe("Original");
          expect(stored.writeMode).toBe("append_dedup");
          expect(stored.sourceBlobSha).toBe(blobOid(original));
          expect(stored.bindingApply?.desiredBlobSha).toBe(blobOid(desired));
        } else {
          expect(admitted).toBeUndefined();
          expect(failure).toBeInstanceOf(Error);
          expect(String(failure)).toContain("source no longer matches");
          expect(count).toBe(0);
          expect(stored.dataSourceId).toBe(nextSource.toString());
          expect(stored.sourceBlobSha).toBe(blobOid(desired));
        }
      } finally {
        await workerA.close();
        await workerB.close();
      }
    },
    30_000,
  );
});

describe("markers, reverts, and resolution", () => {
  it("an unset marker is not 'invalid': an unbound workspace's run is not refused", async () => {
    await push({ "flows/marker.yml": flowYaml("Marker") });
    await syncFlowsFromRepo(WS, "user-42");
    const row = await Flow.findOne({ workspaceId: WS, slug: "marker" });
    expect(row).not.toBeNull();
    // Mongoose materialises the unset nested path as `{}` on a hydrated
    // doc; `if (row.definitionInvalid)` used to read that as invalid.
    expect(isFlowMarkedInvalid(row!)).toBe(false);
    const plain = liveFlowToPlain(
      (await loadLiveFlows(WS)).find(item => item.def.slug === "marker")!,
      WS,
    );
    expect(plain.definitionInvalid).toBeUndefined();
    await unbindTestWorkspaceRepo(WS);
    expect(await ensureFlowDerivedCache(row!)).toBe("ok");
  });

  it("never serves half-defined incremental/conflict blocks", async () => {
    // Production files carry `conflict: { strategy }` with no key columns,
    // and rows keep an incremental cursor with no tracking column.
    await push({
      "flows/plain.yml": flowYaml("Plain", "conflict:\n  strategy: update\n"),
    });
    await syncFlowsFromRepo(WS, "user-42");
    await Flow.collection.updateOne(
      { slug: "plain" },
      { $set: { incrementalConfig: { lastValue: "2026-01-01" } } },
    );
    const plain = liveFlowToPlain(
      (await loadLiveFlows(WS)).find(item => item.def.slug === "plain")!,
      WS,
    );
    // The client's schema rejected these and dropped the whole flow list.
    expect(plain.incrementalConfig).toBeUndefined();
    expect(plain.conflictConfig).toEqual({
      keyColumns: [],
      strategy: "update",
    });
  });

  it("a broken file is marked once; reverting to identical content clears it in push-sync", async () => {
    const good = flowYaml("Revertable");
    await push({ "flows/revertable.yml": good });
    await syncFlowsFromRepo(WS, "user-42");
    await push({ "flows/revertable.yml": "name: [broken" });
    await loadLiveFlows(WS);
    const marked = await Flow.findOne({ workspaceId: WS, slug: "revertable" });
    expect(marked?.definitionInvalid?.reason).toBe("unparseable flow file");
    const at = marked?.definitionInvalid?.at;
    await loadLiveFlows(WS);
    expect(
      (await Flow.findOne({ workspaceId: WS, slug: "revertable" }))
        ?.definitionInvalid?.at,
    ).toEqual(at);
    await push({ "flows/revertable.yml": good });
    const result = await syncFlowsFromRepo(WS, "user-42");
    expect(result.invalid).toEqual([]);
    expect(
      (await Flow.findOne({ workspaceId: WS, slug: "revertable" }))
        ?.definitionInvalid?.reason,
    ).toBeUndefined();
  });

  it("resolves a git-only flow as 409, a synced one as ok, a deleted file as 404; the stub is whole", async () => {
    await push({ "flows/only-git.yml": flowYaml("Only git") });
    const live = await loadLiveFlows(WS);
    const id = live.find(item => item.def.slug === "only-git")!.id.toString();
    const gitOnly = await resolveLiveFlowRow(WS, id);
    expect(gitOnly.ok).toBe(false);
    if (!gitOnly.ok) expect(gitOnly.status).toBe(409);

    await syncFlowsFromRepo(WS, "user-42");
    const synced = await resolveLiveFlowRow(WS, id);
    expect(synced.ok).toBe(true);

    await commitBlobsOnBranch(
      repoDirFor(WS),
      DEFAULT_BRANCH,
      { deletes: ["flows/only-git.yml"] },
      { message: "laptop delete" },
    );
    const gone = await resolveLiveFlowRow(WS, id);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.status).toBe(404);

    await push({ "flows/broken-stub.yml": "name: [broken" });
    const stub = liveFlowToPlain(
      (await loadLiveFlows(WS)).find(item => item.def.slug === "broken-stub")!,
      WS,
    );
    expect(stub).toMatchObject({
      name: "broken-stub",
      syncMode: "full",
      enabled: false,
    });
    expect(stub.createdAt).toBeInstanceOf(Date);
    expect(
      (stub.definitionInvalid as { reason?: string } | undefined)?.reason,
    ).toBe("unparseable flow file");
  });
});

describe("a resync schedule runs first at its next tick", () => {
  it("set by a new file, changed by an edit, kept by an unrelated edit", async () => {
    const due = (row: { backfillSchedule?: any }) =>
      isCronDue({
        cron: row.backfillSchedule?.cron,
        timezone: row.backfillSchedule?.timezone,
        lastRunAt: row.backfillSchedule?.lastRunAt ?? null,
      });

    const t0 = Date.now();
    await push({ "flows/resync.yml": flowYaml("Resync") });
    await syncFlowsFromRepo(WS, "user-42");
    let row = await Flow.findOne({ workspaceId: WS, slug: "resync" }).lean();
    const born = row!.backfillSchedule!.lastRunAt!;
    expect(born.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(due(row!)).toBe(false);

    // Run it once, an hour ago.
    const ranAt = new Date(Date.now() - 3_600_000);
    await Flow.collection.updateOne(
      { slug: "resync" },
      { $set: { "backfillSchedule.lastRunAt": ranAt } },
    );

    // An edit that leaves the resync alone keeps its last run.
    await push({ "flows/resync.yml": flowYaml("Resync renamed") });
    await syncFlowsFromRepo(WS, "user-42");
    row = await Flow.findOne({ workspaceId: WS, slug: "resync" }).lean();
    expect(row!.name).toBe("Resync renamed");
    expect(row!.backfillSchedule!.lastRunAt).toEqual(ranAt);

    // Hourly, counted from the run an hour ago, is overdue at once. The
    // edit counts it from now instead.
    expect(isCronDue({ cron: "0 * * * *", lastRunAt: ranAt })).toBe(true);
    const t1 = Date.now();
    await push({
      "flows/resync.yml": flowYaml("Resync renamed").replace(
        "  cron: 0 3 * * *",
        "  cron: 0 * * * *",
      ),
    });
    await syncFlowsFromRepo(WS, "user-42");
    row = await Flow.findOne({ workspaceId: WS, slug: "resync" }).lean();
    expect(row!.backfillSchedule!.cron).toBe("0 * * * *");
    expect(row!.backfillSchedule!.lastRunAt!.getTime()).toBeGreaterThanOrEqual(
      t1 - 1000,
    );
    expect(
      isCronDue({
        cron: "0 * * * *",
        lastRunAt: row!.backfillSchedule!.lastRunAt!,
      }),
    ).toBe(false);
  });
});

describe("a NEW flow file creates a row", () => {
  it("through Mako's git endpoint, authored by whoever pushed", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });

    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.created).toBe(1);
    expect(result.invalid).toEqual([]);
    const row = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    expect(row).not.toBeNull();
    expect(row!.createdBy).toBe("user-42");
    // `type: webhook` in the file is retired: it means webhooks on, and the
    // row is never given a `type`.
    expect(row!.type).toBeUndefined();
    expect(row!.webhookConfig?.enabled).toBe(true);
    expect(row!._id.toString()).toBe(
      derivedFlowId(WS, "close-to-bigquery").toString(),
    );
    expect(row!.syncEngine).toBe("cdc");
    expect(row!.backfillSchedule?.enabled).toBe(true);
    expect(row!.backfillSchedule?.cron).toBe("0 3 * * *");
    // #939: a file-born webhook flow is addressable, and derives from the id.
    expect(row!.webhookConfig?.endpoint).toContain(`/${WS}/${row!._id}`);
    // …and never carries a secret from the file (that is a credential).
    expect(row!.webhookConfig?.secret).toBeFalsy();
  });

  it("from a push made directly on GitHub, with no actor to attribute", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });

    // routes/github.routes.ts calls syncRepoBackedResources(workspaceId) with
    // no userId — the webhook does not carry a Mako user.
    const result = await syncFlowsFromRepo(WS);

    expect(result.created).toBe(1);
    const row = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    // Same author the dbt job sync uses for the same situation.
    expect(row?.createdBy).toBe("sync");
  });

  it("is idempotent: the second sync of the same tree touches nothing", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    const again = await syncFlowsFromRepo(WS, "user-42");
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });
});

describe("one bad file is that file's problem", () => {
  it("a file that parses but cannot be saved does not stop the others", async () => {
    await push({
      // Sorted first by the tree walk, so it fails BEFORE the good one.
      "flows/a-bad-one.yml": flowYaml("Bad").replace(
        "write_mode: append_dedup",
        "write_mode: not_a_real_mode", // outside the schema enum → save() throws
      ),
      "flows/z-good-one.yml": flowYaml("Good"),
    });

    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.invalid).toEqual(["a-bad-one"]);
    expect(result.created).toBe(1);
    expect(await Flow.countDocuments({ workspaceId: WS })).toBe(1);
    expect(
      await Flow.findOne({ workspaceId: WS, slug: "z-good-one" }),
    ).not.toBeNull();
  });

  it("a layout that disagrees with its BigQuery table is refused, a missing table is not", async () => {
    const withTable = (name: string) =>
      flowYaml(name).replace(
        "  table:\n",
        `  table:\n    connection_id: ${DEST}\n`,
      );
    const spy = vi
      .spyOn(BigQueryDestinationAdapter.prototype, "describeLiveTable")
      .mockResolvedValue({
        exists: true,
        timePartitioning: { field: "date_created", type: "DAY" },
        clusterFields: [],
      });
    try {
      await push({ "flows/a-mismatch.yml": withTable("Mismatch") });
      const refused = await syncFlowsFromRepo(WS, "user-42");
      expect(refused.invalid).toEqual(["a-mismatch"]);
      expect(refused.created).toBe(0);

      spy.mockResolvedValue({ exists: false, clusterFields: [] });
      const accepted = await syncFlowsFromRepo(WS, "user-42");
      expect(accepted.invalid).toEqual([]);
      expect(accepted.created).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("an EXISTING flow is never paused or flagged for a layout mismatch", async () => {
    const withTable = (name: string) =>
      flowYaml(name).replace(
        "  table:\n",
        `  table:\n    connection_id: ${DEST}\n`,
      );
    const spy = vi
      .spyOn(BigQueryDestinationAdapter.prototype, "describeLiveTable")
      .mockResolvedValue({ exists: false, clusterFields: [] });
    try {
      await push({ "flows/live.yml": withTable("Live") });
      expect((await syncFlowsFromRepo(WS, "user-42")).created).toBe(1);

      // The table now exists, partitioned on another column.
      spy.mockResolvedValue({
        exists: true,
        timePartitioning: { field: "date_created", type: "DAY" },
        clusterFields: [],
      });

      // An edit that leaves the layout alone applies.
      await push({ "flows/live.yml": withTable("Live renamed") });
      const renamed = await syncFlowsFromRepo(WS, "user-42");
      expect(renamed.updated).toBe(1);
      expect(renamed.invalid).toEqual([]);

      // An edit to the mismatching layout is not applied. The flow keeps
      // its definition, its schedules and no marker.
      const edited = withTable("Live renamed").replace(
        "partitionGranularity: day",
        "partitionGranularity: hour",
      );
      await push({ "flows/live.yml": edited });
      const refused = await syncFlowsFromRepo(WS, "user-42");
      expect(refused.invalid).toEqual(["live"]);
      const row = await Flow.findOne({ workspaceId: WS, slug: "live" });
      expect(row?.name).toBe("Live renamed");
      expect(row?.entityLayouts?.[0]?.partitionGranularity).toBe("day");
      expect(row?.backfillSchedule?.enabled).toBe(true);
      expect(isFlowMarkedInvalid(row as never)).toBe(false);
      // The refusal shows in the view: a warning, not a pause.
      expect(row?.layoutWarnings?.[0]).toMatchObject({
        entity: "leads",
        refused: true,
        realValue: "date_created",
      });
      const plain = liveFlowToPlain(
        (await loadLiveFlows(WS)).find(f => f.def.slug === "live") as never,
        WS,
      );
      expect(plain.layoutWarnings).toHaveLength(1);
      expect(plain.definitionInvalid).toBeUndefined();

      // Reading the flow does not apply the refused layout either.
      expect(await ensureFlowDerivedCache(row as never)).toBe("ok");
      const after = await Flow.findOne({ workspaceId: WS, slug: "live" });
      expect(after?.entityLayouts?.[0]?.partitionGranularity).toBe("day");
      expect(after?.backfillSchedule?.enabled).toBe(true);
      expect(isFlowMarkedInvalid(after as never)).toBe(false);

      // Fixing the layout applies it and clears the warnings.
      await push({
        "flows/live.yml": withTable("Live renamed").replace(
          "partitionField: _syncedAt",
          "partitionField: date_created",
        ),
      });
      expect((await syncFlowsFromRepo(WS, "user-42")).invalid).toEqual([]);
      const fixed = await Flow.findOne({ workspaceId: WS, slug: "live" });
      expect(fixed?.entityLayouts?.[0]?.partitionField).toBe("date_created");
      expect(fixed?.layoutWarnings ?? []).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("a connector NAME where an id belongs is refused, not thrown", async () => {
    await push({
      "flows/a-by-name.yml": flowYaml("By name").replace(
        `connector_id: ${CONNECTOR}`,
        "connector_id: close", // not an ObjectId → new ObjectId() throws
      ),
      "flows/z-good-one.yml": flowYaml("Good"),
    });

    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.invalid).toEqual(["a-by-name"]);
    expect(result.created).toBe(1);
    expect(await Flow.countDocuments({ workspaceId: WS })).toBe(1);
  });

  it("a YAML typo in an EXISTING flow's file is a no-op, not a teardown", async () => {
    // The definition half always "kept the current row" for an unparseable
    // file. The stream half did not: the row was left out of the desired set,
    // the reconciler read that absence as a removal, and — guard permitting —
    // tore the flow down and disposed its checkpoints. So `deferred` is the
    // tell here: a reconciler that WANTS the removal but cannot verify the
    // tree reports it there; one that never wanted it reports nothing.
    await push({
      "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery"),
      "flows/other.yml": flowYaml("Other"),
    });
    await syncFlowsFromRepo(WS, "user-42");
    const before = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });

    await push({ "flows/close-to-bigquery.yml": "name: [broken\n" });
    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.invalid).toEqual(["close-to-bigquery"]);
    expect(result.deferred).toEqual([]);
    const after = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    expect(after).not.toBeNull();
    expect(after!.name).toBe(before!.name);
    expect(after!.sourceBlobSha).toBe(before!.sourceBlobSha);
    expect(after!.definitionInvalid?.reason).toMatch(/unparseable/i);
    expect(await Flow.countDocuments({ workspaceId: WS })).toBe(2);
  });

  it("a failed save on an EXISTING row keeps that row as it was", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    const before = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });

    await push({
      "flows/close-to-bigquery.yml": flowYaml("Renamed").replace(
        "write_mode: append_dedup",
        "write_mode: not_a_real_mode",
      ),
    });
    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.invalid).toEqual(["close-to-bigquery"]);
    const after = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    expect(after!.name).toBe(before!.name);
    expect(after!.writeMode).toBe(before!.writeMode);
    expect(after!.sourceBlobSha).toBe(before!.sourceBlobSha);
  });
});

describe("a flow names only its own workspace's connections", () => {
  const OTHER_WS = new Types.ObjectId().toString();
  const FOREIGN_SOURCE = new Types.ObjectId().toString();
  const FOREIGN_DEST = new Types.ObjectId().toString();
  beforeEach(async () => {
    await seedConnections(OTHER_WS, {
      source: FOREIGN_SOURCE,
      dest: FOREIGN_DEST,
    });
  });

  it("a NEW file naming another workspace's source creates no row", async () => {
    await push({
      "flows/a-foreign.yml": flowYaml("Foreign").replace(
        `connector_id: ${CONNECTOR}`,
        `connector_id: ${FOREIGN_SOURCE}`,
      ),
      "flows/z-good-one.yml": flowYaml("Good"),
    });

    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.invalid).toEqual(["a-foreign"]);
    expect(result.created).toBe(1);
    expect(
      await Flow.findOne({ workspaceId: WS, slug: "a-foreign" }),
    ).toBeNull();
  });

  it("an EXISTING flow pointed at another workspace's destination keeps its row", async () => {
    await push({ "flows/close.yml": flowYaml("Close") });
    await syncFlowsFromRepo(WS, "user-42");
    await push({
      "flows/close.yml": flowYaml("Close").replace(
        `connection_id: ${DEST}`,
        `connection_id: ${FOREIGN_DEST}`,
      ),
    });

    const result = await syncFlowsFromRepo(WS, "user-42");

    expect(result.invalid).toEqual(["close"]);
    const row = await Flow.findOne({ workspaceId: WS, slug: "close" });
    expect(String(row?.destinationDatabaseId)).toBe(DEST);
    expect(row?.definitionInvalid?.reason).toContain(
      `destination.connection_id: ${FOREIGN_DEST}`,
    );
  });

  it("GET/list shows a refused file invalid and never its foreign ids", async () => {
    await push({ "flows/close.yml": flowYaml("Close") });
    await syncFlowsFromRepo(WS, "user-42");
    await push({
      "flows/close.yml": flowYaml("Close").replace(
        `connection_id: ${DEST}`,
        `connection_id: ${FOREIGN_DEST}`,
      ),
      "flows/new-foreign.yml": flowYaml("New foreign").replace(
        `connector_id: ${CONNECTOR}`,
        `connector_id: ${FOREIGN_SOURCE}`,
      ),
    });
    await syncFlowsFromRepo(WS, "user-42");

    const listed = await loadLiveFlows(WS);
    const plain = Object.fromEntries(
      listed.map(live => [live.def.slug, liveFlowToPlain(live, WS)]),
    );
    expect(plain.close.definitionInvalid).toBeTruthy();
    expect(String(plain.close.destinationDatabaseId)).toBe(DEST);
    expect(plain["new-foreign"].definitionInvalid).toBeTruthy();
    expect(String(plain["new-foreign"].dataSourceId ?? "")).not.toBe(
      FOREIGN_SOURCE,
    );

    const row = await Flow.findOne({ workspaceId: WS, slug: "close" });
    const one = await loadLiveFlowById(WS, String(row!._id));
    expect(one?.connectionRefusal).toContain(
      `destination.connection_id: ${FOREIGN_DEST}`,
    );
    expect(liveFlowToPlain(one!, WS).definitionInvalid).toBeTruthy();
  });

  it("the cache resync refuses a file naming another workspace's source", async () => {
    await push({ "flows/close.yml": flowYaml("Close") });
    await syncFlowsFromRepo(WS, "user-42");
    // A push the reactor has not seen yet: only the SHA check reads it.
    await push({
      "flows/close.yml": flowYaml("Close").replace(
        `connector_id: ${CONNECTOR}`,
        `connector_id: ${FOREIGN_SOURCE}`,
      ),
    });
    const row = await Flow.findOne({ workspaceId: WS, slug: "close" });

    expect(await ensureFlowDerivedCache(row!)).toBe("invalid");
    const after = await Flow.findOne({ workspaceId: WS, slug: "close" });
    expect(String(after?.dataSourceId)).toBe(CONNECTOR);
  });
});

describe("GET/list from git", () => {
  it("serves the file at main when the Mongo row has no definition body", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    const row = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    expect(row).not.toBeNull();
    await Flow.updateOne(
      { _id: row!._id },
      { $set: { name: "", queries: [] } },
    );
    const stale = await Flow.findById(row!._id);
    expect(stale?.name).toBe("");

    const listed = await loadLiveFlows(WS);
    expect(listed).toHaveLength(1);
    const plain = liveFlowToPlain(listed[0], WS);
    expect(plain.name).toBe("Close → BigQuery");
    expect(plain.syncEngine).toBe("cdc");

    const got = await loadLiveFlowById(WS, row!._id.toString());
    expect(got).not.toBeNull();
    expect(liveFlowToPlain(got!, WS).name).toBe("Close → BigQuery");
  });

  it("resyncs a stale sourceBlobSha from the blob at main", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    await Flow.updateOne(
      { workspaceId: WS, slug: "close-to-bigquery" },
      { $set: { name: "stale-mongo", sourceBlobSha: "deadbeef" } },
    );

    const listed = await loadLiveFlows(WS);
    expect(liveFlowToPlain(listed[0], WS).name).toBe("Close → BigQuery");
    const row = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    expect(row?.name).toBe("Close → BigQuery");
    expect(row?.sourceBlobSha).not.toBe("deadbeef");
  });

  it("lists a git file that has no Mongo row", async () => {
    await push({ "flows/from-laptop.yml": flowYaml("From laptop") });
    const listed = await loadLiveFlows(WS);
    expect(listed.map(item => item.def.slug)).toEqual(["from-laptop"]);
    expect(listed[0].row).toBeNull();
    expect(listed[0].id.toString()).toBe(
      derivedFlowId(WS, "from-laptop").toString(),
    );
    expect(liveFlowToPlain(listed[0], WS).name).toBe("From laptop");
    const got = await loadLiveFlowById(WS, listed[0].id.toString());
    expect(got?.def.slug).toBe("from-laptop");
  });

  it("does not list a Mongo row that has no git file", async () => {
    await Flow.create({
      workspaceId: WS,
      slug: "mongo-only",
      name: "should-not-appear",
      type: "webhook",
      sourceType: "connector",
      dataSourceId: CONNECTOR,
      destinationDatabaseId: DEST,
      syncEngine: "cdc",
      createdBy: "user-42",
    });
    const listed = await loadLiveFlows(WS);
    expect(listed.map(item => item.def.slug)).not.toContain("mongo-only");
    const row = await Flow.findOne({ workspaceId: WS, slug: "mongo-only" });
    expect(row).not.toBeNull();
    expect(await loadLiveFlowById(WS, row!._id.toString())).toBeNull();
  });

  it("does not throw when a file at main parses but fails schema save", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    await push({
      "flows/close-to-bigquery.yml": flowYaml("Renamed").replace(
        "write_mode: append_dedup",
        "write_mode: not_a_real_mode",
      ),
    });

    // GET/list must not 500 the explorer because one file is unsavable.
    // syncFlowsFromRepo already swallows this; ensureFlowDerivedCache did not.
    await expect(loadLiveFlows(WS)).resolves.toHaveLength(1);
    const row = await Flow.findOne({
      workspaceId: WS,
      slug: "close-to-bigquery",
    });
    expect(row?.name).toBe("Close → BigQuery");
    expect(row?.writeMode).toBe("append_dedup");
    expect(row?.definitionInvalid?.reason).toMatch(
      /writeMode|write_mode|enum/i,
    );
  });

  it("does not serve a schema-invalid file as a live definition", async () => {
    await push({ "flows/close-to-bigquery.yml": flowYaml("Close → BigQuery") });
    await syncFlowsFromRepo(WS, "user-42");
    await push({
      "flows/close-to-bigquery.yml": flowYaml("Renamed").replace(
        "write_mode: append_dedup",
        "write_mode: not_a_real_mode",
      ),
    });

    const listed = await loadLiveFlows(WS);
    const plain = liveFlowToPlain(listed[0], WS);
    // Git is the store, but a file the reactor cannot save must not be
    // applied over the last-good row or look valid in GET/list.
    expect(plain.definitionInvalid).toBeTruthy();
    expect(plain.name).toBe("Close → BigQuery");
    expect(plain.writeMode).toBe("append_dedup");
  });

  it("does not 500 GET/list when one file's connector_id is not an ObjectId", async () => {
    await push({
      "flows/a-by-name.yml": flowYaml("By name").replace(
        `connector_id: ${CONNECTOR}`,
        "connector_id: close",
      ),
      "flows/z-good-one.yml": flowYaml("Good"),
    });

    await expect(loadLiveFlows(WS)).resolves.toHaveLength(2);
    const plains = (await loadLiveFlows(WS)).map(item =>
      liveFlowToPlain(item, WS),
    );
    const bad = plains.find(item => item.slug === "a-by-name");
    const good = plains.find(item => item.slug === "z-good-one");
    expect(bad?.definitionInvalid).toBeTruthy();
    expect(good?.name).toBe("Good");
    expect(good?.definitionInvalid).toBeUndefined();
  });

  it("does not list leftover local git or Mongo when no GitHub repo is bound", async () => {
    await push({ "flows/leftover.yml": flowYaml("Leftover") });
    await syncFlowsFromRepo(WS, "user-42");
    expect((await loadLiveFlows(WS)).map(item => item.def.slug)).toEqual([
      "leftover",
    ]);
    const row = await Flow.findOne({ workspaceId: WS, slug: "leftover" });
    expect(row).not.toBeNull();

    await unbindTestWorkspaceRepo(WS);
    expect(await loadLiveFlows(WS)).toEqual([]);
    expect(await loadLiveFlowById(WS, row!._id.toString())).toBeNull();
    expect(await Flow.findById(row!._id)).not.toBeNull();
    const leftoverHead = await resolveCommit(
      repoDirFor(WS),
      `refs/heads/${DEFAULT_BRANCH}`,
    );
    expect(leftoverHead).toBeTruthy();
    const leftoverFile = await readBlob(
      repoDirFor(WS),
      leftoverHead as string,
      "flows/leftover.yml",
    );
    expect(leftoverFile.contents).toContain("name: Leftover");
    expect(row!.sourceBlobSha).toBe(blobOid(leftoverFile.contents));
  });
});
