export function connectorIconUrl(
  type: string,
  workspaceId?: string | null,
): string {
  const base = `/api/connectors/${encodeURIComponent(type)}/icon.svg`;
  return type.startsWith("ws:") && workspaceId
    ? `${base}?workspaceId=${encodeURIComponent(workspaceId)}`
    : base;
}
