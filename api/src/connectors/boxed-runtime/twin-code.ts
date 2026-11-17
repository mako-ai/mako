/**
 * Which code a built-in connection's key may reach in a box. No runtime
 * imports: SandboxedConnector checks it too, on the definition it runs.
 */
import type { LoadedConnector } from "../workspace/resolver";

/**
 * Whether the twin's code is code the key may reach: Mako's registry
 * connector for this very type (built by Mako, installed by reference), or
 * the exact folder an owner/admin approved. A push of new code to
 * `connectors/<slug>/` changes the folder's source hash, and the next run
 * is refused until someone approves again.
 */
export function isTwinCodeAllowed(
  definition: Pick<LoadedConnector, "sourceSha" | "registry">,
  pin: { sourceSha?: string } | undefined,
  connectionType: string,
): boolean {
  if (definition.registry && definition.registry.slug === connectionType) {
    return true;
  }
  return Boolean(pin?.sourceSha) && definition.sourceSha === pin?.sourceSha;
}

export function twinCodeRefusal(slug: string): string {
  return `The code in connectors/${slug}/ changed since an owner/admin approved it for this connection. Approve it again (flow_update runtime=boxed, or flow_shadow start), or switch back.`;
}
