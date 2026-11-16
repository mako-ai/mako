/**
 * The `gke` worker provider: one sandboxed pod per workspace, for workflows
 * written by people the operator does not know. A Secret and a Deployment
 * named `wf-<prefix><id>`, created once: the pod holds its Mako API key and
 * asks Mako which commit to run, so a deploy never touches Kubernetes.
 */
import { CustomObjectsApi, type V1Deployment } from "@kubernetes/client-node";

import { loggers } from "../logging";
import {
  gkeClients,
  gkeCustomObjects,
  isGkeProviderConfigured,
} from "../services/kernel-provider/gke-kernel-provider";
import { workflowsNamePrefix } from "./hatchet";

const logger = loggers.api("workflows-kube");

const NAMESPACE = "mako-workflows";
// The network policy selects worker pods by this label.
const POD_NAME_LABEL = "mako-workflow-worker";
const WORKSPACE_LABEL = "mako.ai/workspace";
const ENV_LABEL = "mako.ai/env";

/**
 * The size of one worker pod, set together. A workflow's steps run in step
 * programs of that workflow, each a Node process of about 100 MB running up
 * to WORKER_STEPS_PER_PROGRAM steps at once (worker.mjs): 16 programs with
 * 128 steps under way were measured at 1.45 GiB, and the dispatcher and
 * entrypoint take about 300 MB with a typecheck running. Steps wait on the
 * network, so they share 2 CPUs; the request is what an idle pod uses.
 */
const WORKER_PROGRAMS = 16;
const WORKER_STEPS_PER_PROGRAM = 8;
export const WORKER_STEPS = WORKER_PROGRAMS * WORKER_STEPS_PER_PROGRAM;

/**
 * Steps a step program runs at once: WORKFLOWS_STEPS_PER_PROGRAM on the API
 * (1 to 32), else 8. Set it to 1 to go back to a program per step, 16 steps
 * a pod, without a new build: workers move to it when the API next starts.
 */
function stepsPerProgram(): number {
  const asked = Number(process.env.WORKFLOWS_STEPS_PER_PROGRAM);
  return Number.isInteger(asked) && asked >= 1 && asked <= 32
    ? asked
    : WORKER_STEPS_PER_PROGRAM;
}

/** Steps one pod runs at once, as set now. */
export function workerSteps(): number {
  return WORKER_PROGRAMS * stepsPerProgram();
}
const WORKER_RESOURCES = {
  requests: { cpu: "250m", memory: "512Mi" },
  limits: { cpu: "2", memory: "3Gi" },
};

/**
 * The most pods one workspace's worker grows to (the autoscaler below):
 * 5 x 128 steps at once. The namespace quota (deploy/workflows/k8s) holds
 * 16 such pods for all workspaces together.
 */
export const WORKER_MAX_REPLICAS = 5;

/**
 * Runs of one workflow executing at once, unless the workflow declares its
 * own `concurrency` (worker.mjs); the rest wait in Hatchet in the order
 * they came. 250 is the most the load test has run (deploy/workflows
 * README): two pods hold it, and Hatchet's database was at its 2 CPUs
 * there. Raise it with the database, not alone.
 */
const MAX_RUNS = 250;

/** True when this API instance can create worker pods. */
export function isGkeWorkerConfigured(): boolean {
  return isGkeProviderConfigured() && Boolean(runtimeImage());
}

function runtimeImage(): string | undefined {
  return process.env.WORKFLOWS_RUNTIME_IMAGE;
}

/**
 * The URL worker pods call Mako on. Pods have HTTPS egress only, and deployed
 * they must use the direct Cloud Run URL the kernels use: the public hostname
 * is behind Cloudflare, which blocks requests from the cluster.
 */
function makoUrl(): string {
  const url = process.env.NOTEBOOK_KERNEL_API_URL || process.env.BASE_URL;
  if (!url) throw new Error("Set NOTEBOOK_KERNEL_API_URL or BASE_URL");
  return url.replace(/\/+$/, "");
}

function workerName(workspaceId: string): string {
  return `wf-${workflowsNamePrefix()}${workspaceId}`;
}

/**
 * Labels on a workspace's Secret and Deployment. Previews add their prefix so
 * `cleanup-preview.yml` can delete a closed PR's workers by label.
 */
function resourceLabels(workspaceId: string): Record<string, string> {
  const env = workflowsNamePrefix().replace(/-+$/, "");
  return {
    [WORKSPACE_LABEL]: workspaceId,
    ...(env ? { [ENV_LABEL]: env } : {}),
  };
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 404;
}

export async function workerSecretExists(
  workspaceId: string,
): Promise<boolean> {
  const { core } = await gkeClients();
  try {
    await core.readNamespacedSecret({
      name: workerName(workspaceId),
      namespace: NAMESPACE,
    });
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/**
 * Write the worker's credential, replacing an earlier one. A pod reads the
 * Secret when it starts, so the caller restarts a running worker afterwards
 * (`ensureWorkerDeployment` with `restart`).
 */
export async function writeWorkerSecret(
  workspaceId: string,
  makoApiKey: string,
): Promise<void> {
  const { core } = await gkeClients();
  const name = workerName(workspaceId);
  const body = {
    metadata: { name, labels: resourceLabels(workspaceId) },
    stringData: { MAKO_API_KEY: makoApiKey },
  };
  if (await workerSecretExists(workspaceId)) {
    await core.replaceNamespacedSecret({ name, namespace: NAMESPACE, body });
  } else {
    await core.createNamespacedSecret({ namespace: NAMESPACE, body });
  }
}

/** Settings an operator may pass to every worker, each with its default. */
function limitsEnv(): Array<{ name: string; value: string }> {
  const env = [
    { name: "WORKFLOWS_MAX_STEPS", value: String(workerSteps()) },
    { name: "WORKFLOWS_MAX_PROGRAMS", value: String(WORKER_PROGRAMS) },
    {
      name: "WORKFLOWS_STEPS_PER_PROGRAM",
      value: String(stepsPerProgram()),
    },
    {
      name: "WORKFLOWS_MAX_RUNS",
      value: process.env.WORKFLOWS_MAX_RUNS || String(MAX_RUNS),
    },
  ];
  // Named rate limits a step can take from: `model=300/minute,mail=60/minute`.
  const rateLimits = process.env.WORKFLOWS_RATE_LIMITS;
  if (rateLimits) {
    env.push({ name: "WORKFLOWS_RATE_LIMITS", value: rateLimits });
  }
  return env;
}

function deploymentBody(workspaceId: string, replicas = 1): V1Deployment {
  const name = workerName(workspaceId);
  const labels = {
    "app.kubernetes.io/name": POD_NAME_LABEL,
    ...resourceLabels(workspaceId),
  };
  const tls = process.env.HATCHET_CLIENT_TLS_STRATEGY;
  return {
    metadata: { name, labels },
    spec: {
      // More than one pod is fine: each is a Hatchet worker of its own, and
      // Hatchet hands a step to one of them. A replace keeps the count the
      // autoscaler chose.
      replicas,
      // A new pod (a new runtime image) is ready only once it runs a commit,
      // and the old pod is stopped only then.
      strategy: {
        type: "RollingUpdate",
        rollingUpdate: { maxSurge: 1, maxUnavailable: 0 },
      },
      selector: { matchLabels: { [WORKSPACE_LABEL]: workspaceId } },
      template: {
        metadata: { labels },
        spec: {
          runtimeClassName: "gvisor",
          nodeSelector: { "mako.ai/pool": "kernels" },
          tolerations: [
            {
              key: "mako.ai/kernels",
              operator: "Equal",
              value: "true",
              effect: "NoSchedule",
            },
          ],
          automountServiceAccountToken: false,
          // Long enough for a running task to finish when the pod is
          // replaced. Hatchet retries what does not finish in time.
          terminationGracePeriodSeconds: 1800,
          // Root inside gVisor, holding only what starting each workflow's
          // steps as that workflow's own user takes (worker.mjs): workflow
          // code never runs as root, nor as another workflow's user.
          securityContext: {
            runAsUser: 0,
            runAsGroup: 0,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "worker",
              image: runtimeImage(),
              // A tag can be published again (a rebuilt runtime, `:latest`
              // as a fallback); a digest check per pod start is cheap.
              imagePullPolicy: "Always",
              env: [
                { name: "MAKO_URL", value: makoUrl() },
                { name: "HOME", value: "/tmp" },
                ...limitsEnv(),
                // A Hatchet without TLS on its gRPC port, as Mako's own is.
                ...(tls
                  ? [{ name: "HATCHET_CLIENT_TLS_STRATEGY", value: tls }]
                  : []),
              ],
              envFrom: [{ secretRef: { name } }],
              readinessProbe: {
                exec: { command: ["test", "-f", "/tmp/ready"] },
                periodSeconds: 5,
              },
              // Sized with WORKER_STEPS, above. Only the request is reserved.
              resources: WORKER_RESOURCES,
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: {
                  drop: ["ALL"],
                  add: ["SETUID", "SETGID", "CHOWN", "KILL"],
                },
              },
              volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "tmp", emptyDir: {} }],
        },
      },
    },
  };
}

/**
 * Whether a worker Deployment is as this API would make it: its image, its
 * size and its limits. A setting changed on the API (WORKFLOWS_MAX_RUNS,
 * WORKFLOWS_STEPS_PER_PROGRAM, WORKFLOWS_RATE_LIMITS) then reaches the
 * workers when the API starts, as a new image does.
 */
function isCurrent(deployment: V1Deployment): boolean {
  const container = deployment.spec?.template?.spec?.containers?.[0];
  if (container?.image !== runtimeImage()) return false;
  const has = new Map(
    (container?.env ?? [])
      .filter(entry => entry.name.startsWith("WORKFLOWS_"))
      .map(entry => [entry.name, entry.value]),
  );
  const wanted = limitsEnv();
  return (
    has.size === wanted.length &&
    wanted.every(entry => has.get(entry.name) === entry.value) &&
    JSON.stringify(container?.resources?.limits) ===
      JSON.stringify(WORKER_RESOURCES.limits) &&
    JSON.stringify(container?.resources?.requests) ===
      JSON.stringify(WORKER_RESOURCES.requests)
  );
}

/** The image a worker Deployment runs. */
function workerImage(deployment: V1Deployment): string | undefined {
  return deployment.spec?.template?.spec?.containers?.[0]?.image;
}

type AppsClient = Awaited<ReturnType<typeof gkeClients>>["apps"];

/**
 * Replace `existing` with the current body, which starts new pods: the image
 * is the API's, and the stamp changes the pod template even when it is not.
 */
async function replaceWorker(
  apps: AppsClient,
  workspaceId: string,
  existing: V1Deployment,
  reason: string,
): Promise<void> {
  const body = deploymentBody(workspaceId, existing.spec?.replicas ?? 1);
  body.metadata = {
    ...body.metadata,
    resourceVersion: existing.metadata?.resourceVersion,
  };
  // A changed pod template is what makes Kubernetes start new pods.
  body.spec!.template.metadata!.annotations = {
    "mako.ai/restarted": new Date().toISOString(),
  };
  await apps.replaceNamespacedDeployment({
    name: workerName(workspaceId),
    namespace: NAMESPACE,
    body,
  });
  logger.info("Replaced workflow worker", {
    workspaceId,
    from: workerImage(existing),
    to: runtimeImage(),
    reason,
  });
}

/**
 * Make sure the workspace's worker pod exists and runs the current runtime
 * image. An existing Deployment is replaced, which starts new pods, only
 * when its image differs or `restart` is asked for (a new credential).
 */
export async function ensureWorkerDeployment(
  workspaceId: string,
  restart = false,
): Promise<void> {
  const { apps } = await gkeClients();
  const name = workerName(workspaceId);
  let existing: V1Deployment;
  try {
    existing = await apps.readNamespacedDeployment({
      name,
      namespace: NAMESPACE,
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await apps.createNamespacedDeployment({
      namespace: NAMESPACE,
      body: deploymentBody(workspaceId),
    });
    logger.info("Created workflow worker", { workspaceId });
    await ensureAutoscaler(workspaceId);
    return;
  }
  // Only the image and a new credential here. A changed setting moves
  // workers when the API starts (`rollWorkersToRuntimeImage`), and not on a
  // push: while a new revision takes over, the old one still serves pushes,
  // and would put the worker back to the settings it knows.
  if (workerImage(existing) !== runtimeImage() || restart) {
    await replaceWorker(
      apps,
      workspaceId,
      existing,
      restart ? "new credential" : "new runtime image",
    );
  }
  await ensureAutoscaler(workspaceId);
}

// --- Autoscaling (optional) ---------------------------------------------------

type CustomObjects = Pick<
  CustomObjectsApi,
  | "getNamespacedCustomObject"
  | "createNamespacedCustomObject"
  | "replaceNamespacedCustomObject"
>;

/** True when workers are scaled by KEDA (WORKFLOWS_AUTOSCALER=keda). */
export function isAutoscaled(): boolean {
  return process.env.WORKFLOWS_AUTOSCALER === "keda";
}

const KEDA = { group: "keda.sh", version: "v1alpha1" };

/**
 * The KEDA objects that scale a workspace's worker between 0 pods and
 * WORKER_MAX_REPLICAS. KEDA asks Mako how many steps the workspace has to
 * run (`GET /api/workflows/runtime/demand`, with the worker's own key from
 * its Secret) and keeps one pod per WORKER_STEPS of them. Mako answers from
 * Hatchet's queue, and counts a deploy the worker has not built yet as work,
 * so a sleeping worker wakes for a push as it does for a run.
 */
export function autoscalerBodies(workspaceId: string) {
  const name = workerName(workspaceId);
  const metadata = {
    name,
    namespace: NAMESPACE,
    labels: resourceLabels(workspaceId),
  };
  return {
    TriggerAuthentication: {
      apiVersion: `${KEDA.group}/${KEDA.version}`,
      kind: "TriggerAuthentication",
      metadata,
      spec: {
        secretTargetRef: [{ parameter: "token", name, key: "MAKO_API_KEY" }],
      },
    },
    ScaledObject: {
      apiVersion: `${KEDA.group}/${KEDA.version}`,
      kind: "ScaledObject",
      metadata,
      spec: {
        scaleTargetRef: { name },
        minReplicaCount: 0,
        maxReplicaCount: WORKER_MAX_REPLICAS,
        pollingInterval: 15,
        // Ten minutes without work before the last pod stops: a schedule
        // that fires every few minutes keeps its worker.
        cooldownPeriod: 600,
        // Mako or Hatchet not answering is not "no work": keep one pod.
        fallback: { failureThreshold: 3, replicas: 1 },
        advanced: {
          horizontalPodAutoscalerConfig: {
            behavior: {
              // Grow at once; shrink one pod at a time, five minutes after
              // the queue allows it. A pod asked to stop finishes its steps
              // first (terminationGracePeriodSeconds).
              scaleUp: { stabilizationWindowSeconds: 0 },
              scaleDown: {
                stabilizationWindowSeconds: 300,
                policies: [{ type: "Pods", value: 1, periodSeconds: 60 }],
              },
            },
          },
        },
        triggers: [
          {
            type: "metrics-api",
            metricType: "AverageValue",
            metadata: {
              url: `${makoUrl()}/api/workflows/runtime/demand`,
              valueLocation: "steps",
              targetValue: String(workerSteps()),
              // One step is enough to start the first pod.
              activationTargetValue: "0",
              authMode: "bearer",
            },
            authenticationRef: { name },
          },
        ],
      },
    },
  };
}

/**
 * Create or update the workspace's KEDA objects. Nothing without
 * WORKFLOWS_AUTOSCALER=keda: the worker then stays at the pods it has.
 */
export async function ensureAutoscaler(
  workspaceId: string,
  custom?: CustomObjects,
): Promise<void> {
  if (!isAutoscaled()) return;
  const client = custom ?? (await gkeCustomObjects());
  const bodies = autoscalerBodies(workspaceId);
  const kinds = [
    ["triggerauthentications", bodies.TriggerAuthentication],
    ["scaledobjects", bodies.ScaledObject],
  ] as const;
  for (const [plural, body] of kinds) {
    const at = { ...KEDA, namespace: NAMESPACE, plural };
    let existing: { metadata?: { resourceVersion?: string } } | undefined;
    try {
      existing = await client.getNamespacedCustomObject({
        ...at,
        name: body.metadata.name,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (!existing) {
      await client.createNamespacedCustomObject({ ...at, body });
      continue;
    }
    await client.replaceNamespacedCustomObject({
      ...at,
      name: body.metadata.name,
      body: {
        ...body,
        metadata: {
          ...body.metadata,
          resourceVersion: existing.metadata?.resourceVersion,
        },
      },
    });
  }
}

/** This environment's workers: previews by their label, the rest without. */
export function workerSelector(): string {
  const env = resourceLabels("")[ENV_LABEL];
  return [
    `app.kubernetes.io/name=${POD_NAME_LABEL}`,
    env ? `${ENV_LABEL}=${env}` : `!${ENV_LABEL}`,
  ].join(",");
}

/**
 * Move every worker of this environment to the runtime image this API names.
 * Run when the API starts: a deploy may name a new image
 * (WORKFLOWS_RUNTIME_IMAGE, tagged by the runtime's content), and a worker
 * otherwise moves only on its workspace's next push. Instances starting
 * together race; the one that loses the replace (409) leaves it to the
 * winner. Returns the workspaces moved.
 */
export async function rollWorkersToRuntimeImage(
  apps?: AppsClient,
): Promise<string[]> {
  const client = apps ?? (await gkeClients()).apps;
  const image = runtimeImage();
  if (!image) return [];
  const { items } = await client.listNamespacedDeployment({
    namespace: NAMESPACE,
    labelSelector: workerSelector(),
  });
  const moved: string[] = [];
  for (const deployment of items) {
    const workspaceId = deployment.metadata?.labels?.[WORKSPACE_LABEL];
    if (!workspaceId || isCurrent(deployment)) continue;
    try {
      await replaceWorker(client, workspaceId, deployment, "API started");
      moved.push(workspaceId);
      // The autoscaler's target follows the steps a pod now runs.
      await ensureAutoscaler(workspaceId);
    } catch (error) {
      if ((error as { code?: number } | null)?.code === 409) continue;
      logger.warn("Could not move a workflow worker to the new image", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return moved;
}
