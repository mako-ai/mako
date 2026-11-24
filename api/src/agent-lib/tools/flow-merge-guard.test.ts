/**
 * flow_update, flow_webhook_provision's file commit and flow_merge_to_main for
 * a guarded MCP/API-key caller (apps/default-branch-guard.ts). Real git (a
 * file:// "GitHub" remote and the instance's bare cache) and real Mongo.
 *
 * flows/<slug>.yml is the definition and the Mongo row only follows main, so a
 * guarded write is a proposal:
 *
 *   BRANCH   — the file lands on `mcp/<person>/flows`; main, locally and on
 *              the remote, keeps its head.
 *   ROW      — the row, its triggers and the provider subscription stay as
 *              they are until the merge puts the file on main.
 *   MERGE    — flow_merge_to_main opens the merge request for that branch.
 *   NO LEAK  — outside the guard scope flow_update still lands on main.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const mocks = vi.hoisted(() => ({ openMergeRequest: vi.fn() }));

vi.mock("../../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
vi.mock("../../inngest/client", () => ({
  inngest: { send: vi.fn(async () => undefined) },
}));
vi.mock("../../services/flow-webhook-subscription.service", () => ({
  syncFlowWebhookSubscription: vi.fn(async () => ({ status: "existing" })),
}));
vi.mock("../../apps/merge-request.service", () => ({
  openMergeRequest: mocks.openMergeRequest,
}));

import {
  DEFAULT_BRANCH,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";
import { seedMirroredWorkspace } from "../../apps/cloud-repo/durable-main.testkit";
import {
  DatabaseConnection,
  Flow,
  SourceConnection,
  WorkspaceMember,
} from "../../database/workspace-schema";
import { syncFlowsFromRepo } from "../../services/flow-sync.service";
import { commitFlowFile } from "../../services/flow-config.service";
import { parseFlowFile } from "../../services/flow-config-files";
import { runUnderDefaultBranchGuard } from "../../apps/default-branch-guard";
import { guardBranchFor } from "../../apps/branch-policy";
import { createFlowSyncTools } from "./flow-sync-tools";

const CONNECTOR = new Types.ObjectId().toString();
const DEST = new Types.ObjectId().toString();
const USER = "user-1";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let remoteDir: string;
let WS: string;

function flowYaml(name: string): string {
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
    "",
  ].join("\n");
}

type ToolResult = Record<string, any>;
const tool = (name: string, input: Record<string, unknown>) =>
  (
    createFlowSyncTools({ workspaceId: WS, userId: USER })[name] as unknown as {
      execute: (i: unknown, o: unknown) => Promise<ToolResult>;
    }
  ).execute(input, { toolCallId: "t", messages: [] });
const guarded = <T>(fn: () => Promise<T>) =>
  runUnderDefaultBranchGuard({ workspaceId: WS, userId: USER }, fn);
const head = (dir: string, ref = DEFAULT_BRANCH) =>
  resolveCommit(dir, `refs/heads/${ref}`);

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-merge-guard-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${path.join(tmpRoot, "remotes")}`;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(async () => {
  process.env.APPS_CONNECTED_REPO_PUSH = "allow";
  mocks.openMergeRequest.mockReset();
  WS = new Types.ObjectId().toString();
  await Flow.deleteMany({});
  await SourceConnection.collection.deleteMany({});
  await DatabaseConnection.collection.deleteMany({});
  const workspaceId = new Types.ObjectId(WS);
  await WorkspaceMember.collection.insertOne({
    workspaceId,
    userId: USER,
    role: "admin",
  } as any);
  await SourceConnection.collection.insertOne({
    _id: new Types.ObjectId(CONNECTOR),
    workspaceId,
    name: "Close",
    type: "close",
  } as any);
  await DatabaseConnection.collection.insertOne({
    _id: new Types.ObjectId(DEST),
    workspaceId,
    name: "Warehouse",
    type: "bigquery",
  } as any);
  remoteDir = await seedMirroredWorkspace(path.join(tmpRoot, "remotes"), WS, {
    "README.md": "x\n",
    "flows/close-a.yml": flowYaml("Close A"),
  });
  await syncFlowsFromRepo(WS, USER);
  expect(await Flow.countDocuments({ workspaceId: WS })).toBe(1);
});

afterEach(() => {
  delete process.env.APPS_CONNECTED_REPO_PUSH;
});

describe("flow_update for a guarded caller", () => {
  it("writes the file to mcp/<person>/flows and changes nothing live", async () => {
    const mainBefore = await head(repoDirFor(WS));
    const remoteBefore = await head(remoteDir);
    const rowBefore = await Flow.findOne({ workspaceId: WS, slug: "close-a" });
    const branch = await guardBranchFor(WS, USER, "flows");

    const result = await guarded(() =>
      tool("flow_update", { flow: "close-a", resync: "off" }),
    );
    expect(result.success, result.error).toBe(true);
    expect(result.pending).toBe(true);
    expect(result.branch).toBe(branch);
    expect(result.fileChanged).toBe(true);
    expect(result.next).toBe(
      `Nothing is live yet. flows/<slug>.yml was written to branch ${branch}, not the default branch. Open a merge with flow_merge_to_main.`,
    );
    // The proposal says resync is off; the live row still says on.
    expect(result.proposedTriggers.resync).toBeFalsy();

    // Main (local and remote) did not move.
    expect(await head(repoDirFor(WS))).toBe(mainBefore);
    expect(await head(remoteDir)).toBe(remoteBefore);
    // The branch holds the new definition.
    const onBranch = await readBlob(
      repoDirFor(WS),
      `refs/heads/${branch}`,
      "flows/close-a.yml",
    );
    expect(parseFlowFile(onBranch.contents)?.backfillSchedule).toBeFalsy();
    // The row follows main: nothing changed.
    const rowAfter = await Flow.findOne({ workspaceId: WS, slug: "close-a" });
    expect(rowAfter?.backfillSchedule?.enabled).toBe(
      rowBefore?.backfillSchedule?.enabled,
    );
    expect(rowAfter?.sourceBlobSha).toBe(rowBefore?.sourceBlobSha);
  });

  it("a second identical call writes nothing new", async () => {
    await guarded(() =>
      tool("flow_update", { flow: "close-a", resync: "off" }),
    );
    const again = await guarded(() =>
      tool("flow_update", { flow: "close-a", resync: "off" }),
    );
    expect(again.success, again.error).toBe(true);
    expect(again.fileChanged).toBe(false);
  });

  it("lands on main outside the guard scope, as before", async () => {
    const before = await head(repoDirFor(WS));
    const result = await tool("flow_update", {
      flow: "close-a",
      resync: "off",
    });
    expect(result.success, result.error).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(await head(repoDirFor(WS))).not.toBe(before);
    expect(await head(remoteDir)).toBe(await head(repoDirFor(WS)));
  });
});

describe("the file commit flow_webhook_provision makes", () => {
  it("goes to the branch, never main, and stamps no blob on the row", async () => {
    const flow = (await Flow.findOne({ workspaceId: WS, slug: "close-a" }))!;
    flow.webhookConfig = {
      ...((flow.webhookConfig as unknown as Record<string, unknown>) ?? {}),
      enabled: true,
      endpoint: "https://example.test/hook",
    } as typeof flow.webhookConfig;
    const mainBefore = await head(repoDirFor(WS));
    const branch = await guardBranchFor(WS, USER, "flows");
    const committed = await guarded(() =>
      commitFlowFile(flow, USER, undefined, { branch }),
    );
    expect(committed.ok, committed.error).toBe(true);
    expect(await head(repoDirFor(WS))).toBe(mainBefore);
    expect(await head(repoDirFor(WS), branch)).toBe(committed.commitSha);
  });
});

describe("flow_merge_to_main", () => {
  it("opens the merge request for the caller's flows branch", async () => {
    mocks.openMergeRequest.mockResolvedValue({
      status: "pull_request",
      pullRequest: { number: 9, url: "https://github.com/o/r/pull/9" },
    });
    const branch = await guardBranchFor(WS, USER, "flows");
    const result = await guarded(() => tool("flow_merge_to_main", {}));
    expect(result.success).toBe(true);
    expect(mocks.openMergeRequest).toHaveBeenCalledWith({
      workspaceId: WS,
      branch,
      userId: USER,
    });
  });

  it("is not a merge when a flow file check fails", async () => {
    mocks.openMergeRequest.mockResolvedValue({ status: "checks_failed" });
    const result = await guarded(() => tool("flow_merge_to_main", {}));
    expect(result.success).toBe(false);
    expect(result.status).toBe("checks_failed");
  });

  it("has nothing to merge outside the guard scope", async () => {
    const result = await tool("flow_merge_to_main", {});
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("nothing to merge");
    expect(mocks.openMergeRequest).not.toHaveBeenCalled();
  });
});
