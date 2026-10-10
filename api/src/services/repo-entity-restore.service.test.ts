/**
 * Git history and restore for flows and workspace connectors, against a real
 * bare repo and memory Mongo. Flows go through the real push reactor (the
 * row must follow the restored file); the connector reconciler is stubbed —
 * it boots the connector in a sandbox — so the connector case asserts on
 * the folder that lands on main and that the reconciler was asked to run.
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

vi.mock("../integrations/github/app-auth", () => ({
  resolveRepoToken: async () => undefined,
}));
vi.mock("../inngest/client", () => ({
  inngest: { send: vi.fn(async () => undefined) },
}));
const syncConnectors = vi.fn(async () => ({
  created: 0,
  updated: 1,
  unchanged: 0,
  blocked: 0,
  removed: 0,
  skipped: [],
}));
vi.mock("../connectors/workspace/reconcile.service", () => ({
  syncConnectorsFromRepo: (...args: unknown[]) => syncConnectors(...args),
}));

import { Flow } from "../database/workspace-schema";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  listTree,
  readBlob,
  repoDirFor,
} from "../apps/repository.service";
import { bindTestWorkspaceRepo } from "../apps/bind-test-workspace-repo";
import {
  NotEntityPathError,
  entityCommitChanges,
  entityFileVersions,
  entityHistory,
} from "../apps/entity-git-history";
import { syncFlowsFromRepo } from "./flow-sync.service";
import {
  RestoreRefusedError,
  connectorGitScope,
  flowGitScope,
  restoreConnectorTo,
  restoreFlowTo,
} from "./repo-entity-restore.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let WS: string;

const CONNECTOR = new Types.ObjectId().toString();
const DEST = new Types.ObjectId().toString();

function flowYaml(name: string, schema: string): string {
  return [
    `name: ${name}`,
    "type: webhook",
    "source:",
    "  type: connector",
    `  connector_id: ${CONNECTOR}`,
    "destination:",
    `  connection_id: ${DEST}`,
    "  table:",
    `    schema: ${schema}`,
    "    create_if_not_exists: true",
    "webhook:",
    "  enabled: true",
    "sync:",
    "  mode: incremental",
    "  write_mode: append_dedup",
    "  engine: cdc",
    "",
  ].join("\n");
}

async function push(
  mutation: { writes?: Record<string, string>; deletes?: string[] },
  message: string,
): Promise<void> {
  await commitBlobsOnBranch(repoDirFor(WS), DEFAULT_BRANCH, mutation, {
    message,
  });
}

async function fileAtMain(rel: string): Promise<string | null> {
  return readBlob(repoDirFor(WS), `refs/heads/${DEFAULT_BRANCH}`, rel)
    .then(b => b.contents)
    .catch(() => null);
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "repo-entity-restore-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
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
  syncConnectors.mockClear();
  await Flow.deleteMany({});
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
  await bindTestWorkspaceRepo(WS);
});

describe("flow history", () => {
  it("lists the file's commits, diffs one, and restores it through the reactor", async () => {
    await push(
      { writes: { "flows/leads.yml": flowYaml("Leads", "raw_v1") } },
      "v1",
    );
    await push({ writes: { "other.txt": "noise\n" } }, "unrelated");
    await push(
      { writes: { "flows/leads.yml": flowYaml("Leads", "raw_v2") } },
      "v2",
    );
    await syncFlowsFromRepo(WS, "user-1");
    const before = await Flow.findOne({ workspaceId: WS, slug: "leads" });
    expect(before?.tableDestination?.schema).toBe("raw_v2");

    const scope = flowGitScope(WS, "leads");
    const history = await entityHistory(scope);
    expect(history.map(c => c.subject)).toEqual(["v2", "v1"]);

    const changes = await entityCommitChanges(scope, history[0].oid);
    expect(changes.files).toEqual([
      { path: "flows/leads.yml", status: "modified" },
    ]);
    const versions = await entityFileVersions(
      scope,
      history[0].oid,
      "flows/leads.yml",
    );
    expect(versions.before).toContain("raw_v1");
    expect(versions.after).toContain("raw_v2");

    const restored = await restoreFlowTo({
      workspaceId: WS,
      slug: "leads",
      sha: history[1].oid,
      actorUserId: "user-1",
    });
    expect(restored.unchanged).toBe(false);
    expect(restored.sync.invalid).toEqual([]);
    expect(await fileAtMain("flows/leads.yml")).toContain("raw_v1");
    const after = await Flow.findOne({ workspaceId: WS, slug: "leads" });
    expect(after?.tableDestination?.schema).toBe("raw_v1");

    const subjects = (await entityHistory(scope)).map(c => c.subject);
    expect(subjects).toEqual([
      `Restore "v1" (${history[1].oid.slice(0, 7)})`,
      "v2",
      "v1",
    ]);
  });

  it("refuses to read a path that is not the flow's", async () => {
    await push(
      { writes: { "flows/leads.yml": flowYaml("Leads", "raw") } },
      "v1",
    );
    const [head] = await entityHistory(flowGitScope(WS, "leads"));
    await expect(
      entityFileVersions(
        flowGitScope(WS, "leads"),
        head.oid,
        "users/u2/consoles/secret.sql",
      ),
    ).rejects.toBeInstanceOf(NotEntityPathError);
  });

  it("refuses a commit where the flow file is not a valid definition", async () => {
    await push(
      { writes: { "flows/leads.yml": "name: [unclosed\n" } },
      "broken",
    );
    await push(
      { writes: { "flows/leads.yml": flowYaml("Leads", "raw") } },
      "fixed",
    );
    const history = await entityHistory(flowGitScope(WS, "leads"));
    await expect(
      restoreFlowTo({ workspaceId: WS, slug: "leads", sha: history[1].oid }),
    ).rejects.toBeInstanceOf(RestoreRefusedError);
    expect(await fileAtMain("flows/leads.yml")).toContain("raw");
  });
});

describe("connector history", () => {
  it("follows the whole folder and restores it, removing files added since", async () => {
    await push(
      {
        writes: {
          "connectors/acme/connector.yaml": "runtime: node\n",
          "connectors/acme/connector.ts": "export default 1;\n",
        },
      },
      "add acme",
    );
    await push(
      { writes: { "connectors/other/connector.yaml": "runtime: node\n" } },
      "other",
    );
    await push(
      {
        writes: {
          "connectors/acme/connector.ts": "export default 2;\n",
          "connectors/acme/helper.ts": "export const h = 1;\n",
        },
      },
      "acme v2",
    );

    const scope = connectorGitScope(WS, "acme");
    const history = await entityHistory(scope);
    expect(history.map(c => c.subject)).toEqual(["acme v2", "add acme"]);
    const changes = await entityCommitChanges(scope, history[0].oid);
    expect(changes.files.map(f => f.path).sort()).toEqual([
      "connectors/acme/connector.ts",
      "connectors/acme/helper.ts",
    ]);

    const restored = await restoreConnectorTo({
      workspaceId: WS,
      slug: "acme",
      sha: history[1].oid,
      actorUserId: "user-1",
    });
    expect(restored.unchanged).toBe(false);
    expect(syncConnectors).toHaveBeenCalledWith(WS, "user-1");
    expect(await fileAtMain("connectors/acme/connector.ts")).toBe(
      "export default 1;\n",
    );
    expect(await fileAtMain("connectors/acme/helper.ts")).toBeNull();
    // Another connector's folder is untouched.
    const paths = (
      await listTree(repoDirFor(WS), `refs/heads/${DEFAULT_BRANCH}`)
    ).map(e => e.path);
    expect(paths).toContain("connectors/other/connector.yaml");

    const again = await restoreConnectorTo({
      workspaceId: WS,
      slug: "acme",
      sha: history[1].oid,
    });
    expect(again.unchanged).toBe(true);
  });

  it("refuses a commit from before the connector existed", async () => {
    await push({ writes: { "other.txt": "x\n" } }, "before");
    await push(
      { writes: { "connectors/acme/connector.yaml": "runtime: node\n" } },
      "add acme",
    );
    const [, before] = await entityHistory({
      workspaceId: WS,
      pathspec: ".",
      owns: () => true,
    });
    await expect(
      restoreConnectorTo({ workspaceId: WS, slug: "acme", sha: before.oid }),
    ).rejects.toBeInstanceOf(RestoreRefusedError);
  });

  it("rejects a slug that could escape the connectors folder", () => {
    expect(() => connectorGitScope(WS, "../flows")).toThrow(
      RestoreRefusedError,
    );
  });
});
