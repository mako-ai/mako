/**
 * Workers move to the runtime image the API names when it starts: only this
 * environment's, only those on another image, and a lost race (409) is the
 * winner's. Kubernetes is a fake that records what it is asked.
 *
 * Run with: pnpm --filter api exec tsx src/workflows/kube.test.ts
 */
import assert from "node:assert/strict";
import type { V1Deployment } from "@kubernetes/client-node";

const NEW = "registry/workflows-runtime:runtime-bbbb";
const OLD = "registry/workflows-runtime:latest";

function worker(workspaceId: string, image: string): V1Deployment {
  return {
    metadata: {
      name: `wf-${workspaceId}`,
      resourceVersion: "7",
      labels: { "mako.ai/workspace": workspaceId },
    },
    spec: {
      selector: {},
      template: { spec: { containers: [{ name: "worker", image }] } },
    },
  };
}

async function main() {
  process.env.WORKFLOWS_RUNTIME_IMAGE = NEW;
  process.env.BASE_URL = "https://mako.test";
  delete process.env.WORKFLOWS_NAME_PREFIX;
  const { rollWorkersToRuntimeImage, workerSelector } = await import("./kube");

  // Production has no env label; a preview selects its own.
  assert.equal(
    workerSelector(),
    "app.kubernetes.io/name=mako-workflow-worker,!mako.ai/env",
  );
  process.env.WORKFLOWS_NAME_PREFIX = "pr-12-";
  assert.equal(
    workerSelector(),
    "app.kubernetes.io/name=mako-workflow-worker,mako.ai/env=pr-12",
  );
  delete process.env.WORKFLOWS_NAME_PREFIX;

  const asked: { selector?: string; replaced: V1Deployment[] } = {
    replaced: [],
  };
  const apps = {
    listNamespacedDeployment: async (req: { labelSelector?: string }) => {
      asked.selector = req.labelSelector;
      return {
        items: [
          worker("stale", OLD),
          worker("current", NEW),
          worker("raced", OLD),
          worker("broken", OLD),
        ],
      };
    },
    replaceNamespacedDeployment: async (req: {
      name: string;
      body: V1Deployment;
    }) => {
      if (req.name === "wf-raced") {
        throw Object.assign(new Error(), { code: 409 });
      }
      if (req.name === "wf-broken") throw new Error("forbidden");
      asked.replaced.push(req.body);
      return req.body;
    },
  };
  const moved = await rollWorkersToRuntimeImage(apps as never);
  assert.deepEqual(moved, ["stale"]);
  assert.equal(asked.selector, workerSelector());
  assert.equal(asked.replaced.length, 1);
  const [body] = asked.replaced;
  assert.equal(body.metadata?.name, "wf-stale");
  assert.equal(body.metadata?.resourceVersion, "7");
  assert.equal(body.spec?.template.spec?.containers[0].image, NEW);
  assert.ok(
    body.spec?.template.metadata?.annotations?.["mako.ai/restarted"],
    "the pod template changes, so new pods start",
  );

  // Without an image there is nothing to move to.
  delete process.env.WORKFLOWS_RUNTIME_IMAGE;
  assert.deepEqual(await rollWorkersToRuntimeImage(apps as never), []);

  console.log("workflow kube tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
