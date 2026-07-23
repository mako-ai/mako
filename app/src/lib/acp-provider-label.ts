import type { AcpProviderId, AcpStatus } from "./acp-types";

/** User-visible provider name for Chat ACP surfaces (HITL, banners). */
export function acpProviderLabel(
  providerId: AcpProviderId | string | null | undefined,
  status?: AcpStatus | null,
): string {
  if (providerId && status?.providers?.length) {
    const fromStatus = status.providers.find(p => p.id === providerId)?.label;
    if (fromStatus) return fromStatus;
  }
  return providerId === "codex" ? "Codex" : "Claude Code";
}
