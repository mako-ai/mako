/**
 * Auth for the "Mako Cloud Storage" GitHub App — the Mako-OWNED app installed
 * exactly once, on Mako's own org (mako-ai-cloud), which holds the cloud-tier
 * apps repos (one private repo per app project).
 *
 * Deliberately separate from app-auth.ts: that module authenticates the
 * customer-facing BYO App (mako-transforms*) whose installations live on
 * CUSTOMER accounts and are bound per-workspace in Mongo. This app has no
 * per-user install flow at all — the installation id is resolved once from
 * the GitHub API (the app is private, so its only possible installation is
 * on the owner org) and cached for the process lifetime.
 */
import { createSign } from "crypto";

const GITHUB_API = "https://api.github.com";

export function getMakoCloudOrg(): string | undefined {
  return process.env.MAKO_CLOUD_GITHUB_ORG || undefined;
}

/**
 * Prefix namespacing cloud repo names per backing database: "ws" (prod),
 * "staging" (shared by all PR previews), "dev" (local development). Repos are
 * named `<prefix>-<workspaceId>-<projectId>`.
 */
export function getMakoCloudRepoPrefix(): string {
  return process.env.MAKO_CLOUD_REPO_PREFIX || "dev";
}

function getAppId(): string | undefined {
  return process.env.MAKO_CLOUD_GITHUB_APP_ID || undefined;
}

function getPrivateKey(): string | undefined {
  const raw = process.env.MAKO_CLOUD_GITHUB_APP_PRIVATE_KEY;
  return raw ? raw.replace(/\\n/g, "\n") : undefined;
}

export function isMakoCloudConfigured(): boolean {
  return Boolean(getMakoCloudOrg() && getAppId() && getPrivateKey());
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createCloudAppJwt(): string {
  const appId = getAppId();
  const privateKey = getPrivateKey();
  if (!appId || !privateKey) {
    throw new Error(
      "Mako Cloud GitHub App is not configured (MAKO_CLOUD_GITHUB_APP_ID / MAKO_CLOUD_GITHUB_APP_PRIVATE_KEY)",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

let cachedInstallationId: number | null = null;

/**
 * The app is private → it can only ever be installed on its owner org, so the
 * installation id is discoverable rather than configured. Cached for the
 * process lifetime; cleared on token-mint failure so a reinstall self-heals.
 */
async function resolveInstallationId(): Promise<number> {
  if (cachedInstallationId) return cachedInstallationId;
  const org = getMakoCloudOrg();
  const res = await fetch(`${GITHUB_API}/app/installations`, {
    headers: {
      Authorization: `Bearer ${createCloudAppJwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(
      `Failed to list Mako Cloud app installations (${res.status})`,
    );
  }
  const installations = (await res.json()) as Array<{
    id: number;
    account?: { login?: string };
  }>;
  const match = installations.find(i => i.account?.login === org);
  if (!match) {
    throw new Error(
      `Mako Cloud app has no installation on org "${org}" — install it once via https://github.com/organizations/${org}/settings/apps`,
    );
  }
  cachedInstallationId = match.id;
  return match.id;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/** Mint (or return a cached) installation token for the cloud org. */
export async function getMakoCloudToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
    return cachedToken.token;
  }
  const installationId = await resolveInstallationId();
  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${createCloudAppJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    // A stale installation id (uninstall + reinstall) mints 404s forever —
    // drop the cache so the next call re-resolves.
    cachedInstallationId = null;
    const body = await res.text().catch(() => "");
    throw new Error(
      `Failed to mint Mako Cloud installation token (${res.status}): ${body.slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as { token: string; expires_at: string };
  cachedToken = {
    token: json.token,
    expiresAt: new Date(json.expires_at).getTime(),
  };
  return json.token;
}
