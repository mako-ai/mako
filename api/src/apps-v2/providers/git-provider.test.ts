import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppV2Scaffold } from "@mako/schemas";
import {
  AppV2ConflictError,
  AppV2LimitError,
  AppV2ValidationError,
} from "../errors";
import {
  AppV2GitProvider,
  getAppV2ProcessTerminationTarget,
} from "./git-provider";

function runTestGit(
  repositoryPath: string,
  args: string[],
  input?: Buffer,
  environment: NodeJS.ProcessEnv = {},
): string {
  const result = spawnSync("git", [`--git-dir=${repositoryPath}`, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...environment },
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function run(): Promise<void> {
  assert.equal(getAppV2ProcessTerminationTarget(123, "linux"), -123);
  assert.equal(getAppV2ProcessTerminationTarget(123, "win32"), 123);
  const root = await mkdtemp(path.join(os.tmpdir(), "apps-v2-git-test-"));
  try {
    const provider = new AppV2GitProvider(root, {
      maintenanceIntervalMs: 60_000,
      pruneRetentionMs: 1_000,
    });
    const initial = await provider.createRepository(
      "project",
      createAppV2Scaffold(),
    );
    assert.equal(
      await provider.resolveRef("project", "refs/heads/main"),
      initial.sha,
    );
    const initialTree = await provider.tree("project", initial.sha);
    assert(initialTree.some(entry => entry.path === "pnpm-lock.yaml"));
    assert(initialTree.some(entry => entry.path === ".mako/app.yaml"));
    assert.equal(
      (await provider.readFile("project", initial.sha, "src/App.tsx")).entry
        .mode,
      "regular",
    );
    const repositoryPath = provider.repositoryPath("project");
    assert.equal(
      runTestGit(repositoryPath, ["rev-parse", "--show-object-format"]),
      "sha1",
    );
    const symlinkBlob = runTestGit(
      repositoryPath,
      ["hash-object", "-w", "--stdin"],
      Buffer.from("../outside"),
    );
    const symlinkIndex = path.join(root, "symlink-index");
    const symlinkEnvironment = {
      GIT_INDEX_FILE: symlinkIndex,
      GIT_WORK_TREE: root,
    };
    runTestGit(
      repositoryPath,
      ["read-tree", initial.sha],
      undefined,
      symlinkEnvironment,
    );
    runTestGit(
      repositoryPath,
      ["update-index", "--add", "--cacheinfo", "120000", symlinkBlob, "link"],
      undefined,
      symlinkEnvironment,
    );
    const symlinkTree = runTestGit(
      repositoryPath,
      ["write-tree"],
      undefined,
      symlinkEnvironment,
    );
    await assert.rejects(
      provider.tree("project", symlinkTree),
      AppV2ValidationError,
    );

    const privateRef = await provider.createWorktreeRef(
      "project",
      "worktree",
      initial.sha,
    );
    assert.equal(
      await provider.resolveRef("project", privateRef.wipRef),
      initial.sha,
    );
    assert.equal(
      await provider.resolveRef("project", privateRef.leaseRef),
      privateRef.leaseOid,
    );
    assert.equal(
      (await provider.getLease("project", privateRef.leaseRef)).epoch,
      1,
    );
    const binary = Buffer.from([0, 1, 2, 255]);
    const binaryWrite = await provider.writeFile(
      "project",
      privateRef.wipRef,
      privateRef.wipOid,
      initial.sha,
      privateRef.leaseRef,
      privateRef.leaseOid,
      "public/image.bin",
      binary,
      false,
    );
    assert.deepEqual(
      (
        await provider.readFile(
          "project",
          binaryWrite.wipOid,
          "public/image.bin",
        )
      ).content,
      binary,
    );
    const rotatedLease = await provider.rotateLease(
      "project",
      privateRef.wipRef,
      binaryWrite.wipOid,
      privateRef.leaseRef,
      privateRef.leaseOid,
      2,
    );
    assert.equal(rotatedLease.epoch, 2);
    await assert.rejects(
      provider.writeFile(
        "project",
        privateRef.wipRef,
        binaryWrite.wipOid,
        initial.sha,
        privateRef.leaseRef,
        privateRef.leaseOid,
        "fenced.txt",
        Buffer.from("fenced"),
        false,
      ),
      AppV2ConflictError,
    );
    await assert.rejects(
      provider.writeFile(
        "project",
        privateRef.wipRef,
        privateRef.wipOid,
        initial.sha,
        privateRef.leaseRef,
        rotatedLease.oid,
        "stale.txt",
        Buffer.from("stale"),
        false,
      ),
      AppV2ConflictError,
    );
    await assert.rejects(
      provider.writeFile(
        "project",
        privateRef.wipRef,
        binaryWrite.wipOid,
        initial.sha,
        privateRef.leaseRef,
        privateRef.leaseOid,
        "SRC/app.tsx",
        Buffer.from("collision"),
        false,
      ),
      AppV2ValidationError,
    );

    const executableWrite = await provider.writeFile(
      "project",
      privateRef.wipRef,
      binaryWrite.wipOid,
      initial.sha,
      privateRef.leaseRef,
      rotatedLease.oid,
      "scripts/check.sh",
      Buffer.from("#!/bin/sh\nexit 0\n"),
      true,
    );
    assert.equal(
      await provider.isAncestor(
        "project",
        binaryWrite.wipOid,
        executableWrite.wipOid,
      ),
      false,
      "superseded WIP snapshots must not remain ancestors",
    );
    assert.deepEqual(
      (await provider.getCommit("project", executableWrite.wipOid)).parentShas,
      [initial.sha],
    );
    assert.equal(
      (
        await provider.readFile(
          "project",
          executableWrite.wipOid,
          "scripts/check.sh",
        )
      ).entry.mode,
      "executable",
    );
    const moved = await provider.moveFile(
      "project",
      privateRef.wipRef,
      executableWrite.wipOid,
      initial.sha,
      privateRef.leaseRef,
      rotatedLease.oid,
      "scripts/check.sh",
      "scripts/verify.sh",
    );
    assert.equal(
      (await provider.readFile("project", moved.wipOid, "scripts/verify.sh"))
        .entry.mode,
      "executable",
    );
    const deleted = await provider.deleteFile(
      "project",
      privateRef.wipRef,
      moved.wipOid,
      initial.sha,
      privateRef.leaseRef,
      rotatedLease.oid,
      "public/image.bin",
    );
    await assert.rejects(
      provider.readFile("project", deleted.wipOid, "public/image.bin"),
    );
    const dirtyStatus = await provider.status(
      "project",
      initial.sha,
      deleted.wipOid,
    );
    assert(dirtyStatus.some(change => change.path === "scripts/verify.sh"));
    assert.equal(
      await provider.isAncestor("project", deleted.wipOid, "refs/heads/main"),
      false,
    );

    const recoveredProvider = new AppV2GitProvider(root);
    assert.equal(
      await recoveredProvider.resolveRef("project", privateRef.wipRef),
      deleted.wipOid,
    );
    assert.equal(
      (
        await recoveredProvider.readFile(
          "project",
          deleted.wipOid,
          "scripts/verify.sh",
        )
      ).content.toString("utf8"),
      "#!/bin/sh\nexit 0\n",
    );
    const staleBranchRef = await recoveredProvider.createWorktreeRef(
      "project",
      "stale-worktree",
      initial.sha,
    );
    const staleBranchWrite = await recoveredProvider.writeFile(
      "project",
      staleBranchRef.wipRef,
      staleBranchRef.wipOid,
      initial.sha,
      staleBranchRef.leaseRef,
      staleBranchRef.leaseOid,
      "stale-branch.txt",
      Buffer.from("cannot overwrite main"),
      false,
    );
    const deletionFence = await recoveredProvider.fenceLease(
      "project",
      staleBranchRef.leaseRef,
      staleBranchRef.leaseOid,
      2,
    );
    assert.equal(deletionFence.epoch, 2);
    await assert.rejects(
      recoveredProvider.writeFile(
        "project",
        staleBranchRef.wipRef,
        staleBranchWrite.wipOid,
        initial.sha,
        staleBranchRef.leaseRef,
        staleBranchRef.leaseOid,
        "after-delete.txt",
        Buffer.from("must be fenced"),
        false,
      ),
      AppV2ConflictError,
    );

    const commit = await recoveredProvider.commit(
      "project",
      "main",
      privateRef.wipRef,
      deleted.wipOid,
      initial.sha,
      privateRef.leaseRef,
      rotatedLease.oid,
      "Add verification script",
    );
    assert.equal(
      await recoveredProvider.resolveRef("project", "refs/heads/main"),
      commit.sha,
    );
    assert.equal(
      await recoveredProvider.resolveRef("project", privateRef.wipRef),
      commit.sha,
    );
    assert.equal(commit.parentShas[0], initial.sha);
    assert.equal(commit.message, "Add verification script");
    assert(commit.stats.filesChanged >= 1);
    assert.equal(
      await recoveredProvider.isAncestor(
        "project",
        commit.sha,
        "refs/heads/main",
      ),
      true,
    );
    await assert.rejects(
      recoveredProvider.commit(
        "project",
        "main",
        staleBranchRef.wipRef,
        staleBranchWrite.wipOid,
        initial.sha,
        staleBranchRef.leaseRef,
        staleBranchRef.leaseOid,
        "Stale branch commit",
      ),
      AppV2ConflictError,
    );
    assert.equal(
      await recoveredProvider.resolveRef("project", staleBranchRef.wipRef),
      staleBranchWrite.wipOid,
    );
    assert.equal(
      (await recoveredProvider.listCommits("project", "main", 10))[0].sha,
      commit.sha,
    );

    const postCommitWrite = await recoveredProvider.writeFile(
      "project",
      privateRef.wipRef,
      commit.sha,
      commit.sha,
      privateRef.leaseRef,
      rotatedLease.oid,
      "discard-me.txt",
      Buffer.from("temporary"),
      false,
    );
    await assert.rejects(
      recoveredProvider.discard(
        "project",
        "refs/heads/main",
        initial.sha,
        privateRef.wipRef,
        postCommitWrite.wipOid,
        privateRef.leaseRef,
        rotatedLease.oid,
      ),
      AppV2ConflictError,
    );
    await assert.rejects(
      recoveredProvider.discard(
        "project",
        "refs/heads/main",
        commit.sha,
        privateRef.wipRef,
        postCommitWrite.wipOid,
        privateRef.leaseRef,
        privateRef.leaseOid,
      ),
      AppV2ConflictError,
    );
    assert.equal(
      await recoveredProvider.resolveRef("project", privateRef.wipRef),
      postCommitWrite.wipOid,
    );
    const discarded = await recoveredProvider.discard(
      "project",
      "refs/heads/main",
      commit.sha,
      privateRef.wipRef,
      postCommitWrite.wipOid,
      privateRef.leaseRef,
      rotatedLease.oid,
    );
    assert.equal(discarded.wipOid, commit.sha);
    assert.deepEqual(
      await recoveredProvider.status("project", commit.sha, commit.sha),
      [],
    );

    await new Promise(resolve => setTimeout(resolve, 1_200));
    await provider.runScheduledMaintenance("project", { force: true });
    await assert.rejects(
      provider.getCommit("project", binaryWrite.wipOid),
      /Commit not found/,
    );
    assert.equal(
      await provider.resolveRef("project", "refs/heads/main"),
      commit.sha,
    );

    const quotaProvider = new AppV2GitProvider(root, {
      maxRepositoryBytes: 32,
    });
    await assert.rejects(
      quotaProvider.createRepository("over-quota", createAppV2Scaffold()),
      AppV2LimitError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void run().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
