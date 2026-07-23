/** Errors from @agentclientprotocol/sdk when the adapter stdio pipe dies. */
export function isAcpConnectionClosedError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  return /ACP connection closed|connection closed|EPIPE|ECONNRESET/i.test(
    message,
  );
}

export function acpReconnectMessage(providerLabel: string): string {
  return (
    `${providerLabel} connection dropped (adapter process exited). ` +
    `Mako will start a fresh local session on the next message.`
  );
}
