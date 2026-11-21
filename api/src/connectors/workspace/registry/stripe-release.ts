import {
  getRegistryCatalog,
  resolveReference,
  type RegistryResolution,
} from "./registry.service";
import { formatVersion, parseRegistryReference, parseVersion } from "./semver";
import type { RegistryCatalog } from "./store";

/** Supplied by platform code, never from a workspace connector definition. */
export interface StripeReleasePin {
  version?: string;
  sha256?: string;
}

/** No platform release is selected for saved tests. */
export function stripeTestReleasePin(): StripeReleasePin {
  return {};
}

/** Resolve the reviewed release without consulting a workspace. */
export async function resolveStripeRelease(
  pin: StripeReleasePin,
  catalog?: RegistryCatalog,
): Promise<RegistryResolution | null> {
  const { version, sha256 } = pin;
  if (version === undefined && sha256 === undefined) return null;
  if (version === undefined || sha256 === undefined) {
    throw new Error(
      "The Stripe release needs both an exact version and a SHA-256 digest.",
    );
  }
  const parsedVersion = parseVersion(version);
  if (!parsedVersion || formatVersion(parsedVersion) !== version) {
    throw new Error("The Stripe release version must be an exact version.");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(
      "The Stripe release SHA-256 digest must be 64 lowercase hexadecimal characters.",
    );
  }
  const reference = parseRegistryReference(`mako/stripe@${version}`);
  if (!reference.ok) throw new Error(reference.reason);
  const resolved = resolveReference(
    reference.value,
    catalog ?? (await getRegistryCatalog()),
  );
  if (!resolved.ok) throw new Error(resolved.reason);
  if (
    resolved.resolution.version !== version ||
    resolved.resolution.sha256 !== sha256
  ) {
    throw new Error(
      `The published mako/stripe@${version} does not match the reviewed SHA-256 digest.`,
    );
  }
  return resolved.resolution;
}
