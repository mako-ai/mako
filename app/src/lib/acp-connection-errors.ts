/** Mirror of Local Agent connection-closed detection for Chat reconnect. */
export function isAcpConnectionClosedError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  return /ACP connection closed|connection dropped|adapter process exited|expired ACP session|Send again to reconnect|fresh local session/i.test(
    message,
  );
}
