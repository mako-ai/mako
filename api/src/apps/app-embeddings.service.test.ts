/**
 * App embeddings, end to end without a network: the refresh after the
 * index moves (real git, real Mongo, a fake embedding model) re-embeds only
 * what changed, and a search falls back to words when the model is slow.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const fake = vi.hoisted(() => ({
  repoDir: "",
  embedded: [] as string[],
  queryDelayMs: 0,
}));

/** A deterministic 3-d "embedding": which of three words the text says. */
function vectorOf(text: string): number[] {
  const t = text.toLowerCase();
  return [
    t.includes("acquisition") ? 1 : 0.05,
    t.includes("renewal") ? 1 : 0.05,
    t.includes("hiring") ? 1 : 0.05,
  ];
}

vi.mock("../services/embedding.service", () => ({
  getEmbeddingModelName: () => "fake-model",
  isEmbeddingAvailable: () => true,
  embedTexts: async (texts: string[]) => {
    fake.embedded.push(...texts);
    return texts.map(vectorOf);
  },
  embedText: async (text: string) => {
    if (fake.queryDelayMs) {
      await new Promise(r => setTimeout(r, fake.queryDelayMs));
    }
    return vectorOf(text);
  },
}));
vi.mock("./workspace-repo-required", () => ({
  boundRepoDirIfExists: async () => fake.repoDir,
}));
vi.mock("./app-index.service", () => ({
  loadAppsIndex: vi.fn(),
}));

import { AppEmbedding } from "../database/workspace-schema";
import {
  appEmbeddingsSettled,
  resetAppEmbeddingsState,
  scheduleAppEmbeddings,
} from "./app-embeddings.service";
import type { AppIndexRow, AppsIndexSnapshot } from "./app-index.service";
import { relatedSignals } from "./app-search.service";

const ws = new Types.ObjectId().toHexString();
let mongo: MongoMemoryServer;
const dir = mkdtempSync(path.join(tmpdir(), "app-embeddings-"));
const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

function writeApp(slug: string, label: string) {
  const appDir = path.join(dir, "apps", slug);
  mkdirSync(path.join(appDir, "src"), { recursive: true });
  writeFileSync(path.join(appDir, "mako.json"), `{"title":"${slug}"}`);
  writeFileSync(
    path.join(appDir, "src", "App.tsx"),
    `<Picker label="${label}" />`,
  );
}

function commit(): AppsIndexSnapshot {
  git("add", "-A");
  git(
    "-c",
    "user.email=t@x",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-qm",
    "c",
  );
  const sha = git("rev-parse", "HEAD");
  const tree = (p: string) => git("rev-parse", `HEAD:${p}`);
  const slugs = git("ls-tree", "--name-only", "HEAD", "apps/").split("\n");
  return {
    sha,
    folders: [],
    apps: slugs.map(
      p =>
        ({
          appId: new Types.ObjectId(
            Buffer.from(p.padEnd(12, "_").slice(-12)).toString("hex"),
          ).toHexString(),
          path: p,
          slug: p.split("/").pop() ?? p,
          scope: "workspace",
          treeOid: tree(p),
          title: p.split("/").pop() ?? p,
          hasManifestId: false,
          schedules: [],
          bindings: [],
          tables: [],
        }) as AppIndexRow,
    ),
  };
}

async function refresh(snapshot: AppsIndexSnapshot) {
  scheduleAppEmbeddings(ws, snapshot, { force: true });
  await appEmbeddingsSettled(ws);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  fake.repoDir = dir;
  git("init", "-q");
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  fake.embedded = [];
  fake.queryDelayMs = 0;
});

describe("app embeddings refresh", () => {
  it("embeds every app once, then only what changed", async () => {
    writeApp("sales", "Acquisition channel");
    writeApp("renewals", "Renewal rate");
    let snap = commit();
    await refresh(snap);
    expect(fake.embedded).toHaveLength(2);
    expect(await AppEmbedding.countDocuments({ workspaceId: ws })).toBe(2);
    const sales = await AppEmbedding.findOne({ path: "apps/sales" }).lean();
    expect(sales?.terms).toContain("acquisition");

    // Same tree: nothing read, nothing embedded.
    fake.embedded = [];
    resetAppEmbeddingsState();
    await refresh(snap);
    expect(fake.embedded).toHaveLength(0);

    // One app changes, one is removed, one is added.
    writeApp("sales", "Hiring plan");
    rmSync(path.join(dir, "apps", "renewals"), { recursive: true });
    writeApp("people", "Hiring pipeline");
    snap = commit();
    await refresh(snap);
    expect(fake.embedded).toHaveLength(2);
    const rows = await AppEmbedding.find({ workspaceId: ws }).lean();
    expect(rows.map(r => r.path).sort()).toEqual(["apps/people", "apps/sales"]);
  });

  it("serves related signals, and nothing when the model is slow", async () => {
    const snap = commit();
    resetAppEmbeddingsState();
    const ids = snap.apps.map(a => a.appId);
    const signals = await relatedSignals(ws, "hiring", ids);
    expect(signals?.similarity.size).toBe(2);
    for (const v of signals?.similarity.values() ?? []) {
      expect(v).toBeGreaterThan(0.9);
    }
    fake.queryDelayMs = 200;
    expect(
      await relatedSignals(ws, "something slow", ids, { timeoutMs: 20 }),
    ).toBeNull();
  });
});
