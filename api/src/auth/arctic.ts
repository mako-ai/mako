import { Google, GitHub } from "arctic";
import { getProductionUrl } from "./oauth-proxy";

/**
 * OAuth provider types
 */
export type OAuthProvider = "google" | "github";

let _google: Google | null = null;
let _github: GitHub | null = null;

/**
 * Check if OAuth is disabled (hard kill switch).
 * Kept as a safety valve; the proxy pattern means non-production
 * environments no longer need to set DISABLE_OAUTH=true.
 */
export function isOAuthDisabled(): boolean {
  return process.env.DISABLE_OAUTH === "true";
}

/**
 * Get the callback base URL.
 * Delegates to getProductionUrl() from oauth-proxy — when PRODUCTION_URL is
 * set, OAuth callbacks always route through production because only
 * production's URLs are registered with providers.  Falls back to BASE_URL
 * for backward compatibility (single-deployment setups).
 */
function getCallbackBaseUrl(): string {
  return getProductionUrl();
}

/**
 * Get Google OAuth provider (lazy-loaded).
 * redirect_uri always points to the production callback URL.
 */
export function getGoogle(): Google {
  if (isOAuthDisabled()) {
    throw new Error(
      "OAuth is disabled in this environment. Use email/password authentication instead.",
    );
  }

  if (!_google) {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      throw new Error(
        "Missing Google OAuth environment variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET",
      );
    }
    const baseUrl = getCallbackBaseUrl();
    if (!baseUrl) {
      throw new Error(
        "Missing callback base URL: set PRODUCTION_URL or BASE_URL",
      );
    }
    _google = new Google(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      `${baseUrl}/api/auth/google/callback`,
    );
  }
  return _google;
}

/**
 * Get GitHub OAuth provider (lazy-loaded).
 * redirect_uri always points to the production callback URL.
 */
export function getGitHub(): GitHub {
  if (isOAuthDisabled()) {
    throw new Error(
      "OAuth is disabled in this environment. Use email/password authentication instead.",
    );
  }

  if (!_github) {
    if (!process.env.GH_CLIENT_ID || !process.env.GH_CLIENT_SECRET) {
      throw new Error(
        "Missing GitHub OAuth environment variables: GH_CLIENT_ID, GH_CLIENT_SECRET",
      );
    }
    const baseUrl = getCallbackBaseUrl();
    if (!baseUrl) {
      throw new Error(
        "Missing callback base URL: set PRODUCTION_URL or BASE_URL",
      );
    }
    _github = new GitHub(
      process.env.GH_CLIENT_ID,
      process.env.GH_CLIENT_SECRET,
      `${baseUrl}/api/auth/github/callback`,
    );
  }
  return _github;
}
