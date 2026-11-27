/**
 * flow_update lands flows/<slug>.yml on the mirror's main before it saves the
 * row, or saves nothing. Real git (a file:// "GitHub" remote and the
 * instance's local bare cache) and real Mongo.
 *
 * On 2026-11-18 two flow_update calls changed the row while their commits
 * never reached GitHub: the push was rejected, the next freshen parked the
 * local commit under refs/mako/diverged/*, and the next merge to main
 * reconciled the row back from the old file (Stripe PL paused at 05:39 UTC,
 * webhooks back on at 05:46; FR Close resync off at 01:35 UTC, a scheduled
 * full backfill at 06:45). What must hold:
 *
 *   SHA        — the result names the commit at main holding the definition,
 *                and that commit is on the remote.
 *   ROLLBACK   — a push the remote refuses saves nothing: row, remote main
 *                and local main stay as they were; the error names the cause.
 *   RACE       — another writer moving main between our fetch and our push
 *                costs a retry, not a lost write and not a clobber; when it
 *                changed the same file, the row re-reads it first and the
 *                final file holds both changes.
 *   SERIAL     — concurrent flow_update calls on one workspace all land,
 *                each in its own commit, none undoing another.
 *   STALE ROW  — a row changed without a commit (the incident's state) is
 *                reported by flow_status (definitionAtMain.inSync false).
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
import {
  ensureTestDatabaseConnection,
  ensureTestSourceConnection,
  setupPgTestDb,
  type PgTestDb,
} from "../../test-support/pg-test";

const state = vi.hoisted(() => ({
  /** The GitHub App token call fails while set. */
  tokenFail: false,
}));

vi.mock("../../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => {
    if (state.tokenFail) throw new Error("token service unavailable");
    return undefined;
  },
}));
vi.mock("../../inngest/client", () => ({
  inngest: { send: vi.fn(async () => undefined) },
}));
vi.mock("../../services/flow-webhook-subscription.service", () => ({
  syncFlowWebhookSubscription: vi.fn(async () => ({ status: "existing" })),
}));
// The hook another instance's push needs: main moves on the remote right
// after this instance fetched it.
vi.mock("../../apps/cloud-repo/fetch", async importOriginal => {
  const { withFreshenHook } =
    await import("../../apps/cloud-repo/durable-main.testkit");
  return withFreshenHook(
    await importOriginal<typeof import("../../apps/cloud-repo/fetch")>(),
  );
});

import { runGit } from "../../apps/git";
import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  readBlob,
  repoDirFor,
  resolveCommit,
} from "../../apps/repository.service";
import {
  commitOnRemoteMain,
  freshenHooks,
  resetFreshenHooks,
  seedMirroredWorkspace,
} from "../../apps/cloud-repo/durable-main.testkit";
import { Flow } from "../../database/workspace-schema";
import { syncFlowsFromRepo } from "../../services/flow-sync.service";
import { commitFlowFile } from "../../services/flow-config.service";
import { commitToMainDurably } from "../../apps/cloud-repo/durable-main";
import { mirrorPushNow } from "../../apps/cloud-repo/push";
import {
  type FlowFile,
  flowFilePath,
  flowToFile,
  parseFlowFile,
  serializeFlowFile,
} from "../../services/flow-config-files";
import { createFlowSyncTools } from "./flow-sync-tools";

const CONNECTOR = new Types.ObjectId().toString();
const DEST = new Types.ObjectId().toString();

let pg: PgTestDb;
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

async function flowUpdate(input: Record<string, unknown>): Promise<ToolResult> {
  const tools = createFlowSyncTools({ workspaceId: WS });
  const exec = (
    tools.flow_update as unknown as {
      execute: (i: unknown, o: unknown) => Promise<ToolResult>;
    }
  ).execute;
  return exec(input, { toolCallId: "t", messages: [] });
}

async function flowStatus(ref: string): Promise<ToolResult> {
  const tools = createFlowSyncTools({ workspaceId: WS });
  const exec = (
    tools.flow_status as unknown as {
      execute: (i: unknown, o: unknown) => Promise<ToolResult>;
    }
  ).execute;
  return exec({ flow: ref }, { toolCallId: "t", messages: [] });
}

const head = (dir: string) =>
  resolveCommit(dir, `refs/heads/${DEFAULT_BRANCH}`);

/** The flow file at the remote's main, parsed. */
async function remoteFlow(slug: string) {
  const tip = (await head(remoteDir))!;
  const blob = await readBlob(remoteDir, tip, flowFilePath(slug));
  return parseFlowFile(blob.contents)!;
}

/** A file with no `resync` (backfill schedule) has the periodic resync off. */
const resyncOn = (f: FlowFile) => !!f.backfillSchedule;

/** Another instance (or a merged PR) commits straight onto GitHub's main. */
async function otherWriter(writes: Record<string, string>): Promise<void> {
  await commitOnRemoteMain(remoteDir, { writes });
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-update-durable-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_GITHUB_REMOTE_BASE = `file://${path.join(tmpRoot, "remotes")}`;
  pg = await setupPgTestDb();
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await pg?.close();
  await mongoose.disconnect();
  await mongo?.stop();
  await fs.rm(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

beforeEach(async () => {
  process.env.APPS_CONNECTED_REPO_PUSH = "allow";
  state.tokenFail = false;
  resetFreshenHooks();
  WS = new Types.ObjectId().toString();
  await Promise.all([pg.reset(), Flow.deleteMany({})]);
  await ensureTestSourceConnection(pg.db, {
    id: CONNECTOR,
    workspaceId: WS,
    name: "Stripe",
    type: "stripe",
  });
  await ensureTestDatabaseConnection(pg.db, {
    id: DEST,
    workspaceId: WS,
    name: "Warehouse",
    type: "bigquery",
  });
  remoteDir = await seedMirroredWorkspace(path.join(tmpRoot, "remotes"), WS, {
    "README.md": "x\n",
    "flows/close-a.yml": flowYaml("Close A"),
    "flows/close-b.yml": flowYaml("Close B"),
  });
  await syncFlowsFromRepo(WS, "user-1");
  expect(await Flow.countDocuments({ workspaceId: WS })).toBe(2);
});

afterEach(() => {
  delete process.env.APPS_CONNECTED_REPO_PUSH;
});

describe("flow_update writes main first", () => {
  it("SHA: returns the commit it pushed, and the remote holds the change", async () => {
    const result = await flowUpdate({ flow: "close-a", resync: "off" });
    expect(result.success).toBe(true);
    expect(result.fileChanged).toBe(true);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await head(remoteDir)).toBe(result.commit);
    expect(await head(repoDirFor(WS))).toBe(result.commit);
    expect(resyncOn(await remoteFlow("close-a"))).toBe(false);
    const row = await Flow.findOne({ workspaceId: WS, slug: "close-a" });
    expect(row?.backfillSchedule?.enabled).toBe(false);
    const tip = await readBlob(remoteDir, result.commit, "flows/close-a.yml");
    expect(row?.sourceBlobSha).toBe(blobOid(tip.contents));

    // Again: nothing to write, main's head is still named.
    const again = await flowUpdate({ flow: "close-a", resync: "off" });
    expect(again.success).toBe(true);
    expect(again.fileChanged).toBe(false);
    expect(again.commit).toBe(result.commit);
  });

  it("ROLLBACK: a push the remote refuses saves nothing and says why", async () => {
    const hook = path.join(remoteDir, "hooks", "pre-receive");
    await fs.writeFile(
      hook,
      "#!/bin/sh\necho 'main is protected' >&2\nexit 1\n",
    );
    await fs.chmod(hook, 0o755);
    const remoteBefore = await head(remoteDir);
    const localBefore = await head(repoDirFor(WS));
    const rowBefore = await Flow.findOne({ workspaceId: WS, slug: "close-a" });

    const result = await flowUpdate({
      flow: "close-a",
      resync: "off",
      webhook: "off",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/nothing was saved/);
    expect(result.error).toMatch(/push to test-owner\/test-repo main failed/);
    expect(result.error).toMatch(/main is protected/);
    expect(await head(remoteDir)).toBe(remoteBefore);
    expect(await head(repoDirFor(WS))).toBe(localBefore);
    const row = await Flow.findOne({ workspaceId: WS, slug: "close-a" });
    expect(row?.backfillSchedule?.enabled).toBe(true);
    expect(row?.webhookConfig?.enabled).toBe(true);
    expect(row?.sourceBlobSha).toBe(rowBefore?.sourceBlobSha);
  });

  it("RACE: main moving on GitHub between fetch and push costs a retry, not the write", async () => {
    // Freshen #1 is flow_update's own, #2 the commit's: move main after it.
    freshenHooks.after.set(2, () =>
      otherWriter({ "notes/other.md": "from another instance\n" }),
    );
    const result = await flowUpdate({ flow: "close-a", resync: "off" });
    expect(result.success).toBe(true);
    expect(await head(remoteDir)).toBe(result.commit);
    const tip = result.commit as string;
    expect((await readBlob(remoteDir, tip, "notes/other.md")).contents).toBe(
      "from another instance\n",
    );
    expect(resyncOn(await remoteFlow("close-a"))).toBe(false);
  });

  it("RACE: another writer changing the same flow file is re-read, not clobbered", async () => {
    // The other writer switches webhooks off in the file; this call then
    // switches resync off. Both must survive.
    const row = await Flow.findOne({ workspaceId: WS, slug: "close-a" });
    const theirs = flowToFile(row!);
    theirs.webhookEnabled = false;
    freshenHooks.after.set(2, () =>
      otherWriter({ "flows/close-a.yml": serializeFlowFile(theirs) }),
    );
    const result = await flowUpdate({ flow: "close-a", resync: "off" });
    expect(result.success).toBe(true);
    expect(await head(remoteDir)).toBe(result.commit);
    const file = await remoteFlow("close-a");
    expect(resyncOn(file)).toBe(false);
    expect(file.webhookEnabled).toBe(false);
    const saved = await Flow.findOne({ workspaceId: WS, slug: "close-a" });
    expect(saved?.webhookConfig?.enabled).toBe(false);
    expect(saved?.backfillSchedule?.enabled).toBe(false);
  });

  it("SERIAL: concurrent calls on one workspace all land, none undoes another", async () => {
    const before = await head(remoteDir);
    const results = await Promise.all([
      flowUpdate({ flow: "close-a", resync: "off" }),
      flowUpdate({ flow: "close-a", webhook: "off" }),
      flowUpdate({ flow: "close-b", resync: "0 4 * * *" }),
      flowUpdate({ flow: "close-b", webhook: "off" }),
    ]);
    for (const r of results) expect(r.success, r.error).toBe(true);
    const shas = results.map(r => r.commit);
    expect(new Set(shas).size).toBe(4);
    const { stdout } = await runGit([
      "-C",
      remoteDir,
      "rev-list",
      "--count",
      `${before}..${DEFAULT_BRANCH}`,
    ]);
    expect(Number(stdout.trim())).toBe(4);

    const a = await remoteFlow("close-a");
    expect(resyncOn(a)).toBe(false);
    expect(a.webhookEnabled).toBe(false);
    const b = await remoteFlow("close-b");
    expect(b.backfillSchedule?.cron).toBe("0 4 * * *");
    expect(b.webhookEnabled).toBe(false);

    for (const slug of ["close-a", "close-b"]) {
      const status = await flowStatus(slug);
      expect(
        status.definitionAtMain.inSync,
        JSON.stringify(status.definitionAtMain),
      ).toBe(true);
    }
  });

  it("STALE ROW: a row changed without a commit shows as drift, and flow_update still writes", async () => {
    // The incident's state: the row says resync off (and carries the blob of
    // a commit that never landed); main still says resync on.
    const row = await Flow.findOne({ workspaceId: WS, slug: "close-a" });
    row!.backfillSchedule!.enabled = false;
    const ghost = serializeFlowFile(flowToFile(row!));
    row!.sourceBlobSha = blobOid(ghost);
    await row!.save();

    const status = await flowStatus("close-a");
    expect(status.definitionAtMain.inSync).toBe(false);
    expect(status.definitionAtMain.differs).toContain("backfillSchedule");

    const result = await flowUpdate({ flow: "close-a", resync: "off" });
    expect(result.success).toBe(true);
    expect(result.fileChanged).toBe(true);
    expect(await head(remoteDir)).toBe(result.commit);
    expect(resyncOn(await remoteFlow("close-a"))).toBe(false);
    expect((await flowStatus("close-a")).definitionAtMain.inSync).toBe(true);
  });
  it("TOKEN: a token call that fails leaves no local commit behind", async () => {
    const localBefore = await head(repoDirFor(WS));
    const remoteBefore = await head(remoteDir);
    state.tokenFail = true;
    const result = await flowUpdate({ flow: "close-a", resync: "off" });
    state.tokenFail = false;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/token service unavailable/);
    // Local main untouched, so no later queued push can carry the change.
    expect(await head(repoDirFor(WS))).toBe(localBefore);
    expect(await head(remoteDir)).toBe(remoteBefore);
    const row = await Flow.findOne({ workspaceId: WS, slug: "close-a" });
    expect(row?.backfillSchedule?.enabled).toBe(true);
  });

  it("PUSH QUEUE: a mirror push queued during the write starts after it", async () => {
    const events: string[] = [];
    await commitToMainDurably(
      WS,
      async () => {
        void mirrorPushNow(WS).then(() => events.push("mirror push"));
        await new Promise(r => setTimeout(r, 300));
        events.push("mutation");
        return { writes: { "notes/queued.md": "x\n" } };
      },
      { message: "durable write" },
    );
    events.push("write");
    await mirrorPushNow(WS);
    expect(events).toEqual(["mutation", "write", "mirror push"]);
  });

  it("LOCAL MOVE: main moving locally after the mutation was judged re-judges it", async () => {
    const local = repoDirFor(WS);
    const heads: string[] = [];
    const result = await commitToMainDurably(
      WS,
      async ({ head: at }) => {
        heads.push(at);
        if (heads.length === 1) {
          // A box's push lands on this instance between judge and commit.
          await commitBlobsOnBranch(
            local,
            DEFAULT_BRANCH,
            { writes: { "notes/box.md": "from a box\n" } },
            { message: "box push" },
          );
        }
        return { writes: { "notes/ours.md": `judged at ${at}\n` } };
      },
      { message: "durable write" },
    );
    expect(heads).toHaveLength(2);
    expect(heads[1]).not.toBe(heads[0]);
    expect(await head(remoteDir)).toBe(result.commitOid);
    const ours = await readBlob(remoteDir, result.commitOid, "notes/ours.md");
    expect(ours.contents).toBe(`judged at ${heads[1]}\n`);
    const box = await readBlob(remoteDir, result.commitOid, "notes/box.md");
    expect(box.contents).toBe("from a box\n");
  });

  it("INVALID: flow_update refuses when the file at main is invalid, and leaves it", async () => {
    const broken = "name: [unclosed\n";
    await otherWriter({ "flows/close-a.yml": broken });
    const result = await flowUpdate({ flow: "close-a", webhook: "on" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a valid definition/);
    const tip = (await head(remoteDir))!;
    expect((await readBlob(remoteDir, tip, "flows/close-a.yml")).contents).toBe(
      broken,
    );
  });

  it("MISSING: flow_update refuses when a PR deleted the file, and does not recreate it", async () => {
    await commitBlobsOnBranch(
      remoteDir,
      DEFAULT_BRANCH,
      { deletes: ["flows/close-a.yml"] },
      { message: "PR: delete close-a" },
    );
    const result = await flowUpdate({ flow: "close-a", webhook: "on" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a valid definition/);
    const after = (await head(remoteDir))!;
    const { stdout } = await runGit([
      "-C",
      remoteDir,
      "ls-tree",
      "--name-only",
      after,
      "flows/",
    ]);
    expect(stdout).not.toMatch(/close-a\.yml/);
  });

  it("STALE BASE: a save from a row behind main conflicts instead of reverting main", async () => {
    // A merged PR switches webhooks off; the row has not followed yet.
    const row = await Flow.findOne({ workspaceId: WS, slug: "close-a" });
    const theirs = flowToFile(row!);
    theirs.webhookEnabled = false;
    const merged = serializeFlowFile(theirs);
    await otherWriter({ "flows/close-a.yml": merged });
    // A setting that is not in the file: the row still serializes to B1.
    const result = await commitFlowFile(row!, "user-1");
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe(true);
    const tip = (await head(remoteDir))!;
    expect((await readBlob(remoteDir, tip, "flows/close-a.yml")).contents).toBe(
      merged,
    );
  });

  it("STATUS: definitionAtMain compares against the mirror, not a stale cache", async () => {
    // Instance A landed webhook off on GitHub and saved the row; this
    // instance's cache still has the old file.
    const row = await Flow.findOne({ workspaceId: WS, slug: "close-a" });
    const file = flowToFile(row!);
    file.webhookEnabled = false;
    const contents = serializeFlowFile(file);
    await otherWriter({ "flows/close-a.yml": contents });
    row!.webhookConfig!.enabled = false;
    row!.sourceBlobSha = blobOid(contents);
    await row!.save();
    const status = await flowStatus("close-a");
    expect(
      status.definitionAtMain.inSync,
      JSON.stringify(status.definitionAtMain),
    ).toBe(true);
    expect(status.definitionAtMain.commit).toBe(await head(remoteDir));
  });
});
