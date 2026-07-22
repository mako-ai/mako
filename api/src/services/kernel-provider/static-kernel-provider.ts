/**
 * StaticKernelProvider — points at a single, fixed kernel gateway URL
 * (`KERNEL_GATEWAY_URL`). For local development (a gateway reachable directly,
 * e.g. `kubectl port-forward` on a non-gVisor cluster, or a locally-run
 * `jupyter kernelgateway`) and integration tests. No k8s, no scaling.
 */
import { loggers } from "../../logging";
import type { AcquireOptions, KernelEndpoint, KernelProvider } from "./types";

const logger = loggers.api("kernel-provider-static");

export function isStaticProviderConfigured(): boolean {
  return Boolean(process.env.KERNEL_GATEWAY_URL);
}

export class StaticKernelProvider implements KernelProvider {
  readonly name = "static";

  acquire(_opts: AcquireOptions): Promise<KernelEndpoint> {
    const baseUrl = process.env.KERNEL_GATEWAY_URL;
    if (!baseUrl) throw new Error("KERNEL_GATEWAY_URL is not set");
    logger.info("using static kernel gateway", { baseUrl });
    return Promise.resolve({ baseUrl, podIp: new URL(baseUrl).hostname });
  }

  release(): Promise<void> {
    return Promise.resolve();
  }
}
