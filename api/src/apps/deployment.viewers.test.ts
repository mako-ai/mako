/**
 * Viewer roles, end to end through the published serving path (apps.md §26):
 * a real workspace repo with mako.json `viewers` and binding policies at a
 * committed sha, a real artifact in the store, and `serveDeploymentFile`
 * answering as each viewer would see it — the document, viewer.json, the
 * binding list, and the parquet bytes themselves.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  commitWorktree,
  createProject,
  ensureWorktree,
  readFile,
  writeFile,
} from "./worktree.service";
import { bindingArtifactKey, readBindings } from "./bindings.service";
import { serveDeploymentFile } from "./deployment.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import { startTestGitServer, type TestGitServer } from "./test-git-server";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let gitServer: TestGitServer;

const WS = new Types.ObjectId().toString();
const USER = "user-1";
const LEAD = { id: "u-lead", email: "Lead@RealAdvisor.com" };
const BDR = { id: "u-bdr", email: "sam@realadvisor.com" };
const STRANGER = { id: "u-x", email: "nobody@realadvisor.com" };

async function withDuckDB<T>(
  fn: (
    run: (sql: string) => Promise<Array<Record<string, unknown>>>,
  ) => Promise<T>,
): Promise<T> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    return await fn(async sql => {
      const result = await connection.run(sql);
      return (await result.getRowObjectsJson()) as Array<
        Record<string, unknown>
      >;
    });
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function bodyToTempParquet(response: Response): Promise<string> {
  const file = path.join(
    tmpRoot,
    `served-${Math.random().toString(36).slice(2)}.parquet`,
  );
  await fs.writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apps-viewers-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-secret-for-git-tokens";
  process.env.DASHBOARD_ARTIFACT_STORE = "filesystem";
  process.env.DASHBOARD_ARTIFACT_DIR = path.join(tmpRoot, "artifacts");
  gitServer = await startTestGitServer();
  process.env.APPS_GIT_ORIGIN_URL = gitServer.url;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await gitServer?.close();
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("a role-scoped app, served per viewer", () => {
  let projectId: string;
  let sha: string;

  beforeAll(async () => {
    const project = await createProject({
      workspaceId: WS,
      title: "Roles App",
      userId: USER,
    });
    projectId = project._id.toString();
    const handle = await ensureWorktree(project, USER);

    const manifest = JSON.parse(
      (await readFile(project, "mako.json", USER)).contents,
    );
    manifest.viewers = {
      default: "bdr",
      roles: {
        team_lead: { members: { [LEAD.email]: {} } },
        bdr: { members: {} },
      },
    };
    await writeFile(
      handle,
      "mako.json",
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await writeFile(
      handle,
      "bindings/pipeline.sql",
      [
        "-- connection: conn-1",
        "-- row_filter_bdr: sales_rep_email = {{ viewer.email }}",
        "SELECT 1",
        "",
      ].join("\n"),
    );
    await writeFile(
      handle,
      "bindings/leads_only.sql",
      ["-- connection: conn-1", "-- roles: team_lead", "SELECT 2", ""].join(
        "\n",
      ),
    );
    const committed = await commitWorktree(handle, "viewer roles");
    expect(committed.committed).toBe(true);
    sha = committed.commitOid!;

    // The pipeline artifact: three reps' rows, one of them the BDR's.
    const binding = (await readBindings(project, USER)).find(
      b => b.name === "pipeline",
    )!;
    const local = path.join(tmpRoot, "pipeline.parquet");
    await withDuckDB(async run => {
      await run(
        `COPY (SELECT * FROM (VALUES ('sam@realadvisor.com', 'Sam', 1), ('ana@realadvisor.com', 'Ana', 2), ('sam@realadvisor.com', 'Sam', 3)) t(sales_rep_email, rep, n))
         TO '${local.replace(/'/g, "''")}' (FORMAT PARQUET, COMPRESSION SNAPPY)`,
      );
    });
    await getDashboardArtifactStore().put(local, bindingArtifactKey(binding));
  });

  const serve = (
    assetPath: string,
    viewer: { id: string; email: string } | null,
  ) => serveDeploymentFile({ projectId, sha, assetPath, viewer });

  it("tells each viewer who they are, and refuses nobody-in-particular", async () => {
    const lead = await serve("__data/viewer.json", LEAD);
    expect(lead?.status).toBe(200);
    expect(await lead!.json()).toEqual({
      email: "lead@realadvisor.com",
      role: "team_lead",
      claims: { email: "lead@realadvisor.com", role: "team_lead" },
    });

    const bdr = await serve("__data/viewer.json", BDR);
    expect((await bdr!.json()).role).toBe("bdr");

    // No role lists them, but the default does.
    const stranger = await serve("__data/viewer.json", STRANGER);
    expect((await stranger!.json()).role).toBe("bdr");

    // An anonymous share, or a token minted before viewers existed.
    const anonymous = await serve("__data/viewer.json", null);
    expect(anonymous?.status).toBe(403);
    const document = await serve("", null);
    expect(document?.status).toBe(403);
  });

  it("lists only the bindings the role may read", async () => {
    const lead = (await (await serve(
      "__data/index.json",
      LEAD,
    ))!.json()) as string[];
    expect(lead).toContain("pipeline");
    expect(lead).toContain("leads_only");

    const bdr = (await (await serve(
      "__data/index.json",
      BDR,
    ))!.json()) as string[];
    expect(bdr).toContain("pipeline");
    expect(bdr).not.toContain("leads_only");

    expect(await serve("__data/leads_only.parquet", BDR)).toBeNull();
  });

  it("serves the BDR their rows and the lead every row — as parquet bytes", async () => {
    const forBdr = await serve("__data/pipeline.parquet", BDR);
    expect(forBdr?.status).toBe(200);
    expect(forBdr?.headers.get("content-type")).toBe(
      "application/vnd.apache.parquet",
    );
    expect(Number(forBdr?.headers.get("content-length"))).toBeGreaterThan(0);
    const bdrFile = await bodyToTempParquet(forBdr!);
    const bdrRows = await withDuckDB(run =>
      run(`SELECT rep, n FROM read_parquet('${bdrFile}') ORDER BY n`),
    );
    expect(bdrRows).toEqual([
      { rep: "Sam", n: 1 },
      { rep: "Sam", n: 3 },
    ]);

    const forLead = await serve("__data/pipeline.parquet", LEAD);
    expect(forLead?.status).toBe(200);
    const leadFile = await bodyToTempParquet(forLead!);
    const leadRows = await withDuckDB(run =>
      run(`SELECT count(*) AS n FROM read_parquet('${leadFile}')`),
    );
    expect(Number(leadRows[0].n)).toBe(3);

    // The default-role stranger has the filter too, and matches nothing.
    const forStranger = await serve("__data/pipeline.parquet", STRANGER);
    const strangerFile = await bodyToTempParquet(forStranger!);
    const strangerRows = await withDuckDB(run =>
      run(`SELECT count(*) AS n FROM read_parquet('${strangerFile}')`),
    );
    expect(Number(strangerRows[0].n)).toBe(0);
  });
});

describe("an app without viewers is served as before", () => {
  it("identifies the viewer but scopes nothing, and still serves anonymously", async () => {
    const project = await createProject({
      workspaceId: WS,
      title: "Plain App",
      userId: USER,
    });
    const handle = await ensureWorktree(project, USER);
    await writeFile(
      handle,
      "bindings/rows.sql",
      ["-- connection: conn-1", "SELECT 1", ""].join("\n"),
    );
    const committed = await commitWorktree(handle, "a binding");
    const projectId = project._id.toString();
    const sha = committed.commitOid!;

    const viewer = await serveDeploymentFile({
      projectId,
      sha,
      assetPath: "__data/viewer.json",
      viewer: BDR,
    });
    expect(await viewer!.json()).toEqual({
      email: "sam@realadvisor.com",
      role: null,
      claims: {},
    });

    const anonymous = await serveDeploymentFile({
      projectId,
      sha,
      assetPath: "__data/index.json",
      viewer: null,
    });
    expect(anonymous?.status).toBe(200);
    expect(await anonymous!.json()).toContain("rows");
  });
});
