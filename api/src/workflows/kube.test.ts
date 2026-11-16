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
  const {
    WORKER_MAX_REPLICAS,
    WORKER_STEPS,
    rollWorkersToRuntimeImage,
    workerSelector,
    workerSteps,
  } = await import("./kube");

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
  let current: V1Deployment | undefined = undefined;
  const apps = {
    listNamespacedDeployment: async (req: { labelSelector?: string }) => {
      asked.selector = req.labelSelector;
      // A worker as this API makes it: the body of the first move.
      if (!current) return { items: [worker("seed", OLD)] };
      return {
        items: [
          worker("stale", OLD),
          current,
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
  assert.deepEqual(await rollWorkersToRuntimeImage(apps as never), ["seed"]);
  current = { ...worker("current", NEW), spec: asked.replaced[0].spec };
  asked.replaced.length = 0;
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

  // The pod and its slots are sized together, and a replace keeps the
  // number of pods the autoscaler chose.
  const [container] = body.spec?.template.spec?.containers ?? [];
  assert.deepEqual(container.resources, {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "2", memory: "3Gi" },
  });
  const env = Object.fromEntries(
    (container.env ?? []).map(e => [e.name, e.value]),
  );
  assert.equal(env.WORKFLOWS_MAX_STEPS, String(WORKER_STEPS));
  assert.equal(WORKER_STEPS, 128);
  assert.equal(env.WORKFLOWS_MAX_PROGRAMS, "16");
  assert.equal(env.WORKFLOWS_STEPS_PER_PROGRAM, "8");
  assert.equal(env.WORKFLOWS_MAX_RUNS, "250");
  assert.equal(env.WORKFLOWS_RATE_LIMITS, undefined);
  assert.equal(body.spec?.replicas, 1);
  process.env.WORKFLOWS_RATE_LIMITS = "model=300/minute";
  process.env.WORKFLOWS_MAX_RUNS = "20";
  asked.replaced.length = 0;
  const grown = worker("grown", OLD);
  grown.spec = { ...grown.spec, replicas: 4 } as V1Deployment["spec"];
  apps.listNamespacedDeployment = async () => ({ items: [grown] });
  assert.deepEqual(await rollWorkersToRuntimeImage(apps as never), ["grown"]);
  assert.equal(asked.replaced[0].spec?.replicas, 4);
  const grownEnv = Object.fromEntries(
    (asked.replaced[0].spec?.template.spec?.containers[0].env ?? []).map(e => [
      e.name,
      e.value,
    ]),
  );
  assert.equal(grownEnv.WORKFLOWS_RATE_LIMITS, "model=300/minute");
  assert.equal(grownEnv.WORKFLOWS_MAX_RUNS, "20");
  delete process.env.WORKFLOWS_RATE_LIMITS;
  delete process.env.WORKFLOWS_MAX_RUNS;

  // A setting changed on the API reaches a worker on the same image: one
  // step per program again is one setting, not a revert.
  process.env.WORKFLOWS_STEPS_PER_PROGRAM = "1";
  asked.replaced.length = 0;
  apps.listNamespacedDeployment = async () => ({
    items: [current as V1Deployment],
  });
  assert.deepEqual(await rollWorkersToRuntimeImage(apps as never), ["current"]);
  const single = Object.fromEntries(
    (asked.replaced[0].spec?.template.spec?.containers[0].env ?? []).map(e => [
      e.name,
      e.value,
    ]),
  );
  assert.equal(single.WORKFLOWS_STEPS_PER_PROGRAM, "1");
  assert.equal(single.WORKFLOWS_MAX_STEPS, "16");
  assert.equal(workerSteps(), 16);
  // Not a number of steps: the default.
  process.env.WORKFLOWS_STEPS_PER_PROGRAM = "many";
  assert.equal(workerSteps(), WORKER_STEPS);
  delete process.env.WORKFLOWS_STEPS_PER_PROGRAM;

  // The pod count: read with the list, and set from the count a worker has.
  // The pod template is left alone, so the pods that stay are not restarted.
  const { listWorkers, setWorkerReplicas } = await import("./kube");
  const scaled: V1Deployment[] = [];
  const three = worker("busy", NEW);
  three.spec = { ...three.spec, replicas: 3 } as V1Deployment["spec"];
  const scaling = {
    listNamespacedDeployment: async () => ({
      items: [three, worker("one", NEW)],
    }),
    readNamespacedDeployment: async (req: { name: string }) => {
      if (req.name === "wf-gone") {
        throw Object.assign(new Error(), { code: 404 });
      }
      return three;
    },
    replaceNamespacedDeployment: async (req: { body: V1Deployment }) => {
      scaled.push(req.body);
      return req.body;
    },
  };
  assert.deepEqual(await listWorkers(scaling as never), [
    { workspaceId: "busy", replicas: 3 },
    { workspaceId: "one", replicas: 1 },
  ]);
  assert.deepEqual(
    await setWorkerReplicas("busy", current => current - 1, scaling as never),
    { from: 3, to: 2 },
  );
  assert.equal(scaled[0].spec?.replicas, 2);
  assert.deepEqual(scaled[0].spec?.template, three.spec?.template);
  // Already there: nothing is written. Never more than the most, never
  // fewer than none, and a workspace without a worker has nothing to set.
  assert.deepEqual(await setWorkerReplicas("busy", () => 3, scaling as never), {
    from: 3,
    to: 3,
  });
  assert.equal(scaled.length, 1);
  assert.deepEqual(
    await setWorkerReplicas("busy", () => 99, scaling as never),
    { from: 3, to: WORKER_MAX_REPLICAS },
  );
  assert.deepEqual(
    await setWorkerReplicas("busy", () => -1, scaling as never),
    { from: 3, to: 0 },
  );
  assert.equal(
    await setWorkerReplicas("gone", () => 1, scaling as never),
    null,
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
