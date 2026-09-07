/**
 * Viewer roles, end to end through the published serving path (apps.md §27):
 * workspace members with a job role (the Members page), binding policies in
 * a real repo at a committed sha, a real artifact in the store, and
 * `serveDeploymentFile` answering as each viewer would see it — viewer.json,
 * the binding list, and the parquet bytes themselves.
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
  writeFile,
} from "./worktree.service";
import { bindingArtifactKey, readBindings } from "./bindings.service";
import { serveDeploymentFile } from "./deployment.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import { startTestGitServer, type TestGitServer } from "./test-git-server";
import { bindTestWorkspaceRepo } from "./bind-test-workspace-repo";
import { WorkspaceMember } from "../database/workspace-schema";
import { initRepo, repoDirFor } from "./repository.service";
import { seededTemplateFiles } from "./workspace-template";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let gitServer: TestGitServer;

const WS = new Types.ObjectId().toString();
const USER = "user-1";
const LEAD = { id: "u-lead", email: "Lead@RealAdvisor.com" };
const BDR = { id: "u-bdr", email: "sam@realadvisor.com" };
/** A member whose job role was never set. */
const UNASSIGNED = { id: "u-x", email: "nobody@realadvisor.com" };
/** Signed in, but not a member of this workspace at all. */
const OUTSIDER = { id: "u-out", email: "out@elsewhere.com" };

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
  await initRepo(repoDirFor(WS), seededTemplateFiles());
  await bindTestWorkspaceRepo(WS);
  // The Members page's doing: access role + job role (+ country) per person.
  await WorkspaceMember.create([
    {
      workspaceId: WS,
      userId: LEAD.id,
      role: "admin",
      jobRole: "team_leader",
      country: "FR",
    },
    {
      workspaceId: WS,
      userId: BDR.id,
      role: "viewer",
      jobRole: "bdr",
      country: "FR",
    },
    { workspaceId: WS, userId: UNASSIGNED.id, role: "viewer" },
  ]);
});

afterAll(async () => {
  await gitServer?.close();
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("an app with scoped bindings, served per member", () => {
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
      ["-- connection: conn-1", "-- roles: team_leader", "SELECT 2", ""].join(
        "\n",
      ),
    );
    await writeFile(
      handle,
      "bindings/by_country.sql",
      [
        "-- connection: conn-1",
        "-- row_filter_team_leader: country = {{ viewer.country }}",
        "SELECT 3",
        "",
      ].join("\n"),
    );
    await writeFile(
      handle,
      "bindings/open.sql",
      ["-- connection: conn-1", "SELECT 4", ""].join("\n"),
    );
    const committed = await commitWorktree(handle, "viewer roles");
    expect(committed.committed).toBe(true);
    sha = committed.commitOid!;

    const bindings = await readBindings(project, USER);
    const put = async (name: string, values: string, columns: string) => {
      const local = path.join(tmpRoot, `${name}.parquet`);
      await withDuckDB(run =>
        run(
          `COPY (SELECT * FROM (VALUES ${values}) t(${columns}))
           TO '${local.replace(/'/g, "''")}' (FORMAT PARQUET, COMPRESSION SNAPPY)`,
        ),
      );
      await getDashboardArtifactStore().put(
        local,
        bindingArtifactKey(bindings.find(b => b.name === name)!),
      );
    };
    await put(
      "pipeline",
      "('sam@realadvisor.com', 'Sam', 1), ('ana@realadvisor.com', 'Ana', 2), ('sam@realadvisor.com', 'Sam', 3)",
      "sales_rep_email, rep, n",
    );
    await put("by_country", "('FR', 1), ('CH', 2), ('FR', 3)", "country, n");
  });

  const serve = (
    assetPath: string,
    viewer: { id: string; email: string } | null,
  ) => serveDeploymentFile({ projectId, sha, assetPath, viewer });

  const rows = async (response: Response | null, sql: string) => {
    expect(response?.status).toBe(200);
    const file = await bodyToTempParquet(response!);
    return withDuckDB(run => run(sql.replace("{f}", file)));
  };

  it("tells each viewer who they are, from their membership", async () => {
    const lead = await serve("__data/viewer.json", LEAD);
    expect(lead?.status).toBe(200);
    expect(await lead!.json()).toEqual({
      email: "lead@realadvisor.com",
      role: "team_leader",
      claims: {
        email: "lead@realadvisor.com",
        role: "team_leader",
        country: "FR",
      },
    });
    expect((await (await serve("__data/viewer.json", BDR))!.json()).role).toBe(
      "bdr",
    );
    expect(
      (await (await serve("__data/viewer.json", UNASSIGNED))!.json()).role,
    ).toBeNull();
    expect(
      (await (await serve("__data/viewer.json", OUTSIDER))!.json()).role,
    ).toBeNull();
    // An anonymous share, or a token minted before viewers existed.
    const anonymous = await serve("__data/viewer.json", null);
    expect(await anonymous!.json()).toEqual({
      email: null,
      role: null,
      claims: {},
    });
  });

  it("lists only the bindings the role may read; no role reads only open ones", async () => {
    const names = async (viewer: { id: string; email: string } | null) =>
      (
        (await (await serve("__data/index.json", viewer))!.json()) as string[]
      ).sort();
    expect(await names(LEAD)).toEqual([
      "by_country",
      "leads_only",
      "open",
      "pipeline",
    ]);
    expect(await names(BDR)).toEqual(["by_country", "open", "pipeline"]);
    expect(await names(UNASSIGNED)).toEqual(["open"]);
    expect(await names(null)).toEqual(["open"]);
    expect(await serve("__data/leads_only.parquet", BDR)).toBeNull();
    expect(await serve("__data/pipeline.parquet", UNASSIGNED)).toBeNull();
    expect(await serve("__data/pipeline.parquet", null)).toBeNull();
  });

  it("serves the BDR their rows and the lead every row — as parquet bytes", async () => {
    const forBdr = await serve("__data/pipeline.parquet", BDR);
    expect(forBdr?.headers.get("content-type")).toBe(
      "application/vnd.apache.parquet",
    );
    expect(
      await rows(forBdr, "SELECT rep, n FROM read_parquet('{f}') ORDER BY n"),
    ).toEqual([
      { rep: "Sam", n: 1 },
      { rep: "Sam", n: 3 },
    ]);
    const forLead = await rows(
      await serve("__data/pipeline.parquet", LEAD),
      "SELECT count(*) AS n FROM read_parquet('{f}')",
    );
    expect(Number(forLead[0].n)).toBe(3);
  });

  it("filters on a claim the membership carries (country)", async () => {
    const forLead = await rows(
      await serve("__data/by_country.parquet", LEAD),
      "SELECT n FROM read_parquet('{f}') ORDER BY n",
    );
    expect(forLead).toEqual([{ n: 1 }, { n: 3 }]);
    // No filter for bdr on this binding: every row.
    const forBdr = await rows(
      await serve("__data/by_country.parquet", BDR),
      "SELECT count(*) AS n FROM read_parquet('{f}')",
    );
    expect(Number(forBdr[0].n)).toBe(3);
  });
});

describe("an app without scoped bindings is served as before", () => {
  it("identifies the member but scopes nothing, and still serves anonymously", async () => {
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
      role: "bdr",
      claims: { email: "sam@realadvisor.com", role: "bdr", country: "FR" },
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
