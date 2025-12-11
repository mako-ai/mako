/**
 * Invite redirect utilities
 *
 * Handles redirecting users back to invitation pages after authentication.
 * The redirect URL is stored in sessionStorage before redirecting to login/register.
 */

const INVITE_REDIRECT_KEY = "inviteRedirect";

/**
 * Get the stored invite redirect URL, if any
 * Returns the URL and clears it from storage
 */
export function getAndClearInviteRedirect(): string | null {
  try {
    const redirectUrl = sessionStorage.getItem(INVITE_REDIRECT_KEY);
    if (redirectUrl) {
      sessionStorage.removeItem(INVITE_REDIRECT_KEY);
      return redirectUrl;
    }
  } catch {
    // sessionStorage not available (SSR or private browsing)
  }
  return null;
}

/**
 * Check if there's a pending invite redirect
 */
export function hasInviteRedirect(): boolean {
  try {
    return sessionStorage.getItem(INVITE_REDIRECT_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Store an invite redirect URL
 */
export function setInviteRedirect(url: string): void {
  try {
    sessionStorage.setItem(INVITE_REDIRECT_KEY, url);
  } catch {
    // sessionStorage not available
  }
}

/**
 * Handle invite redirect after successful authentication
 * Returns true if a redirect was performed, false otherwise
 */
export function handleInviteRedirectIfPresent(): boolean {
  const redirectUrl = getAndClearInviteRedirect();
  if (redirectUrl) {
    window.location.href = redirectUrl;
    return true;
  }
  return false;
}
