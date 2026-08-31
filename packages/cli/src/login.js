// `mako login` — the OAuth 2.1 sign-in every MCP client does against Mako,
// done once from the terminal and kept in ~/.mako/credentials.json for the
// Vite plugin. RFC 8252 native-app flow: PKCE (S256), a loopback redirect on
// 127.0.0.1, dynamic client registration, no client secret.
import crypto from "node:crypto";
import http from "node:http";
import { saveCredential, normalizeApiUrl } from "@makoai/app-sdk/credentials";
import { openInBrowser } from "./browser.js";

const CLIENT_NAME = "Mako CLI";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** RFC 8414 discovery with the server's documented paths as fallback. */
export async function discover(apiUrl, fetchImpl = globalThis.fetch) {
  const base = normalizeApiUrl(apiUrl);
  const fallback = {
    authorization_endpoint: `${base}/api/oauth/mcp/authorize`,
    token_endpoint: `${base}/api/oauth/mcp/token`,
    registration_endpoint: `${base}/api/oauth/mcp/register`,
  };
  try {
    const res = await fetchImpl(`${base}/.well-known/oauth-authorization-server`);
    if (!res.ok) return fallback;
    const meta = await res.json();
    return { ...fallback, ...meta };
  } catch {
    return fallback;
  }
}

export async function registerClient(meta, redirectUri, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) {
    throw new Error(`client registration failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  if (!body.client_id) throw new Error("client registration returned no client_id");
  return body.client_id;
}

/** Wait for exactly one loopback redirect carrying our state; resolve the code. */
function awaitCallback(server, expectedState, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("sign-in timed out — no redirect received"));
    }, timeoutMs);
    server.on("request", (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (state !== expectedState || (!code && !error)) {
        res.statusCode = 400;
        res.end("<p>Unexpected callback. Return to the terminal and run <code>mako login</code> again.</p>");
        return;
      }
      res.end(
        error
          ? `<p>Sign-in failed: ${error}. You can close this tab.</p>`
          : "<p>Signed in to Mako. You can close this tab and return to the terminal.</p>",
      );
      clearTimeout(timer);
      server.close();
      error ? reject(new Error(`sign-in refused: ${error} ${url.searchParams.get("error_description") ?? ""}`.trim())) : resolve(code);
    });
  });
}

export async function login(ctx, flags, io = { log: console.log }) {
  const apiUrl = normalizeApiUrl(ctx.apiUrl);
  const meta = await discover(apiUrl);

  const server = http.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const clientId = await registerClient(meta, redirectUri);
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString("base64url");
  const authorize = new URL(meta.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    resource: `${apiUrl}/api/mcp`,
  }).toString();

  io.log(`Signing in to ${apiUrl}${ctx.workspaceId ? ` (workspace ${ctx.workspaceId})` : ""}…`);
  if (flags.browser === false || !openInBrowser(authorize.toString())) {
    io.log(`Open this URL in your browser:\n\n  ${authorize}\n`);
  } else {
    io.log("Your browser opened; pick the workspace and approve. Waiting…");
  }
  const code = await awaitCallback(server, state, LOGIN_TIMEOUT_MS);

  const tokenRes = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`token exchange failed: HTTP ${tokenRes.status} ${(await tokenRes.text()).slice(0, 200)}`);
  }
  const tokens = await tokenRes.json();
  saveCredential(apiUrl, ctx.workspaceId, {
    clientId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + Number(tokens.expires_in || 3600) * 1000).toISOString(),
    scopes: typeof tokens.scope === "string" ? tokens.scope.split(" ") : undefined,
  });
  io.log(`Signed in. Credentials saved for ${apiUrl}${ctx.workspaceId ? ` / workspace ${ctx.workspaceId}` : ""}.`);
  if (!ctx.workspaceId) {
    io.log("Tip: run `mako login` inside a workspace checkout so the credential is tied to that workspace.");
  }
  return 0;
}
