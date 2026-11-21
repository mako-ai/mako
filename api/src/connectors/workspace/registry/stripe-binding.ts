import { ObjectId } from "mongodb";
import { specToForm, type FormSchema } from "../spec-translation";
import type { LoadedConnector } from "../resolver";
import { loadStripeRegistryMetadata } from "./stripe-metadata";
import { stripeTestReleasePin } from "./stripe-release";

export interface StripeTestBinding {
  workspaceId: string;
  connectionId: string;
  schema: FormSchema;
  definition: LoadedConnector;
}

/** Verify platform-selected metadata before loading the saved credential. */
export async function bindStripeTest(input: {
  workspaceId: string;
  connectionId: string;
  type: string;
}): Promise<StripeTestBinding | null> {
  if (input.type !== "stripe") return null;
  const pin = stripeTestReleasePin();
  if (pin.version === undefined && pin.sha256 === undefined) return null;
  const workspaceId = new ObjectId(input.workspaceId).toHexString();
  const connectionId = new ObjectId(input.connectionId).toHexString();
  const metadata = await loadStripeRegistryMetadata({ workspaceId, pin });
  if (
    metadata.registry.slug !== "stripe" ||
    metadata.registry.version !== pin.version ||
    metadata.registry.sha256 !== pin.sha256
  ) {
    throw new Error(
      "Verified Stripe metadata does not match the selected release.",
    );
  }
  const mako = metadata.spec.mako;
  const entities =
    mako && typeof mako === "object" && !Array.isArray(mako)
      ? (mako as Record<string, unknown>).entities
      : undefined;
  return {
    workspaceId,
    connectionId,
    schema: specToForm(metadata.spec),
    definition: {
      slug: "stripe",
      runtime: "node",
      entry: metadata.entry,
      sha: metadata.registry.sha256,
      sourceSha: metadata.registry.sha256,
      spec: metadata.spec,
      entities:
        entities && typeof entities === "object" && !Array.isArray(entities)
          ? Object.keys(entities)
          : [],
      status: "verified",
      registry: metadata.registry,
    },
  };
}
