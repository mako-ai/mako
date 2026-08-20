import type { AcpStatus } from "./acp-types";

/** One-click `npm i -g` adapter install/update (Desktop 0.3.9+ / bridge ≥ 6). */
export function acpSupportsAdapterEnsure(
  status: AcpStatus | null | undefined,
): boolean {
  const bridge = status?.acpBridge;
  if (!bridge) return false;
  return Boolean(bridge.adapterEnsure || bridge.version >= 6);
}

/** Warm Claude/Codex model catalogs without a Chat turn. */
export function acpSupportsModelWarm(
  status: AcpStatus | null | undefined,
): boolean {
  const bridge = status?.acpBridge;
  if (!bridge) return false;
  return Boolean(
    bridge.modelWarm || bridge.adapterEnsure || bridge.version >= 6,
  );
}

/** Prompt image attachments forwarded as ACP ContentBlocks (bridge ≥ 8). */
export function acpSupportsPromptImages(
  status: AcpStatus | null | undefined,
): boolean {
  const bridge = status?.acpBridge;
  if (!bridge) return false;
  return Boolean(bridge.promptImages || bridge.version >= 8);
}

/** MCP attach / reconnect baseline (bridge ≥ 2). */
export function acpSupportsWorkspaceMcp(
  status: AcpStatus | null | undefined,
): boolean {
  const version = status?.acpBridge?.version;
  return typeof version === "number" && version >= 2;
}
