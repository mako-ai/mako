import { Google, GitHub } from "arctic";

/**
 * OAuth provider types
 */
export type OAuthProvider = "google" | "github";

// Lazy-loaded providers to ensure environment variables are loaded first
let _google: Google | null = null;
let _github: GitHub | null = null;

/**
 * Check if OAuth is disabled (for PR preview deployments)
 * OAuth is disabled when DISABLE_OAUTH env var is set to "true"
 */
export function isOAuthDisabled(): boolean {
  return process.env.DISABLE_OAUTH === "true";
}

/**
 * Get Google OAuth provider (lazy-loaded)
 * @throws Error if OAuth is disabled or missing environment variables
 */
export function getGoogle(): Google {
  if (isOAuthDisabled()) {
    throw new Error(
      "OAuth is disabled in this environment. Use email/password authentication instead.",
    );
  }

  if (!_google) {
    if (
      !process.env.GOOGLE_CLIENT_ID ||
      !process.env.GOOGLE_CLIENT_SECRET ||
      !process.env.BASE_URL
    ) {
      throw new Error(
        "Missing Google OAuth environment variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BASE_URL",
      );
    }
    _google = new Google(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      `${process.env.BASE_URL}/api/auth/google/callback`,
    );
  }
  return _google;
}

/**
 * Get GitHub OAuth provider (lazy-loaded)
 * @throws Error if OAuth is disabled or missing environment variables
 */
export function getGitHub(): GitHub {
  if (isOAuthDisabled()) {
    throw new Error(
      "OAuth is disabled in this environment. Use email/password authentication instead.",
    );
  }

  if (!_github) {
    if (
      !process.env.GITHUB_CLIENT_ID ||
      !process.env.GITHUB_CLIENT_SECRET ||
      !process.env.BASE_URL
    ) {
      throw new Error(
        "Missing GitHub OAuth environment variables: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, BASE_URL",
      );
    }
    _github = new GitHub(
      process.env.GITHUB_CLIENT_ID,
      process.env.GITHUB_CLIENT_SECRET,
      `${process.env.BASE_URL}/api/auth/github/callback`,
    );
  }
  return _github;
}
