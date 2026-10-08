/**
 * Kubernetes side of workspace workflows (rfcs/workflows-as-code.md).
 *
 * Each workspace has one Secret and one Deployment named `wf-<prefix><id>` in
 * the `mako-workflows` namespace, on the gVisor node pool the notebook kernels
 * use. A deploy is one write: set `GIT_SHA` on the Deployment. The new pod
 * fetches `workflows/` at that commit, typechecks it and only then becomes
 * ready, so a commit that does not build never replaces the running pod.
 *
 * Kubernetes is the record of what is deployed. The live commit and the build
 * error are read from it here, never copied into Mongo.
 */
import type { V1Deployment, V1Pod } from "@kubernetes/client-node";

import { loggers } from "../logging";
import {
  gkeClients,
  isGkeProviderConfigured,
} from "../services/kernel-provider/gke-kernel-provider";
import { workflowsNamePrefix } from "./hatchet";

const logger = loggers.api("workflows-kube");

const NAMESPACE = "mako-workflows";
// The network policy selects worker pods by this label.
const POD_NAME_LABEL = "mako-workflow-worker";
const WORKSPACE_LABEL = "mako.ai/workspace";
const ENV_LABEL = "mako.ai/env";
const BUILD_LOG_LINES = 60;

/** True when this API instance can deploy workers. */
export function isWorkflowsKubeConfigured(): boolean {
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
  const url =
    process.env.WORKFLOWS_MAKO_URL ||
    process.env.NOTEBOOK_KERNEL_API_URL ||
    process.env.BASE_URL;
  if (!url) throw new Error("Set WORKFLOWS_MAKO_URL or BASE_URL");
  return url.replace(/\/+$/, "");
}

export function workerName(workspaceId: string): string {
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

/** Create the worker's credentials. Called only when the Secret is missing. */
export async function createWorkerSecret(
  workspaceId: string,
  secrets: { hatchetToken: string; makoApiKey: string },
): Promise<void> {
  const { core } = await gkeClients();
  await core.createNamespacedSecret({
    namespace: NAMESPACE,
    body: {
      metadata: {
        name: workerName(workspaceId),
        labels: resourceLabels(workspaceId),
      },
      stringData: {
        HATCHET_CLIENT_TOKEN: secrets.hatchetToken,
        MAKO_API_KEY: secrets.makoApiKey,
      },
    },
  });
}

function deploymentBody(workspaceId: string, sha: string): V1Deployment {
  const name = workerName(workspaceId);
  const labels = {
    "app.kubernetes.io/name": POD_NAME_LABEL,
    ...resourceLabels(workspaceId),
  };
  return {
    metadata: { name, labels },
    spec: {
      replicas: 1,
      // A pod that fails its typecheck never becomes ready; after this long
      // the rollout is marked stalled, and the previous pod keeps running.
      progressDeadlineSeconds: 300,
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
          // Long enough for a running task to finish when a deploy replaces
          // the pod. Hatchet retries what does not finish in time.
          terminationGracePeriodSeconds: 1800,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "worker",
              image: runtimeImage(),
              // Previews run `:latest`; a digest check per pod start is cheap.
              imagePullPolicy: "Always",
              env: [
                { name: "GIT_SHA", value: sha },
                { name: "MAKO_URL", value: makoUrl() },
                { name: "HATCHET_CLIENT_TLS_STRATEGY", value: "none" },
                { name: "HOME", value: "/tmp" },
              ],
              envFrom: [{ secretRef: { name } }],
              readinessProbe: {
                exec: { command: ["test", "-f", "/tmp/ready"] },
                periodSeconds: 5,
              },
              resources: {
                requests: { cpu: "100m", memory: "256Mi" },
                limits: { cpu: "1", memory: "1Gi" },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
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

async function readDeployment(
  workspaceId: string,
): Promise<V1Deployment | null> {
  const { apps } = await gkeClients();
  try {
    return await apps.readNamespacedDeployment({
      name: workerName(workspaceId),
      namespace: NAMESPACE,
    });
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function shaOf(spec: V1Deployment | V1Pod | null): string | null {
  const containers =
    (spec as V1Deployment | null)?.spec?.template?.spec?.containers ??
    (spec as V1Pod | null)?.spec?.containers;
  return containers?.[0]?.env?.find(e => e.name === "GIT_SHA")?.value ?? null;
}

/** The commit the Deployment is set to, or null when there is no Deployment. */
export async function readTargetSha(
  workspaceId: string,
): Promise<string | null> {
  return shaOf(await readDeployment(workspaceId));
}

/**
 * Deploy a commit: create the Deployment, or replace its pod template. The
 * template is rebuilt from scratch each time so a new runtime image or a
 * changed setting reaches existing workers on their next deploy.
 */
export async function deployWorker(
  workspaceId: string,
  sha: string,
): Promise<void> {
  const { apps } = await gkeClients();
  const body = deploymentBody(workspaceId, sha);
  const existing = await readDeployment(workspaceId);
  if (!existing) {
    await apps.createNamespacedDeployment({ namespace: NAMESPACE, body });
    logger.info("Created workflow worker", { workspaceId, sha });
    return;
  }
  body.metadata = {
    ...body.metadata,
    resourceVersion: existing.metadata?.resourceVersion,
  };
  await apps.replaceNamespacedDeployment({
    name: workerName(workspaceId),
    namespace: NAMESPACE,
    body,
  });
  logger.info("Deployed workflow worker", { workspaceId, sha });
}

export interface WorkerStatus {
  /** The commit a ready pod is running. Null before the first good deploy. */
  liveSha: string | null;
  /** The commit the Deployment is set to. Differs from live while rolling out. */
  targetSha: string | null;
  /** True when a rollout to `targetSha` is still in progress. */
  deploying: boolean;
  /** The failing pod's last log lines when `targetSha` did not build. */
  buildError: string | null;
}

function podReady(pod: V1Pod): boolean {
  if (pod.metadata?.deletionTimestamp) return false;
  return (
    pod.status?.conditions?.some(
      c => c.type === "Ready" && c.status === "True",
    ) ?? false
  );
}

/** What is deployed for this workspace, read from Kubernetes. */
export async function readWorkerStatus(
  workspaceId: string,
): Promise<WorkerStatus> {
  const deployment = await readDeployment(workspaceId);
  const targetSha = shaOf(deployment);
  if (!deployment) {
    return {
      liveSha: null,
      targetSha: null,
      deploying: false,
      buildError: null,
    };
  }
  const { core } = await gkeClients();
  const pods = await core.listNamespacedPod({
    namespace: NAMESPACE,
    labelSelector: `${WORKSPACE_LABEL}=${workspaceId}`,
  });
  const items = pods.items ?? [];
  const live = items.find(podReady);
  const liveSha = shaOf(live ?? null);
  if (liveSha === targetSha) {
    return { liveSha, targetSha, deploying: false, buildError: null };
  }

  // The new pod is not ready. It is either still starting or it failed its
  // typecheck and is restarting; a restart count tells the two apart.
  const pending = items.find(
    p => !p.metadata?.deletionTimestamp && shaOf(p) === targetSha,
  );
  const status = pending?.status?.containerStatuses?.[0];
  const failed =
    (status?.restartCount ?? 0) > 0 || Boolean(status?.state?.terminated);
  if (!pending?.metadata?.name || !failed) {
    return { liveSha, targetSha, deploying: true, buildError: null };
  }
  const log = await core
    .readNamespacedPodLog({
      name: pending.metadata.name,
      namespace: NAMESPACE,
      tailLines: BUILD_LOG_LINES,
      // A crash-looping container's current instance may have no output yet.
      previous: Boolean(status?.state?.waiting),
    })
    .catch(() => "");
  return {
    liveSha,
    targetSha,
    deploying: false,
    buildError: log || "The worker failed to start and left no log.",
  };
}
