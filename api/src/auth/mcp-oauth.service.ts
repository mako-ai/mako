/**
 * OAuth 2.1 authorization-server logic for the Mako MCP endpoint.
 *
 * Public clients only (token_endpoint_auth_method "none") with mandatory
 * PKCE S256 — exactly what the MCP spec's auth profile and every major MCP
 * client (Claude, Cursor, Codex) implement. Tokens are opaque `mcpat_`/
 * `mcprt_` strings; scopes are always the read-only MCP set, so an OAuth
 * grant can never do more than a freshly-created MCP API key.
 */
import * as crypto from "crypto";

import {
  McpOAuthClient,
  McpOAuthCode,
  McpOAuthToken,
} from "../database/mcp-oauth-schema";
import {
  DEFAULT_WORKSPACE_API_KEY_SCOPES,
  type WorkspaceApiKeyScope,
  resolveWorkspaceApiKeyScopes,
} from "./api-key-scopes";

export const MCP_ACCESS_TOKEN_PREFIX = "mcpat_";
const MCP_REFRESH_TOKEN_PREFIX = "mcprt_";
const CLIENT_ID_PREFIX = "mcpc_";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Avoid a write per MCP request: bump lastUsedAt at most once a minute. */
const LAST_USED_WRITE_INTERVAL_MS = 60 * 1000;

const MAX_REDIRECT_URIS = 10;

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken(prefix: string): string {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

/**
 * Redirect URIs we accept at registration time: https anywhere, http only on
 * loopback (RFC 8252 native-app flows), or a custom app scheme (e.g.
 * cursor://…). Anything else is refused.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]"
    );
  }
  // Custom scheme (native apps). Require an opaque or host part so bare
  // schemes like "javascript:" don't slip through.
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:$/.test(parsed.protocol) && uri.length > 8;
}

export async function registerOAuthClient(input: {
  clientName?: string;
  redirectUris: string[];
}): Promise<{ clientId: string; redirectUris: string[] }> {
  if (
    input.redirectUris.length === 0 ||
    input.redirectUris.length > MAX_REDIRECT_URIS
  ) {
    throw new Error("redirect_uris must contain between 1 and 10 entries");
  }
  for (const uri of input.redirectUris) {
    if (!isAllowedRedirectUri(uri)) {
      throw new Error(`Unsupported redirect_uri: ${uri}`);
    }
  }
  const clientId = randomToken(CLIENT_ID_PREFIX).slice(0, 40);
  await McpOAuthClient.create({
    clientId,
    clientName: input.clientName?.slice(0, 200),
    redirectUris: input.redirectUris,
  });
  return { clientId, redirectUris: input.redirectUris };
}

export async function getOAuthClient(clientId: string) {
  return McpOAuthClient.findOne({ clientId }).lean();
}

export async function createAuthorizationCode(input: {
  clientId: string;
  userId: string;
  workspaceId: string;
  redirectUri: string;
  codeChallenge: string;
}): Promise<string> {
  const code = randomToken("mcpac_");
  await McpOAuthCode.create({
    codeHash: sha256(code),
    clientId: input.clientId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scopes: [...DEFAULT_WORKSPACE_API_KEY_SCOPES],
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  });
  return code;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
}

async function issueTokens(grant: {
  clientId: string;
  userId: string;
  workspaceId: string;
  scopes: string[];
}): Promise<IssuedTokens> {
  const accessToken = randomToken(MCP_ACCESS_TOKEN_PREFIX);
  const refreshToken = randomToken(MCP_REFRESH_TOKEN_PREFIX);
  await McpOAuthToken.create({
    accessTokenHash: sha256(accessToken),
    refreshTokenHash: sha256(refreshToken),
    clientId: grant.clientId,
    userId: grant.userId,
    workspaceId: grant.workspaceId,
    scopes: grant.scopes,
    accessExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
    refreshExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return {
    accessToken,
    refreshToken,
    expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scopes: grant.scopes,
  };
}

/** PKCE S256: base64url(sha256(verifier)) must equal the stored challenge. */
function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return (
    computed.length === codeChallenge.length &&
    crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(codeChallenge))
  );
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri?: string;
  codeVerifier: string;
}): Promise<IssuedTokens> {
  // Atomically claim the code so a replayed request can never win the race.
  const record = await McpOAuthCode.findOneAndUpdate(
    {
      codeHash: sha256(input.code),
      usedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
    { new: true },
  );
  if (!record) throw new Error("invalid_grant: unknown or expired code");
  if (record.clientId !== input.clientId) {
    throw new Error("invalid_grant: code was issued to a different client");
  }
  if (input.redirectUri && record.redirectUri !== input.redirectUri) {
    throw new Error("invalid_grant: redirect_uri mismatch");
  }
  if (!verifyPkce(input.codeVerifier, record.codeChallenge)) {
    throw new Error("invalid_grant: PKCE verification failed");
  }
  return issueTokens({
    clientId: record.clientId,
    userId: record.userId,
    workspaceId: record.workspaceId,
    scopes: record.scopes,
  });
}

export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
}): Promise<IssuedTokens> {
  // Rotation: the old grant is deleted and a fresh pair is issued.
  const record = await McpOAuthToken.findOneAndDelete({
    refreshTokenHash: sha256(input.refreshToken),
    refreshExpiresAt: { $gt: new Date() },
  });
  if (!record) throw new Error("invalid_grant: unknown or expired token");
  if (record.clientId !== input.clientId) {
    throw new Error("invalid_grant: token was issued to a different client");
  }
  return issueTokens({
    clientId: record.clientId,
    userId: record.userId,
    workspaceId: record.workspaceId,
    scopes: record.scopes,
  });
}

export interface ValidatedMcpToken {
  userId: string;
  workspaceId: string;
  scopes: WorkspaceApiKeyScope[];
}

export async function validateMcpAccessToken(
  token: string,
): Promise<ValidatedMcpToken | null> {
  const record = await McpOAuthToken.findOne({
    accessTokenHash: sha256(token),
    accessExpiresAt: { $gt: new Date() },
  }).lean();
  if (!record) return null;

  const now = Date.now();
  const lastUsed = record.lastUsedAt?.getTime() ?? 0;
  if (now - lastUsed > LAST_USED_WRITE_INTERVAL_MS) {
    McpOAuthToken.updateOne(
      { _id: record._id },
      { $set: { lastUsedAt: new Date() } },
    ).catch(() => {
      /* telemetry only */
    });
  }

  return {
    userId: record.userId,
    workspaceId: record.workspaceId,
    scopes: resolveWorkspaceApiKeyScopes(record.scopes),
  };
}
