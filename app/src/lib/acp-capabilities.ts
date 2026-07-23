import type { AcpStatus } from "./acp-types";

/** Desktop / Local Agent floor for ensure + warm-models ACP routes. */
export const ACP_REQUIRED_DESKTOP_VERSION = "0.3.9";

/** Bridge version that advertises adapterEnsure + modelWarm. */
export const ACP_ENSURE_WARM_BRIDGE_VERSION = 7;

/**
 * True when Local Agent is online with an ACP bridge, but lacks one-click
 * adapter ensure / model warm (Desktop older than {@link ACP_REQUIRED_DESKTOP_VERSION}).
 * Distinct from "agent offline" and from bridge &lt; 2 (no MCP attach).
 */
export function acpIsDesktopOutdatedForEnsureWarm(
  status: AcpStatus | null | undefined,
): boolean {
  const bridge = status?.acpBridge;
  if (!bridge) return false;
  return !acpSupportsAdapterEnsure(status) || !acpSupportsModelWarm(status);
}

/** One-click `npm i -g` adapter install/update (Desktop 0.3.9+ / bridge ≥ 7). */
export function acpSupportsAdapterEnsure(
  status: AcpStatus | null | undefined,
): boolean {
  const bridge = status?.acpBridge;
  if (!bridge) return false;
  return Boolean(
    bridge.adapterEnsure || bridge.version >= ACP_ENSURE_WARM_BRIDGE_VERSION,
  );
}

/** Warm Claude/Codex model catalogs without a Chat turn. */
export function acpSupportsModelWarm(
  status: AcpStatus | null | undefined,
): boolean {
  const bridge = status?.acpBridge;
  if (!bridge) return false;
  return Boolean(
    bridge.modelWarm ||
      bridge.adapterEnsure ||
      bridge.version >= ACP_ENSURE_WARM_BRIDGE_VERSION,
  );
}

/** MCP attach / reconnect baseline (bridge ≥ 2). */
export function acpSupportsWorkspaceMcp(
  status: AcpStatus | null | undefined,
): boolean {
  const version = status?.acpBridge?.version;
  return typeof version === "number" && version >= 2;
}

/** Shared sticky-banner copy for Chat + Settings. */
export function acpDesktopOutdatedSummary(): string {
  return (
    `Update Mako Desktop to ${ACP_REQUIRED_DESKTOP_VERSION}+, fully quit ` +
    `(Cmd+Q / Quit — not only close the window), reopen, then use Chat → ` +
    `Enable workspace tools.`
  );
}
