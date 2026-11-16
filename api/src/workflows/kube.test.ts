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
    autoscalerBodies,
    ensureAutoscaler,
    rollWorkersToRuntimeImage,
    workerSelector,
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
  assert.equal(
    env.WORKFLOWS_MAX_RUNS,
    String(WORKER_STEPS * WORKER_MAX_REPLICAS),
  );
  assert.equal(env.WORKFLOWS_RATE_LIMITS, undefined);
  assert.equal(body.spec?.replicas, 1);
  process.env.WORKFLOWS_RATE_LIMITS = "model=300/minute";
  process.env.WORKFLOWS_MAX_RUNS = "20";
  asked.replaced.length = 0;
  apps.listNamespacedDeployment = async () => ({
    items: [
      {
        ...worker("grown", OLD),
        spec: { ...worker("grown", OLD).spec, replicas: 4 },
      },
    ],
  });
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

  // The autoscaler: off unless asked for; with KEDA, an object that reads
  // Mako's demand with the worker's own key and sleeps at zero pods.
  const made: Array<{ plural: string; body: Record<string, unknown> }> = [];
  const custom = {
    getNamespacedCustomObject: async (req: { plural: string }) => {
      if (req.plural === "scaledobjects") {
        return { metadata: { resourceVersion: "3" } };
      }
      throw Object.assign(new Error(), { code: 404 });
    },
    createNamespacedCustomObject: async (req: {
      plural: string;
      body: Record<string, unknown>;
    }) => {
      made.push({ plural: req.plural, body: req.body });
    },
    replaceNamespacedCustomObject: async (req: {
      plural: string;
      body: Record<string, unknown>;
    }) => {
      made.push({ plural: req.plural, body: req.body });
    },
  };
  await ensureAutoscaler("ws1", custom as never);
  assert.equal(
    made.length,
    0,
    "no autoscaler unless WORKFLOWS_AUTOSCALER=keda",
  );
  process.env.WORKFLOWS_AUTOSCALER = "keda";
  await ensureAutoscaler("ws1", custom as never);
  assert.deepEqual(
    made.map(m => m.plural),
    ["triggerauthentications", "scaledobjects"],
  );
  const scaled = autoscalerBodies("ws1").ScaledObject;
  assert.equal(scaled.spec.scaleTargetRef.name, "wf-ws1");
  assert.equal(scaled.spec.minReplicaCount, 0);
  assert.equal(scaled.spec.maxReplicaCount, WORKER_MAX_REPLICAS);
  assert.deepEqual(scaled.spec.triggers[0].metadata, {
    url: "https://mako.test/api/workflows/runtime/demand",
    valueLocation: "steps",
    targetValue: String(WORKER_STEPS),
    activationTargetValue: "0",
    authMode: "bearer",
  });
  assert.deepEqual(
    autoscalerBodies("ws1").TriggerAuthentication.spec.secretTargetRef,
    [{ parameter: "token", name: "wf-ws1", key: "MAKO_API_KEY" }],
  );
  // An existing object is replaced at its version.
  assert.equal(
    (made[1].body.metadata as { resourceVersion?: string }).resourceVersion,
    "3",
  );
  delete process.env.WORKFLOWS_AUTOSCALER;

  // Without an image there is nothing to move to.
  delete process.env.WORKFLOWS_RUNTIME_IMAGE;
  assert.deepEqual(await rollWorkersToRuntimeImage(apps as never), []);

  console.log("workflow kube tests passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
