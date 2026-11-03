/**
 * The `gke` worker provider: one sandboxed pod per workspace, for workflows
 * written by people the operator does not know. A Secret and a Deployment
 * named `wf-<prefix><id>`, created once: the pod holds its Mako API key and
 * asks Mako which commit to run, so a deploy never touches Kubernetes.
 */
import type { V1Deployment } from "@kubernetes/client-node";

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

function deploymentBody(workspaceId: string): V1Deployment {
  const name = workerName(workspaceId);
  const labels = {
    "app.kubernetes.io/name": POD_NAME_LABEL,
    ...resourceLabels(workspaceId),
  };
  const tls = process.env.HATCHET_CLIENT_TLS_STRATEGY;
  return {
    metadata: { name, labels },
    spec: {
      replicas: 1,
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
              // A tag can be published again (a rebuilt runtime, `:latest`
              // as a fallback); a digest check per pod start is cheap.
              imagePullPolicy: "Always",
              env: [
                { name: "MAKO_URL", value: makoUrl() },
                { name: "HOME", value: "/tmp" },
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
  const body = deploymentBody(workspaceId);
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
    return;
  }
  if (workerImage(existing) === runtimeImage() && !restart) return;
  await replaceWorker(
    apps,
    workspaceId,
    existing,
    restart ? "new credential" : "new runtime image",
  );
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
    if (!workspaceId || workerImage(deployment) === image) continue;
    try {
      await replaceWorker(client, workspaceId, deployment, "API started");
      moved.push(workspaceId);
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
