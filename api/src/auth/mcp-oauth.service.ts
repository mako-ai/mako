/**
 * OAuth 2.1 authorization-server logic for the Mako MCP endpoint.
 *
 * Public clients only (token_endpoint_auth_method "none") with mandatory
 * PKCE S256 — exactly what the MCP spec's auth profile and every major MCP
 * client (Claude, Cursor, Codex) implement. Tokens are opaque `mcpat_`/
 * `mcprt_` strings. OAuth grants default to the read-only MCP set; clients
 * may explicitly request the narrower `warehouse:write` scope for governed
 * dbt execution, which is shown prominently on the consent screen.
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

/** Public scopes the browser OAuth flow may grant to an MCP client. */
export const MCP_OAUTH_SCOPES = [
  "mcp",
  "query:read",
  "warehouse:write",
] as const satisfies readonly WorkspaceApiKeyScope[];

const MCP_OAUTH_SCOPE_SET = new Set<string>(MCP_OAUTH_SCOPES);

/**
 * Parse the OAuth `scope` parameter. Baseline MCP/read scopes are always
 * present so a client asking only for the optional dbt execution permission
 * still receives a useful MCP grant. Omitted scope preserves the historical
 * read-only default.
 */
export function parseMcpOAuthScopes(value?: string): WorkspaceApiKeyScope[] {
  if (!value?.trim()) return [...DEFAULT_WORKSPACE_API_KEY_SCOPES];

  const requested = [...new Set(value.trim().split(/\s+/))];
  for (const scope of requested) {
    if (!MCP_OAUTH_SCOPE_SET.has(scope)) {
      throw new Error(`Unsupported OAuth scope: ${scope}`);
    }
  }

  return [
    ...DEFAULT_WORKSPACE_API_KEY_SCOPES,
    ...(requested.includes("warehouse:write")
      ? (["warehouse:write"] as const)
      : []),
  ];
}

/** Never turn a client request into warehouse authority without user opt-in. */
export function resolveMcpOAuthConsentScopes(
  requested: readonly WorkspaceApiKeyScope[],
  warehouseWriteApproved: boolean,
): WorkspaceApiKeyScope[] {
  return requested.filter(
    scope => scope !== "warehouse:write" || warehouseWriteApproved,
  );
}

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
  scopes: WorkspaceApiKeyScope[];
}): Promise<string> {
  const code = randomToken("mcpac_");
  await McpOAuthCode.create({
    codeHash: sha256(code),
    clientId: input.clientId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scopes: input.scopes,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  });
  return code;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
  agentSessionId?: string;
}

async function issueTokens(grant: {
  clientId: string;
  userId: string;
  workspaceId: string;
  scopes: string[];
  agentSessionId?: string;
}): Promise<IssuedTokens> {
  const accessToken = randomToken(MCP_ACCESS_TOKEN_PREFIX);
  const refreshToken = randomToken(MCP_REFRESH_TOKEN_PREFIX);
  await McpOAuthToken.create({
    accessTokenHash: sha256(accessToken),
    refreshTokenHash: sha256(refreshToken),
    clientId: grant.clientId,
    userId: grant.userId,
    workspaceId: grant.workspaceId,
    agentSessionId: grant.agentSessionId,
    scopes: grant.scopes,
    accessExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
    refreshExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return {
    accessToken,
    refreshToken,
    expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scopes: grant.scopes,
    agentSessionId: grant.agentSessionId,
  };
}

/** Fixed public client used when Mako attaches `/api/mcp` to an ACP session. */
export const ACP_MCP_CLIENT_ID = "mako-acp-local";
export const ACP_MCP_CLIENT_NAME = "Mako Coding Agent (ACP)";

async function ensureAcpMcpClient(): Promise<void> {
  const existing = await McpOAuthClient.findOne({
    clientId: ACP_MCP_CLIENT_ID,
  }).lean();
  if (existing) return;
  try {
    await McpOAuthClient.create({
      clientId: ACP_MCP_CLIENT_ID,
      clientName: ACP_MCP_CLIENT_NAME,
      // Session-minted grants never use the authorize redirect; keep a valid
      // loopback URI so the client row satisfies registration constraints.
      // Public /authorize must reject this clientId (session-mint only).
      redirectUris: ["http://127.0.0.1/acp-callback"],
    });
  } catch (error) {
    // Concurrent first mints can race the unique clientId index.
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code !== 11000) throw error;
  }
}

/**
 * Mint a short-lived MCP access token for the signed-in user so Local Agent
 * can attach Mako's HTTP MCP server on ACP `session/new`.
 */
export async function mintMcpAccessTokenForUser(input: {
  userId: string;
  workspaceId: string;
}): Promise<IssuedTokens> {
  await ensureAcpMcpClient();
  const agentSessionId = crypto.randomUUID();
  return issueTokens({
    clientId: ACP_MCP_CLIENT_ID,
    userId: input.userId,
    workspaceId: input.workspaceId,
    scopes: [...DEFAULT_WORKSPACE_API_KEY_SCOPES],
    agentSessionId,
  });
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
    agentSessionId: record.agentSessionId,
  });
}

/**
 * One row per connected agent: a (client × user) pair that holds at least one
 * live grant in the workspace. Grants are token documents; refresh rotation
 * replaces them, so `connectedAt` is the oldest surviving grant's creation.
 */
export interface McpConnectionSummary {
  clientId: string;
  clientName?: string;
  userId: string;
  connectedAt: Date;
  lastUsedAt?: Date;
  accessExpiresAt: Date;
}

export async function listMcpConnections(
  workspaceId: string,
): Promise<McpConnectionSummary[]> {
  const grants = await McpOAuthToken.aggregate<{
    _id: { clientId: string; userId: string };
    connectedAt: Date;
    lastUsedAt?: Date;
    accessExpiresAt: Date;
  }>([
    { $match: { workspaceId, refreshExpiresAt: { $gt: new Date() } } },
    {
      $group: {
        _id: { clientId: "$clientId", userId: "$userId" },
        connectedAt: { $min: "$createdAt" },
        lastUsedAt: { $max: "$lastUsedAt" },
        accessExpiresAt: { $max: "$accessExpiresAt" },
      },
    },
    { $sort: { lastUsedAt: -1, connectedAt: -1 } },
  ]);

  const clientIds = [...new Set(grants.map(g => g._id.clientId))];
  const clients = await McpOAuthClient.find({ clientId: { $in: clientIds } })
    .select("clientId clientName")
    .lean();
  const nameByClientId = new Map(
    clients.map(c => [c.clientId, c.clientName] as const),
  );

  return grants.map(g => ({
    clientId: g._id.clientId,
    clientName: nameByClientId.get(g._id.clientId),
    userId: g._id.userId,
    connectedAt: g.connectedAt,
    lastUsedAt: g.lastUsedAt,
    accessExpiresAt: g.accessExpiresAt,
  }));
}

/**
 * Revoke every grant a (client × user) pair holds in the workspace. The agent
 * loses access immediately (access tokens are validated against the DB) and
 * must run the sign-in flow again to reconnect.
 */
export async function revokeMcpConnection(input: {
  workspaceId: string;
  clientId: string;
  userId: string;
}): Promise<number> {
  const result = await McpOAuthToken.deleteMany({
    workspaceId: input.workspaceId,
    clientId: input.clientId,
    userId: input.userId,
  });
  return result.deletedCount ?? 0;
}

export interface ValidatedMcpToken {
  userId: string;
  workspaceId: string;
  scopes: WorkspaceApiKeyScope[];
  /** OAuth client that minted the grant (e.g. `mako-acp-local`). */
  clientId: string;
  agentSessionId?: string;
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
    clientId: record.clientId,
    agentSessionId: record.agentSessionId,
  };
}
