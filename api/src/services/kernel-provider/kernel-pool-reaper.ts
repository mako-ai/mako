/**
 * Scale the notebook kernel pool back down when no one uses it.
 *
 * The GKE provider scales the `kernel-pool` Deployment up from zero when a
 * notebook starts a kernel (gke-kernel-provider.ts). Nothing scaled it back
 * down, so one pod, and the e2-highmem-4 gVisor node under it, stayed up for
 * good after the first notebook run. This sweep (an Inngest cron) scales the
 * pool to KERNEL_POOL_MIN_REPLICAS (default 0) once it is idle:
 *
 * - every kernel on every pod is idle past the session TTL and not busy, read
 *   from the gateways themselves (`GET /api/kernels`), so a session held by
 *   any API instance counts, whatever the session store is; and
 * - every pod is older than the TTL, so a pod just started for a notebook is
 *   not taken away before its kernel exists.
 *
 * A session whose pod went away is dropped on its next run and a fresh one
 * starts (kernel-session.service.ts `isPodUnreachable`); kernel variables are
 * ephemeral by design. A gateway that does not answer counts as in use: the
 * pool is left as it is.
 */
import type { AppsV1Api, CoreV1Api, V1Pod } from "@kubernetes/client-node";

import { loggers } from "../../logging";

const logger = loggers.api("kernel-pool-reaper");

const NAMESPACE = process.env.KERNEL_NAMESPACE || "mako-notebooks";
const DEPLOYMENT = process.env.KERNEL_POOL_DEPLOYMENT || "kernel-pool";
const GATEWAY_PORT = process.env.KERNEL_GATEWAY_PORT || "8888";
const POD_LABEL = "app.kubernetes.io/name=mako-kernel";
const GATEWAY_TIMEOUT_MS = 10_000;

/** Same TTL as the session service: idle this long, a kernel may go. */
export function idleTtlMs(): number {
  return Number(process.env.KERNEL_SESSION_IDLE_MS || 15 * 60_000);
}

export function minReplicas(): number {
  const value = Number(process.env.KERNEL_POOL_MIN_REPLICAS ?? 0);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** One kernel as the Jupyter gateway lists it. */
export interface GatewayKernel {
  id?: string;
  last_activity?: string;
  execution_state?: string;
}

/** What the sweep saw on one pod; `kernels` is null when its gateway did not answer. */
export interface PodView {
  name?: string;
  startedAtMs?: number;
  kernels: GatewayKernel[] | null;
}

/** Why the pool is kept, or null when it may scale down. */
export function keepReason(
  pods: PodView[],
  nowMs: number,
  ttlMs = idleTtlMs(),
): string | null {
  for (const pod of pods) {
    if (pod.startedAtMs === undefined || nowMs - pod.startedAtMs < ttlMs) {
      return `pod ${pod.name ?? "?"} started recently`;
    }
    if (!pod.kernels) return `gateway of ${pod.name ?? "?"} did not answer`;
    for (const kernel of pod.kernels) {
      if (kernel.execution_state === "busy") {
        return `kernel ${kernel.id ?? "?"} is busy`;
      }
      const last = Date.parse(kernel.last_activity ?? "");
      if (!Number.isFinite(last) || nowMs - last < ttlMs) {
        return `kernel ${kernel.id ?? "?"} was used recently`;
      }
    }
  }
  return null;
}

async function listGatewayKernels(
  podIp: string,
): Promise<GatewayKernel[] | null> {
  try {
    const res = await fetch(`http://${podIp}:${GATEWAY_PORT}/api/kernels`, {
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as GatewayKernel[]) : null;
  } catch {
    return null;
  }
}

function startedAt(pod: V1Pod): number | undefined {
  const at = pod.status?.startTime;
  if (!at) return undefined;
  const ms = new Date(at).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export interface ReapResult {
  from: number;
  to: number;
  /** Set when the pool was kept. */
  kept?: string;
}

/**
 * Scale the kernel pool down to `minReplicas()` when it is idle. Pods that
 * are terminating are ignored; pods without an IP yet count as just started.
 */
export async function reapIdleKernelPool(
  clients: { core: CoreV1Api; apps: AppsV1Api },
  options: {
    nowMs?: number;
    listKernels?: (podIp: string) => Promise<GatewayKernel[] | null>;
  } = {},
): Promise<ReapResult> {
  const nowMs = options.nowMs ?? Date.now();
  const listKernels = options.listKernels ?? listGatewayKernels;
  const target = minReplicas();
  const scale = await clients.apps.readNamespacedDeploymentScale({
    name: DEPLOYMENT,
    namespace: NAMESPACE,
  });
  const from = scale.spec?.replicas ?? 0;
  if (from <= target) return { from, to: from };

  const { items } = await clients.core.listNamespacedPod({
    namespace: NAMESPACE,
    labelSelector: POD_LABEL,
  });
  const pods = await Promise.all(
    (items ?? [])
      .filter(pod => !pod.metadata?.deletionTimestamp)
      .map(async (pod): Promise<PodView> => {
        const ip = pod.status?.podIP;
        return {
          name: pod.metadata?.name,
          startedAtMs: ip ? startedAt(pod) : undefined,
          kernels: ip ? await listKernels(ip) : null,
        };
      }),
  );
  const kept = keepReason(pods, nowMs);
  if (kept) return { from, to: from, kept };

  await clients.apps.replaceNamespacedDeploymentScale({
    name: DEPLOYMENT,
    namespace: NAMESPACE,
    body: { ...scale, spec: { ...scale.spec, replicas: target } },
  });
  logger.info("Scaled idle kernel pool down", { from, to: target });
  return { from, to: target };
}
