/**
 * What a push deploys: the workspace's slot follows `workflows/` on main.
 * What leaves the repository leaves the worker. Real git, PGlite,
 * a stored Hatchet token so no Hatchet is asked anything.
 *
 * Run with: pnpm --filter api exec tsx src/workflows/on-push.test.ts
 */
import assert from "node:assert/strict";
import { ensureTestWorkspace, setupPgTestDb } from "../test-support/pg-test";
import { workspaceRepo } from "../repositories/workspaces";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TOKEN = `x.${Buffer.from(
  JSON.stringify({ sub: "t", server_url: "https://hatchet.test" }),
).toString("base64url")}.y`;
const WORKFLOW = 'export default { name: "digest" };\n';

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mako-wf-push-"));
  process.env.APPS_GIT_ROOT = path.join(tmp, "repos");
  delete process.env.WORKFLOWS_WORKER_KEY;
  const h = await setupPgTestDb();
  const { runGit } = await import("../apps/git");
  const { initRepo, repoDirFor } = await import("../apps/repository.service");
  const { deployCarries, deployWorkflowsFromRepo, hasWorkflowsToDeploy } =
    await import("./on-push");
  try {
    const { id: ws } = await ensureTestWorkspace(h.db, {
      ownerUserId: "owner",
    });
    await workspaceRepo.setWorkflowHatchetToken(ws, TOKEN);
    const repo = repoDirFor(ws);
    await initRepo(repo, { "README.md": "hi\n" });
    const git = (...args: string[]) => runGit(["-C", repo, ...args]);
    const slots = async () => (await workspaceRepo.findById(ws))?.workflows;

    // A commit on `branch`, from `parent`, with these files on top of it.
    const commit = async (
      branch: string,
      parent: string,
      files: Record<string, string | null>,
    ) => {
      const work = await fs.mkdtemp(path.join(tmp, "work-"));
      await runGit(["clone", "-q", repo, work]);
      await runGit(["-C", work, "checkout", "-q", parent]);
      for (const [file, body] of Object.entries(files)) {
        const target = path.join(work, file);
        if (body === null) await fs.rm(target, { recursive: true });
        else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, body);
        }
      }
      await runGit(["-C", work, "add", "-A"]);
      await runGit([
        ...["-C", work, "-c", "user.email=t@t", "-c", "user.name=T"],
        ...["commit", "-qm", branch],
      ]);
      await runGit(["-C", work, "push", "-q", "origin", `HEAD:${branch}`]);
      return (await git("rev-parse", `refs/heads/${branch}`)).stdout.trim();
    };

    // No workflows anywhere: nothing is set, and a push asks for no deploy.
    assert.equal(await hasWorkflowsToDeploy(ws), false);
    await deployWorkflowsFromRepo(ws, "owner");
    assert.equal((await slots())?.live, undefined);

    // A workflow committed on main is live.
    const onMain = await commit("main", "main", {
      "workflows/digest/workflow.ts": WORKFLOW,
    });
    assert.equal(await hasWorkflowsToDeploy(ws), true);
    await deployWorkflowsFromRepo(ws, "owner");
    assert.equal((await slots())?.live?.sha, onMain);

    // A static worker's key made before a scope existed gains it on the next
    // deploy, as a pod's does: the worker writes as its workflow only with
    // workflows:runtime and query:write.
    const { hashApiKey } = await import("../auth/api-key.middleware");
    const staticKey = "revops_static_worker_key_tests_only";
    await workspaceRepo.createApiKey({
      workspaceId: ws,
      name: "Workflows worker",
      keyHash: hashApiKey(staticKey),
      prefix: staticKey.slice(0, 14),
      scopes: ["mcp", "query:read"],
      createdBy: "owner",
    });
    process.env.WORKFLOWS_WORKER_KEY = staticKey;
    await deployWorkflowsFromRepo(ws);
    delete process.env.WORKFLOWS_WORKER_KEY;
    const workerKey = (await workspaceRepo.listApiKeys(ws)).find(
      key => key.name === "Workflows worker",
    );
    assert.deepEqual(workerKey?.scopes, [
      "mcp",
      "query:write",
      "workflows:runtime",
    ]);

    // A commit elsewhere in the repository leaves the slot alone: the worker
    // is pointed at a new commit only when `workflows/` changed.
    await commit("main", "main", { "README.md": "changed\n" });
    await deployWorkflowsFromRepo(ws);
    assert.equal((await slots())?.live?.sha, onMain);

    // What a wait on a commit's deploy asks (workflows_status { sha }): a
    // commit that left `workflows/` alone is carried by the target as it
    // is, though the target never becomes that commit.
    const live = async () => {
      const slot = (await slots())?.live;
      assert.ok(slot?.sha && slot.tree);
      return { sha: slot.sha, tree: slot.tree };
    };
    const readme = (await git("rev-parse", "refs/heads/main")).stdout.trim();
    assert.equal(await deployCarries(ws, readme, await live()), true);
    // Commit A, then B before A went live: B's deploy carries A.
    const a = await commit("main", "main", {
      "workflows/digest/workflow.ts": `${WORKFLOW}// a\n`,
    });
    const before = await live();
    assert.equal(await deployCarries(ws, a, before), false);
    const b = await commit("main", "main", {
      "workflows/digest/workflow.ts": `${WORKFLOW}// b\n`,
    });
    await deployWorkflowsFromRepo(ws);
    assert.equal((await slots())?.live?.sha, b);
    assert.equal(await deployCarries(ws, a, await live()), true);
    // A commit main does not hold is never deployed: say so, not wait.
    const branchOnly = await commit("side", "main", { "x.txt": "x\n" });
    await assert.rejects(
      deployCarries(ws, branchOnly, await live()),
      /not on main/,
    );
    await assert.rejects(
      deployCarries(ws, "c".repeat(40), await live()),
      /not in this workspace's repository/,
    );

    // `workflows/` deleted on main: still a deploy (something is live to
    // drop), and then nothing is live and nothing more to ask for.
    await commit("main", "main", { workflows: null });
    assert.equal(await hasWorkflowsToDeploy(ws), true);
    await deployWorkflowsFromRepo(ws);
    assert.equal((await slots())?.live, undefined);
    assert.equal(await hasWorkflowsToDeploy(ws), false);

    console.log("workflows on-push tests passed");
  } finally {
    await h.close();
    await fs.rm(tmp, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
