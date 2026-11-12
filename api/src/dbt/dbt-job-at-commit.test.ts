/**
 * readJobDefinitionAtCommit against a real bare repo: the three outcomes a
 * job trigger branches on, and the one it must never confuse with "deleted".
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
  resolveCommit,
} from "../apps/repository.service";
import { jobFilePath, serializeJobFile } from "./dbt-config-files";
import { readJobDefinitionAtCommit } from "./dbt-job-at-commit";

const WS = "5f0000000000000000000a01";
const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
let tmpRoot: string;

const nightly = {
  name: "Nightly build",
  environment: "prod",
  commands: ["build --select staging"],
  schedule: { cron: "0 6 * * *", timezone: "UTC" },
  enabled: true,
  deferToProduction: true,
};

async function commit(mutation: {
  writes?: Record<string, string>;
  deletes?: string[];
}): Promise<string> {
  const repoDir = repoDirFor(WS);
  await commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, mutation, {
    message: "test: job file",
  });
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) throw new Error("no head after commit");
  return head;
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dbt-job-at-commit-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  await initRepo(repoDirFor(WS), { "README.md": "x\n" });
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("readJobDefinitionAtCommit", () => {
  it("returns the parsed file and its blob sha at that commit, not at main", async () => {
    const first = serializeJobFile(nightly);
    const firstSha = await commit({
      writes: { [jobFilePath("nightly")]: first },
    });
    const second = serializeJobFile({
      ...nightly,
      commands: ["build --select marts"],
    });
    const secondSha = await commit({
      writes: { [jobFilePath("nightly")]: second },
    });

    const atFirst = await readJobDefinitionAtCommit(WS, "nightly", firstSha);
    expect(atFirst).toEqual({
      kind: "ok",
      file: nightly,
      blobSha: blobOid(first),
    });

    const atSecond = await readJobDefinitionAtCommit(WS, "nightly", secondSha);
    expect(atSecond.kind).toBe("ok");
    if (atSecond.kind !== "ok") return;
    expect(atSecond.file.commands).toEqual(["build --select marts"]);
    expect(atSecond.blobSha).toBe(blobOid(second));
  });

  it("reports a file that does not parse as invalid, with its blob sha", async () => {
    const broken = "name: [unterminated\n";
    const sha = await commit({ writes: { [jobFilePath("broken")]: broken } });
    expect(await readJobDefinitionAtCommit(WS, "broken", sha)).toEqual({
      kind: "invalid",
      blobSha: blobOid(broken),
    });

    // Parses as YAML, but is not a job (no commands).
    const empty = "name: x\nenvironment: prod\ncommands: []\n";
    const emptySha = await commit({
      writes: { [jobFilePath("broken")]: empty },
    });
    expect(await readJobDefinitionAtCommit(WS, "broken", emptySha)).toEqual({
      kind: "invalid",
      blobSha: blobOid(empty),
    });
  });

  it("reports missing when the file is gone at that commit, and still reads the older commit", async () => {
    const contents = serializeJobFile(nightly);
    const before = await commit({
      writes: { [jobFilePath("doomed")]: contents },
    });
    const after = await commit({ deletes: [jobFilePath("doomed")] });

    expect(await readJobDefinitionAtCommit(WS, "doomed", after)).toEqual({
      kind: "missing",
    });
    expect((await readJobDefinitionAtCommit(WS, "doomed", before)).kind).toBe(
      "ok",
    );
    expect(await readJobDefinitionAtCommit(WS, "never-existed", after)).toEqual(
      { kind: "missing" },
    );
  });

  it("throws for a commit the clone does not hold: a broken read is not a deleted job", async () => {
    await expect(
      readJobDefinitionAtCommit(
        WS,
        "nightly",
        "0123456789abcdef0123456789abcdef01234567",
      ),
    ).rejects.toThrow(/is not in the workspace repo/);
  });
});
