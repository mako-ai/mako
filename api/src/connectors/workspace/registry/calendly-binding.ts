import { ObjectId } from "mongodb";
import { assertLaunchDeadline } from "../../../apps/sandbox/launch-deadline";
import { specToForm, type FormSchema } from "../spec-translation";
import type { LoadedConnector } from "../resolver";
import { loadVerifiedRegistryMetadata } from "./stripe-metadata";
import { resolveTrustedRelease, type StripeReleasePin } from "./stripe-release";

// Deliberately empty until a release is reviewed and selected by the platform.
export const CALENDLY_RELEASE_PIN: StripeReleasePin = {};

/** An incomplete pin still needs validation before using the connection. */
export function isCalendlyReleaseSelected(type: string): boolean {
  return (
    type === "calendly" &&
    (CALENDLY_RELEASE_PIN.version !== undefined ||
      CALENDLY_RELEASE_PIN.sha256 !== undefined)
  );
}

export interface CalendlyBinding {
  workspaceId: string;
  connectionId: string;
  schema: FormSchema;
  definition: LoadedConnector;
  remainingMs?: () => number;
}

/** Resolve and verify before reading a stored credential. */
export async function bindCalendlyRelease(input: {
  workspaceId: string;
  connectionId: string;
  type: string;
  remainingMs?: () => number;
}): Promise<CalendlyBinding | null> {
  if (input.type !== "calendly") return null;
  const release = await resolveTrustedRelease("calendly", CALENDLY_RELEASE_PIN);
  if (!release) return null;
  const workspaceId = new ObjectId(input.workspaceId).toHexString();
  const connectionId = new ObjectId(input.connectionId).toHexString();
  const { remainingMs } = input;
  assertLaunchDeadline(remainingMs);
  const metadata = await loadVerifiedRegistryMetadata(
    workspaceId,
    release,
    remainingMs,
  );
  if (
    metadata.registry.slug !== "calendly" ||
    metadata.registry.version !== release.version ||
    metadata.registry.sha256 !== release.sha256 ||
    metadata.registry.hash !== release.hash ||
    metadata.registry.ref !== release.ref
  ) {
    throw new Error(
      "Verified Calendly metadata does not match the selected release.",
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
    ...(remainingMs ? { remainingMs } : {}),
    schema: specToForm(metadata.spec),
    definition: {
      slug: "calendly",
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
