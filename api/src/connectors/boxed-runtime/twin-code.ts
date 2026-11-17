/**
 * Which code a built-in connection's key may reach in a box. No runtime
 * imports: SandboxedConnector checks it too, on the definition it runs.
 */
import type { LoadedConnector } from "../workspace/resolver";

/**
 * Whether the twin's code is the code an owner/admin approved for this
 * connection: Mako's registry connector for this very type at the approved
 * bundle hash, or the exact workspace folder approved (its source hash). A
 * push of new code to `connectors/<slug>/`, or a registry upgrade, changes
 * the hash, and the next run is refused until someone approves again.
 */
export function isTwinCodeAllowed(
  definition: Pick<LoadedConnector, "sourceSha" | "registry">,
  pin: { sourceSha?: string; registryHash?: string } | undefined,
  connectionType: string,
): boolean {
  if (definition.registry) {
    return (
      definition.registry.slug === connectionType &&
      Boolean(pin?.registryHash) &&
      definition.registry.hash === pin?.registryHash
    );
  }
  return Boolean(pin?.sourceSha) && definition.sourceSha === pin?.sourceSha;
}

export function twinCodeRefusal(slug: string): string {
  return `The code in connectors/${slug}/ changed since an owner/admin approved it for this connection. Approve it again (flow_update runtime=boxed, or flow_shadow start), or switch back.`;
}
