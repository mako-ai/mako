/**
 * Kernel provider selection. `KERNEL_PROVIDER` picks explicitly; otherwise we
 * auto-detect: a configured GKE cluster wins, else a static gateway URL (dev),
 * else the provider is unavailable and notebook execution reports "not
 * configured" instead of crashing.
 */
import { GKEKernelProvider, isGkeProviderConfigured } from "./gke-kernel-provider";
import {
  StaticKernelProvider,
  isStaticProviderConfigured,
} from "./static-kernel-provider";
import type { KernelProvider } from "./types";

let cached: KernelProvider | null | undefined;

/** The active provider, or null when none is configured. Memoized. */
export function getKernelProvider(): KernelProvider | null {
  if (cached !== undefined) return cached;
  cached = resolveProvider();
  return cached;
}

function resolveProvider(): KernelProvider | null {
  const explicit = process.env.KERNEL_PROVIDER?.toLowerCase();
  if (explicit === "gke") return new GKEKernelProvider();
  if (explicit === "static") return new StaticKernelProvider();
  if (explicit && explicit !== "auto") return null; // unknown value → disabled

  if (isGkeProviderConfigured()) return new GKEKernelProvider();
  if (isStaticProviderConfigured()) return new StaticKernelProvider();
  return null;
}

/** Test seam: forget the memoized provider. */
export function resetKernelProviderForTests(): void {
  cached = undefined;
}

export type { KernelProvider } from "./types";
export {
  type AcquireOptions,
  type ExecuteResult,
  type KernelEndpoint,
  type KernelHandle,
  type KernelOutput,
} from "./types";
