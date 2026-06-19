/**
 * GitHub App authentication: mints a short-lived App JWT (RS256, signed with
 * the App private key via Node crypto — no extra dependency) and exchanges it
 * for an installation access token.
 *
 * Installation tokens live ~1h, so we cache them per-installation in-process
 * until shortly before expiry and re-mint on demand. We never persist them.
 */
import { createSign } from "crypto";

import {
  getGitHubAppId,
  getGitHubAppPrivateKey,
  getGitHubDevToken,
  isGitHubAppConfigured,
} from "./config";

const GITHUB_API = "https://api.github.com";

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Build a signed App JWT. `iat` is backdated 60s to tolerate clock drift and
 * the token is valid for the GitHub maximum of 10 minutes.
 */
export function createAppJwt(): string {
  const appId = getGitHubAppId();
  const privateKey = getGitHubAppPrivateKey();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<number, CachedToken>();

/**
 * Mint (or return a cached) installation access token for the given
 * installation id.
 */
export async function getInstallationToken(
  installationId: number,
): Promise<string> {
  if (!isGitHubAppConfigured()) {
    throw new Error(
      "GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)",
    );
  }
  const cached = tokenCache.get(installationId);
  // Refresh 60s before expiry.
  if (cached && cached.expiresAt - 60_000 > Date.now()) {
    return cached.token;
  }
  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${createAppJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to mint installation token (${res.status}): ${body.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, {
    token: json.token,
    expiresAt: new Date(json.expires_at).getTime(),
  });
  return json.token;
}

export interface InstallationMeta {
  accountLogin: string;
  accountType: "Organization" | "User";
  repositorySelection: "all" | "selected";
}

/** Fetch installation account metadata using the App JWT. */
export async function getInstallationMeta(
  installationId: number,
): Promise<InstallationMeta> {
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}`, {
    headers: {
      Authorization: `Bearer ${createAppJwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to read installation ${installationId} (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    account: { login: string; type: "Organization" | "User" };
    repository_selection: "all" | "selected";
  };
  return {
    accountLogin: json.account.login,
    accountType: json.account.type,
    repositorySelection: json.repository_selection,
  };
}

/**
 * Resolve the bearer token to use for a repo operation:
 *  1. installation token (GitHub App) when an installation id is bound, else
 *  2. a dev personal access token (GITHUB_DEV_TOKEN), else
 *  3. undefined → unauthenticated (only works for public repos, rate-limited).
 */
export async function resolveRepoToken(
  installationId?: number,
): Promise<string | undefined> {
  if (installationId && isGitHubAppConfigured()) {
    return getInstallationToken(installationId);
  }
  return getGitHubDevToken();
}
