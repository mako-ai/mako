/**
 * GitHub App configuration (lazy env reads, mirroring api/src/billing/config.ts).
 *
 * These are distinct from the GH_CLIENT_ID/GH_CLIENT_SECRET used for *login*
 * OAuth (api/src/auth/arctic.ts). A GitHub *App* has its own App id, private
 * key and (optionally) an OAuth client used for the install/identify flow.
 *
 * For local development and importing *public* repos you don't need an App at
 * all: set GITHUB_DEV_TOKEN to a personal access token, or leave everything
 * unset and rely on unauthenticated access to public repos.
 */

export function isGitHubAppConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY,
  );
}

export function getGitHubAppId(): string {
  const id = process.env.GITHUB_APP_ID;
  if (!id) throw new Error("GITHUB_APP_ID is not set");
  return id;
}

/**
 * The App's PEM private key. Supports either a literal PEM (with real
 * newlines) or a single-line value with escaped "\n" (common in .env files).
 */
export function getGitHubAppPrivateKey(): string {
  const key = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!key) throw new Error("GITHUB_APP_PRIVATE_KEY is not set");
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

/** Slug used to build the install URL (https://github.com/apps/<slug>). */
export function getGitHubAppSlug(): string | undefined {
  return process.env.GITHUB_APP_SLUG || undefined;
}

/** Webhook secret used to verify inbound GitHub App webhooks (later slice). */
export function getGitHubAppWebhookSecret(): string | undefined {
  return process.env.GITHUB_APP_WEBHOOK_SECRET || undefined;
}

/**
 * Personal access token used as a fallback when no GitHub App installation is
 * available (local dev, or importing repos the App is not installed on).
 */
export function getGitHubDevToken(): string | undefined {
  return process.env.GITHUB_DEV_TOKEN || undefined;
}
