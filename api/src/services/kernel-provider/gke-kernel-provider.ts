/**
 * GKEKernelProvider — claims a ready kernel pod from the `kernel-pool`
 * Deployment on the mako-notebooks GKE cluster and returns its in-VPC gateway
 * endpoint. The control plane (Cloud Run) reaches both the k8s API and the pod
 * IPs privately over the shared mako-vpc.
 *
 * Auth: a Google ADC access token (the Cloud Run runtime SA, granted
 * roles/container.developer). The cluster endpoint + CA come from env so we
 * never shell out to gcloud. A fresh token is minted per acquire (acquire is
 * infrequent; tokens are short-lived).
 *
 * Co-tenancy: a pod runs 2–3 kernels, so acquire returns the first ready pod
 * without hard-reserving it — the gateway multiplexes kernels. Autoscale from
 * zero: if no pod is ready, we scale the Deployment up and wait.
 */
import {
  AppsV1Api,
  CoreV1Api,
  KubeConfig,
  type V1Pod,
} from "@kubernetes/client-node";
import { GoogleAuth } from "google-auth-library";

import { loggers } from "../../logging";
import type { AcquireOptions, KernelEndpoint, KernelProvider } from "./types";

const logger = loggers.api("kernel-provider-gke");

const NAMESPACE = process.env.KERNEL_NAMESPACE || "mako-notebooks";
const DEPLOYMENT = process.env.KERNEL_POOL_DEPLOYMENT || "kernel-pool";
const GATEWAY_PORT = process.env.KERNEL_GATEWAY_PORT || "8888";
const POD_LABEL = "app.kubernetes.io/name=mako-kernel";
const ACQUIRE_TIMEOUT_MS = Number(process.env.KERNEL_ACQUIRE_TIMEOUT_MS || 180_000);
const POLL_INTERVAL_MS = 3_000;

let googleAuth: GoogleAuth | null = null;
function auth(): GoogleAuth {
  googleAuth ??= new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return googleAuth;
}

/** True when the GKE provider has the endpoint/CA it needs to run. */
export function isGkeProviderConfigured(): boolean {
  return Boolean(process.env.KERNEL_GKE_ENDPOINT && process.env.KERNEL_GKE_CA_CERT);
}

function podIsReady(pod: V1Pod): boolean {
  if (pod.metadata?.deletionTimestamp) return false; // terminating
  if (pod.status?.phase !== "Running") return false;
  if (!pod.status?.podIP) return false;
  const ready = pod.status?.conditions?.find(c => c.type === "Ready");
  return ready?.status === "True";
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class GKEKernelProvider implements KernelProvider {
  readonly name = "gke";

  private async clients(): Promise<{ core: CoreV1Api; apps: AppsV1Api }> {
    const endpoint = process.env.KERNEL_GKE_ENDPOINT;
    const caData = process.env.KERNEL_GKE_CA_CERT;
    if (!endpoint || !caData) {
      throw new Error(
        "GKE kernel provider not configured (KERNEL_GKE_ENDPOINT / KERNEL_GKE_CA_CERT)",
      );
    }
    const token = await auth()
      .getClient()
      .then(c => c.getAccessToken())
      .then(t => t.token);
    if (!token) throw new Error("failed to mint a Google access token for GKE");

    const kc = new KubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: "mako", server: endpoint, caData }],
      users: [{ name: "mako", token }],
      contexts: [{ name: "mako", cluster: "mako", user: "mako" }],
      currentContext: "mako",
    });
    return {
      core: kc.makeApiClient(CoreV1Api),
      apps: kc.makeApiClient(AppsV1Api),
    };
  }

  private async findReadyPod(core: CoreV1Api): Promise<KernelEndpoint | null> {
    const list = await core.listNamespacedPod({
      namespace: NAMESPACE,
      labelSelector: POD_LABEL,
    });
    const pod = (list.items ?? []).find(podIsReady);
    const podIp = pod?.status?.podIP;
    if (!pod || !podIp) return null;
    return {
      baseUrl: `http://${podIp}:${GATEWAY_PORT}`,
      podIp,
      podName: pod.metadata?.name,
    };
  }

  /** Ensure the warm-pool Deployment has at least `min` replicas. */
  private async scaleUpTo(apps: AppsV1Api, min: number): Promise<void> {
    const scale = await apps.readNamespacedDeploymentScale({
      name: DEPLOYMENT,
      namespace: NAMESPACE,
    });
    const current = scale.spec?.replicas ?? 0;
    if (current >= min) return;
    scale.spec = { ...scale.spec, replicas: min };
    await apps.replaceNamespacedDeploymentScale({
      name: DEPLOYMENT,
      namespace: NAMESPACE,
      body: scale,
    });
    logger.info("scaled kernel pool up", { from: current, to: min });
  }

  async acquire(opts: AcquireOptions): Promise<KernelEndpoint> {
    const { core, apps } = await this.clients();

    const ready = await this.findReadyPod(core);
    if (ready) {
      logger.info("claimed warm kernel pod", {
        pod: ready.podName,
        notebookId: opts.notebookId,
      });
      return ready;
    }

    // Cold: scale the pool up and wait for a pod (autoscaler may add a node).
    await this.scaleUpTo(apps, 1);
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const pod = await this.findReadyPod(core);
      if (pod) {
        logger.info("kernel pod ready after scale-up", { pod: pod.podName });
        return pod;
      }
    }
    throw new Error(
      `timed out waiting ${ACQUIRE_TIMEOUT_MS}ms for a ready kernel pod`,
    );
  }

  release(endpoint: KernelEndpoint): Promise<void> {
    // v1: pods stay in the warm pool for reuse; the session service deletes the
    // kernel via the gateway, and the Inngest reaper scales the pool back down.
    logger.debug("release (no-op, pod stays in pool)", { pod: endpoint.podName });
    return Promise.resolve();
  }
}
