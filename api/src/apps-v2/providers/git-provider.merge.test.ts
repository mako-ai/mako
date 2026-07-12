import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppV2Scaffold } from "@mako/schemas";
import { AppV2ConflictError, AppV2MergeConflictError } from "../errors";
import { appV2ConversationBranch } from "../conversation-branch";
import { AppV2GitProvider } from "./git-provider";

const actor = { name: "Branch owner", email: "owner@mako.local" };

function runTestGit(repositoryPath: string, args: string[]): string {
  const result = spawnSync("git", [`--git-dir=${repositoryPath}`, ...args], {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function commitFile(
  provider: AppV2GitProvider,
  repositoryId: string,
  branch: string,
  worktreeId: string,
  baseSha: string,
  filePath: string,
  contents: string,
) {
  const refs = await provider.createWorktreeRef(
    repositoryId,
    worktreeId,
    baseSha,
  );
  const written = await provider.writeFile(
    repositoryId,
    refs.wipRef,
    refs.wipOid,
    baseSha,
    refs.leaseRef,
    refs.leaseOid,
    filePath,
    Buffer.from(contents),
    false,
  );
  const commit = await provider.commit(
    repositoryId,
    branch,
    refs.wipRef,
    written.wipOid,
    baseSha,
    refs.leaseRef,
    refs.leaseOid,
    `Update ${filePath}`,
  );
  return { commit, refs };
}

async function run(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "apps-v2-merge-test-"));
  const provider = new AppV2GitProvider(root);
  try {
    const chatId = "64b7f0f0f0f0f0f0f0f0f0f0";
    const branch = appV2ConversationBranch(chatId);
    const initial = await provider.createRepository(
      "fast-forward",
      createAppV2Scaffold(),
    );
    await provider.ensureBranch("fast-forward", branch, initial.sha);
    const branchCommit = await commitFile(
      provider,
      "fast-forward",
      branch,
      "chat",
      initial.sha,
      "src/branch.ts",
      "export const committed = true;\n",
    );
    const uncommitted = await provider.writeFile(
      "fast-forward",
      branchCommit.refs.wipRef,
      branchCommit.commit.sha,
      branchCommit.commit.sha,
      branchCommit.refs.leaseRef,
      branchCommit.refs.leaseOid,
      "src/wip.ts",
      Buffer.from("export const wip = true;\n"),
      false,
    );
    assert.notEqual(uncommitted.wipOid, branchCommit.commit.sha);
    runTestGit(provider.repositoryPath("fast-forward"), [
      "update-ref",
      "refs/heads/unmanaged",
      initial.sha,
    ]);

    const listed = await provider.listBranches("fast-forward", "main");
    assert.deepEqual(
      listed.map(item => item.name),
      ["main", branch],
    );
    assert.equal(listed[1].aheadBy, 1);
    assert.equal(listed[1].behindBy, 0);
    assert.equal(listed[1].headSha, branchCommit.commit.sha);
    assert.equal(listed[1].lastCommit.sha, branchCommit.commit.sha);

    const fastForward = await provider.mergeConversationBranchToDefault(
      "fast-forward",
      "main",
      branch,
      initial.sha,
      branchCommit.commit.sha,
      actor,
    );
    assert.equal(fastForward.fastForward, true);
    assert.equal(fastForward.mergedSha, branchCommit.commit.sha);
    assert(
      !(await provider.tree("fast-forward", fastForward.mergedSha)).some(
        entry => entry.path === "src/wip.ts",
      ),
      "uncommitted WIP must not be merged",
    );

    const divergentInitial = await provider.createRepository(
      "divergent",
      createAppV2Scaffold(),
    );
    await provider.ensureBranch("divergent", branch, divergentInitial.sha);
    const divergentBranch = await commitFile(
      provider,
      "divergent",
      branch,
      "divergent-chat",
      divergentInitial.sha,
      "src/branch.ts",
      "export const branch = true;\n",
    );
    const divergentMain = await commitFile(
      provider,
      "divergent",
      "main",
      "divergent-main",
      divergentInitial.sha,
      "src/main-only.ts",
      "export const main = true;\n",
    );
    const merged = await provider.mergeConversationBranchToDefault(
      "divergent",
      "main",
      branch,
      divergentMain.commit.sha,
      divergentBranch.commit.sha,
      actor,
    );
    assert.equal(merged.fastForward, false);
    const mergeCommit = await provider.getCommit("divergent", merged.mergedSha);
    assert.deepEqual(mergeCommit.parentShas, [
      divergentMain.commit.sha,
      divergentBranch.commit.sha,
    ]);

    const conflictInitial = await provider.createRepository(
      "conflict",
      createAppV2Scaffold(),
    );
    await provider.ensureBranch("conflict", branch, conflictInitial.sha);
    const conflictBranch = await commitFile(
      provider,
      "conflict",
      branch,
      "conflict-chat",
      conflictInitial.sha,
      "src/App.tsx",
      "export default function App() { return <p>branch</p>; }\n",
    );
    const conflictMain = await commitFile(
      provider,
      "conflict",
      "main",
      "conflict-main",
      conflictInitial.sha,
      "src/App.tsx",
      "export default function App() { return <p>main</p>; }\n",
    );
    await assert.rejects(
      provider.mergeConversationBranchToDefault(
        "conflict",
        "main",
        branch,
        conflictMain.commit.sha,
        conflictBranch.commit.sha,
        actor,
      ),
      AppV2MergeConflictError,
    );
    assert.equal(
      await provider.resolveBranch("conflict", "main"),
      conflictMain.commit.sha,
    );

    await assert.rejects(
      provider.mergeConversationBranchToDefault(
        "divergent",
        "main",
        branch,
        divergentMain.commit.sha,
        divergentBranch.commit.sha,
        actor,
      ),
      AppV2ConflictError,
    );
    assert.equal(
      await provider.resolveBranch("divergent", "main"),
      merged.mergedSha,
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
