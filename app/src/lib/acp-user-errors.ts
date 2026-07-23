/**
 * Errors that are already explained by the Desktop-outdated sticky banner.
 * Hide them as raw Alert body text so Chat never shows "Not Found" / 404.
 */
export function isAcpDesktopOutdatedError(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  return /missing ACP route|outdated for this action|One-click Update needs|Local Agent needs Desktop|fully quit and reopen Mako Desktop/i.test(
    message,
  );
}

/** Bare Not Found / HTTP 404 that slipped past rewrite (should be rare). */
export function isBareLocalAgentNotFound(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  const trimmed = message.trim();
  return (
    /^not found$/i.test(trimmed) ||
    /^agent error \(http 404\)$/i.test(trimmed) ||
    /\b404\b/.test(trimmed)
  );
}
