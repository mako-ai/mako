import { randomUUID } from "node:crypto";
import { getBoxScheduler } from "../boxes/scheduler";
import { validateSpec } from "../connector-file";
import { ensureConnectorRuntime } from "../resolver";
import { failureMessage, firstOfType, runConnectorCommand } from "../sync-box";
import { prepareRegistryConnector } from "./registry.service";
import { resolveStripeRelease, type StripeReleasePin } from "./stripe-release";
import type { RegistryCatalog } from "./store";

/** Metadata for an adapter; it does not imply a workspace connector exists. */
export interface StripeRegistryMetadata {
  spec: Record<string, unknown>;
  registry: {
    ref: string;
    slug: string;
    version: string;
    hash: string;
    sha256: string;
  };
  entry: string;
}

/** Run the pinned registry bundle's spec in a new, disposable, credential-free box. */
export async function loadStripeRegistryMetadata(input: {
  workspaceId: string;
  pin: StripeReleasePin;
  catalog?: RegistryCatalog;
}): Promise<StripeRegistryMetadata> {
  const registry = await resolveStripeRelease(input.pin, input.catalog);
  if (!registry) throw new Error("The Stripe release pin is missing.");
  return loadVerifiedRegistryMetadata(input.workspaceId, registry);
}

/** Verify the artifact and read its spec without supplying a credential. */
export async function loadVerifiedRegistryMetadata(
  workspaceId: string,
  registry: import("./registry.service").RegistryResolution,
): Promise<StripeRegistryMetadata> {
  return getBoxScheduler().withLease(
    {
      workspaceId,
      // A unique key prevents reuse of a prior box or its snapshot. Omitting
      // runtimeId also prevents the scheduler from selecting a template.
      connectionId: `stripe-spec:${randomUUID()}`,
      bundleHash: registry.sha256,
      command: "spec",
      timeoutMs: 60_000,
      oneOff: true,
    },
    async lease => {
      if (!lease.fresh) throw new Error("Stripe spec requires a fresh box.");
      const runtimeId = await ensureConnectorRuntime(lease.ctx);
      const installed = await prepareRegistryConnector({
        ctx: lease.ctx,
        runtimeId,
        registry,
      });
      const result = await runConnectorCommand({
        ctx: lease.ctx,
        runtimeId,
        connectorDir: installed.dir,
        entry: installed.entry,
        command: "spec",
        timeoutMs: 60_000,
        onCleanupFailure: reason => lease.markUnhealthy(reason),
      });
      if (result.timedOut) lease.markFailed("timed out");
      const failure = failureMessage(result);
      if (failure) throw new Error(failure);
      const message = firstOfType<{ spec?: Record<string, unknown> }>(
        result.messages,
        "SPEC",
      );
      const validation = validateSpec(message?.spec);
      if (!validation.ok) throw new Error(validation.reason);
      if (!message?.spec) throw new Error("The connector emitted no SPEC.");
      return {
        spec: message.spec,
        registry: {
          ref: registry.ref,
          slug: registry.slug,
          version: registry.version,
          hash: registry.hash,
          sha256: registry.sha256,
        },
        entry: installed.entry,
      };
    },
  );
}
