/**
 * OAuth 2.1 endpoints that let MCP clients connect with just the server URL.
 *
 * Flow (all standard, nothing client-specific):
 *   1. Client POSTs to /api/mcp without a token → 401 + WWW-Authenticate
 *      pointing at RFC 9728 resource metadata.
 *   2. Client discovers this AS (RFC 8414), registers itself (RFC 7591),
 *      and opens /api/oauth/mcp/authorize in the user's browser.
 *   3. User signs in with their Mako session (redirected to /login first if
 *      needed), picks a workspace on the consent page, and approves.
 *   4. Client exchanges the code (PKCE S256) at /api/oauth/mcp/token and
 *      calls /api/mcp with `Authorization: Bearer mcpat_…`.
 *
 * The well-known documents are mounted at the domain root in src/index.ts;
 * everything else lives under /api/oauth/mcp via register-routes.ts.
 */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";

import { sessionManager } from "../auth/session";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  getOAuthClient,
  refreshAccessToken,
  registerOAuthClient,
} from "../auth/mcp-oauth.service";
import { workspaceService } from "../services/workspace.service";
import { loggers } from "../logging";

const logger = loggers.auth();

const AUTHORIZE_PATH = "/api/oauth/mcp/authorize";

/**
 * Public origin clients use to reach Mako (the Vite dev server proxy or the
 * production host). Falls back to the request's own origin so a deployment
 * without PUBLIC_URL still serves consistent metadata.
 */
function publicBaseUrl(c: Context): string {
  const configured = process.env.PUBLIC_URL || process.env.CLIENT_URL;
  if (configured) return configured.replace(/\/$/, "");
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") || url.protocol.slice(0, -1);
  const host = c.req.header("x-forwarded-host") || url.host;
  return `${proto}://${host}`;
}

export function mcpResourceMetadataUrl(c: Context): string {
  return `${publicBaseUrl(c)}/.well-known/oauth-protected-resource/api/mcp`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Well-known discovery documents (mounted at the domain root)
// ---------------------------------------------------------------------------

export const mcpOAuthWellKnownRoutes = new Hono();

function protectedResourceMetadata(c: Context) {
  const base = publicBaseUrl(c);
  return c.json({
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp", "query:read"],
    resource_name: "Mako MCP",
  });
}

mcpOAuthWellKnownRoutes.get(
  "/.well-known/oauth-protected-resource/api/mcp",
  protectedResourceMetadata,
);
mcpOAuthWellKnownRoutes.get(
  "/.well-known/oauth-protected-resource",
  protectedResourceMetadata,
);

mcpOAuthWellKnownRoutes.get("/.well-known/oauth-authorization-server", c => {
  const base = publicBaseUrl(c);
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}${AUTHORIZE_PATH}`,
    token_endpoint: `${base}/api/oauth/mcp/token`,
    registration_endpoint: `${base}/api/oauth/mcp/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp", "query:read"],
  });
});

// ---------------------------------------------------------------------------
// AS endpoints (mounted at /api/oauth/mcp)
// ---------------------------------------------------------------------------

export const mcpOAuthRoutes = new Hono();

/** RFC 7591 dynamic client registration — public clients only. */
mcpOAuthRoutes.post("/register", async c => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_client_metadata" }, 400);
  }
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  try {
    const client = await registerOAuthClient({
      clientName:
        typeof body.client_name === "string" ? body.client_name : undefined,
      redirectUris,
    });
    return c.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(typeof body.client_name === "string"
          ? { client_name: body.client_name }
          : {}),
      },
      201,
    );
  } catch (error) {
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description:
          error instanceof Error ? error.message : "registration failed",
      },
      400,
    );
  }
});

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
}

/**
 * Validate the authorize request. Client/redirect problems return an error
 * page (never redirect to an unverified URI); other problems redirect back
 * to the client with a standard OAuth error.
 */
async function parseAuthorizeParams(
  params: Record<string, string | undefined>,
): Promise<
  | { ok: true; value: AuthorizeParams }
  | { ok: false; status: 400; message: string }
  | { ok: false; redirect: string }
> {
  const clientId = params.client_id;
  const redirectUri = params.redirect_uri;
  if (!clientId || !redirectUri) {
    return {
      ok: false,
      status: 400,
      message: "Missing client_id or redirect_uri",
    };
  }
  const client = await getOAuthClient(clientId);
  if (!client) {
    return { ok: false, status: 400, message: "Unknown client_id" };
  }
  if (!client.redirectUris.includes(redirectUri)) {
    return {
      ok: false,
      status: 400,
      message: "redirect_uri is not registered for this client",
    };
  }

  const fail = (error: string, description: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (params.state) url.searchParams.set("state", params.state);
    return { ok: false as const, redirect: url.toString() };
  };

  if (params.response_type !== "code") {
    return fail(
      "unsupported_response_type",
      "Only response_type=code is supported",
    );
  }
  if (!params.code_challenge) {
    return fail("invalid_request", "PKCE code_challenge is required");
  }
  if ((params.code_challenge_method ?? "S256") !== "S256") {
    return fail(
      "invalid_request",
      "Only code_challenge_method=S256 is supported",
    );
  }

  return {
    ok: true,
    value: {
      clientId,
      redirectUri,
      state: params.state,
      codeChallenge: params.code_challenge,
    },
  };
}

async function sessionUser(c: Context) {
  const sessionId = getCookie(c, sessionManager.sessionCookieName);
  if (!sessionId) return null;
  const { session, user } = await sessionManager.validateSession(sessionId);
  if (!session || !user) return null;
  return user;
}

function consentPage(input: {
  clientName: string;
  params: AuthorizeParams;
  workspaces: { id: string; name: string; role: string }[];
}): string {
  const { clientName, params, workspaces } = input;
  const options = workspaces
    .map(
      (ws, i) => `
      <label class="ws">
        <input type="radio" name="workspace_id" value="${escapeHtml(ws.id)}" ${i === 0 ? "checked" : ""} />
        <span>${escapeHtml(ws.name)}</span>
        <em>${escapeHtml(ws.role)}</em>
      </label>`,
    )
    .join("");
  const hidden = (name: string, value?: string) =>
    value
      ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect ${escapeHtml(clientName)} — Mako</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #f6f5f1; color: #1a1a1a; display: flex; min-height: 100vh;
         align-items: center; justify-content: center; margin: 0; }
  .card { background: #fff; border: 1px solid #d8d5cc; padding: 32px;
          max-width: 420px; width: calc(100% - 48px);
          box-shadow: 6px 6px 0 0 #e3e0d7; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: #555; font-size: 14px; line-height: 1.5; }
  .ws { display: flex; align-items: center; gap: 10px; padding: 10px 12px;
        border: 1px solid #d8d5cc; margin-bottom: 8px; cursor: pointer;
        font-size: 14px; }
  .ws em { margin-left: auto; color: #888; font-style: normal;
           font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  .scopes { background: #f6f5f1; border: 1px solid #e3e0d7; padding: 10px 12px;
            font-size: 13px; color: #444; margin: 16px 0; }
  .actions { display: flex; gap: 8px; margin-top: 20px; }
  button { flex: 1; padding: 10px 16px; font-size: 14px; cursor: pointer;
           border: 1px solid #1a1a1a; }
  .allow { background: #1a1a1a; color: #fff; }
  .deny { background: #fff; color: #1a1a1a; }
</style>
</head>
<body>
<main class="card">
  <h1>Connect ${escapeHtml(clientName)}</h1>
  <p><strong>${escapeHtml(clientName)}</strong> wants to access a Mako workspace over MCP.</p>
  <form method="post" action="${AUTHORIZE_PATH}">
    ${hidden("client_id", params.clientId)}
    ${hidden("redirect_uri", params.redirectUri)}
    ${hidden("state", params.state)}
    ${hidden("code_challenge", params.codeChallenge)}
    <p style="margin-bottom:6px;font-weight:600;color:#1a1a1a">Choose a workspace</p>
    ${options}
    <div class="scopes">
      Read-only access: explore schemas, run read-only queries, and build
      Mako apps. It can never write to your databases.
    </div>
    <div class="actions">
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="allow" type="submit" name="decision" value="allow">Allow</button>
    </div>
  </form>
</main>
</body>
</html>`;
}

mcpOAuthRoutes.get("/authorize", async c => {
  const query = c.req.query();
  const parsed = await parseAuthorizeParams(query);
  if (!parsed.ok) {
    if ("redirect" in parsed) return c.redirect(parsed.redirect, 302);
    return c.html(
      `<h1>Cannot connect</h1><p>${escapeHtml(parsed.message)}</p>`,
      parsed.status,
    );
  }

  const user = await sessionUser(c);
  if (!user) {
    // Bounce through the app's login and come back with the same query.
    const returnTo = encodeURIComponent(
      `${AUTHORIZE_PATH}?${new URL(c.req.url).searchParams.toString()}`,
    );
    return c.redirect(`/login?returnTo=${returnTo}`, 302);
  }

  const memberships = await workspaceService.getWorkspacesForUser(
    String(user.id),
  );
  if (memberships.length === 0) {
    return c.html(
      "<h1>No workspace</h1><p>Create a workspace in Mako first, then retry from your MCP client.</p>",
      400,
    );
  }

  const client = await getOAuthClient(parsed.value.clientId);
  return c.html(
    consentPage({
      clientName: client?.clientName || "An MCP client",
      params: parsed.value,
      workspaces: memberships.map(m => ({
        id: m.workspace._id.toString(),
        name: m.workspace.name,
        role: m.role,
      })),
    }),
  );
});

mcpOAuthRoutes.post("/authorize", async c => {
  const form = await c.req.parseBody();
  const params: Record<string, string | undefined> = {
    response_type: "code",
    code_challenge_method: "S256",
    client_id: typeof form.client_id === "string" ? form.client_id : undefined,
    redirect_uri:
      typeof form.redirect_uri === "string" ? form.redirect_uri : undefined,
    state: typeof form.state === "string" ? form.state : undefined,
    code_challenge:
      typeof form.code_challenge === "string" ? form.code_challenge : undefined,
  };
  const parsed = await parseAuthorizeParams(params);
  if (!parsed.ok) {
    if ("redirect" in parsed) return c.redirect(parsed.redirect, 302);
    return c.html(
      `<h1>Cannot connect</h1><p>${escapeHtml(parsed.message)}</p>`,
      parsed.status,
    );
  }

  const user = await sessionUser(c);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const redirect = new URL(parsed.value.redirectUri);
  if (parsed.value.state) {
    redirect.searchParams.set("state", parsed.value.state);
  }

  if (form.decision !== "allow") {
    redirect.searchParams.set("error", "access_denied");
    return c.redirect(redirect.toString(), 302);
  }

  const workspaceId =
    typeof form.workspace_id === "string" ? form.workspace_id : "";
  const member = await workspaceService.getMember(workspaceId, String(user.id));
  if (!member) {
    return c.html(
      "<h1>Cannot connect</h1><p>You are not a member of that workspace.</p>",
      403,
    );
  }

  const code = await createAuthorizationCode({
    clientId: parsed.value.clientId,
    userId: String(user.id),
    workspaceId,
    redirectUri: parsed.value.redirectUri,
    codeChallenge: parsed.value.codeChallenge,
  });
  logger.info("MCP OAuth grant approved", {
    clientId: parsed.value.clientId,
    workspaceId,
  });
  redirect.searchParams.set("code", code);
  return c.redirect(redirect.toString(), 302);
});

mcpOAuthRoutes.post("/token", async c => {
  const form = await c.req.parseBody();
  const str = (key: string) =>
    typeof form[key] === "string" ? (form[key] as string) : undefined;

  const grantType = str("grant_type");
  const clientId = str("client_id");
  if (!clientId) {
    return c.json(
      { error: "invalid_client", error_description: "client_id is required" },
      400,
    );
  }

  try {
    if (grantType === "authorization_code") {
      const code = str("code");
      const codeVerifier = str("code_verifier");
      if (!code || !codeVerifier) {
        return c.json(
          {
            error: "invalid_request",
            error_description: "code and code_verifier are required",
          },
          400,
        );
      }
      const tokens = await exchangeAuthorizationCode({
        code,
        clientId,
        redirectUri: str("redirect_uri"),
        codeVerifier,
      });
      return c.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresInSeconds,
        refresh_token: tokens.refreshToken,
        scope: tokens.scopes.join(" "),
      });
    }
    if (grantType === "refresh_token") {
      const refreshToken = str("refresh_token");
      if (!refreshToken) {
        return c.json(
          {
            error: "invalid_request",
            error_description: "refresh_token is required",
          },
          400,
        );
      }
      const tokens = await refreshAccessToken({ refreshToken, clientId });
      return c.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresInSeconds,
        refresh_token: tokens.refreshToken,
        scope: tokens.scopes.join(" "),
      });
    }
    return c.json(
      {
        error: "unsupported_grant_type",
        error_description:
          "Supported grant types: authorization_code, refresh_token",
      },
      400,
    );
  } catch (error) {
    return c.json(
      {
        error: "invalid_grant",
        error_description:
          error instanceof Error ? error.message : "token exchange failed",
      },
      400,
    );
  }
});
