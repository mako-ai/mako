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

/** Create the worker's credential. Called only when the Secret is missing. */
export async function createWorkerSecret(
  workspaceId: string,
  makoApiKey: string,
): Promise<void> {
  const { core } = await gkeClients();
  await core.createNamespacedSecret({
    namespace: NAMESPACE,
    body: {
      metadata: {
        name: workerName(workspaceId),
        labels: resourceLabels(workspaceId),
      },
      stringData: { MAKO_API_KEY: makoApiKey },
    },
  });
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
              // Previews run `:latest`; a digest check per pod start is cheap.
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

/**
 * Make sure the workspace's worker pod exists and runs the current runtime
 * image. An existing Deployment is replaced only when its image differs.
 */
export async function ensureWorkerDeployment(
  workspaceId: string,
): Promise<void> {
  const { apps } = await gkeClients();
  const name = workerName(workspaceId);
  const body = deploymentBody(workspaceId);
  let existing: V1Deployment;
  try {
    existing = await apps.readNamespacedDeployment({
      name,
      namespace: NAMESPACE,
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await apps.createNamespacedDeployment({ namespace: NAMESPACE, body });
    logger.info("Created workflow worker", { workspaceId });
    return;
  }
  const image = existing.spec?.template?.spec?.containers?.[0]?.image;
  if (image === runtimeImage()) return;
  body.metadata = {
    ...body.metadata,
    resourceVersion: existing.metadata?.resourceVersion,
  };
  await apps.replaceNamespacedDeployment({ name, namespace: NAMESPACE, body });
  logger.info("Updated workflow worker image", { workspaceId, image });
}
