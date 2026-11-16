/**
 * The whole MCP OAuth dance as ChatGPT drives it, through the edge Worker:
 * discovery → DCR → authorize (signed out, then signed in) → consent →
 * callback with code + state + iss → token → refresh.
 *
 * Every request carries what the Cloudflare app-router Worker sends the
 * origin: Host rewritten to the run.app service, X-Forwarded-Host the public
 * one. Until this test, the discovery documents answered with the run.app
 * host there, so ChatGPT sent the user to a host without their session.
 */
import { createHash, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const USER_ID = "64b000000000000000000001";
const WORKSPACE_ID = "64b0000000000000000000aa";
const SESSION = "valid-session";

vi.mock("../auth/session", () => ({
  sessionManager: {
    sessionCookieName: "session",
    validateSession: async (id: string) =>
      id === SESSION
        ? { session: { id }, user: { id: USER_ID } }
        : { session: null, user: null },
  },
}));
vi.mock("../services/workspace.service", () => ({
  workspaceService: {
    getWorkspacesForUser: async () => [
      {
        workspace: { _id: WORKSPACE_ID, name: "RealAdvisor" },
        role: "admin",
      },
    ],
    getMember: async (workspaceId: string, userId: string) =>
      workspaceId === WORKSPACE_ID && userId === USER_ID
        ? { role: "admin" }
        : null,
  },
}));

import {
  McpOAuthClient,
  McpOAuthCode,
  McpOAuthToken,
} from "../database/mcp-oauth-schema";
import { makoServerInfo } from "../mcp/mako-mcp-server";
import { mcpOAuthRoutes, mcpOAuthWellKnownRoutes } from "./mcp-oauth.routes";

const PUBLIC = "https://app.mako.ai";
const ORIGIN = "https://mako-4vn6jszboq-ew.a.run.app";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector/oauth/vDI89OngL3na";
/** What the app-router Worker adds to every proxied request. */
const EDGE = {
  "x-forwarded-host": "app.mako.ai",
  "x-forwarded-proto": "https",
};

let mongo: MongoMemoryServer;
const saved = { ...process.env };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([
    McpOAuthClient.init(),
    McpOAuthCode.init(),
    McpOAuthToken.init(),
  ]);
});
beforeEach(async () => {
  process.env = { ...saved };
  delete process.env.PUBLIC_URL;
  process.env.CLIENT_URL = PUBLIC;
  process.env.BASE_URL = PUBLIC;
  process.env.K_SERVICE = "mako";
  await Promise.all([
    McpOAuthClient.deleteMany({}),
    McpOAuthCode.deleteMany({}),
    McpOAuthToken.deleteMany({}),
  ]);
});
afterAll(async () => {
  process.env = { ...saved };
  await mongoose.disconnect();
  await mongo.stop();
});

function viaEdge(
  routes: typeof mcpOAuthRoutes,
  path: string,
  init: RequestInit & { cookie?: string } = {},
) {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(EDGE)) headers.set(k, v);
  if (init.cookie) headers.set("cookie", init.cookie);
  return routes.request(`${ORIGIN}${path}`, { ...init, headers });
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

async function registerChatGpt(): Promise<string> {
  const res = await viaEdge(mcpOAuthRoutes, "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: [CHATGPT_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** The authorize query ChatGPT sent on prod (16 Nov 2026), plus extras. */
function chatGptAuthorizeQuery(clientId: string, challenge: string) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CHATGPT_REDIRECT,
    scope:
      "mcp query:read warehouse:write connections:write connections:manage workflows:run offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${PUBLIC}/api/mcp`,
    state: `oauth_s_${randomBytes(48).toString("hex")}`,
    ui_locales: "en-US",
    prompt: "consent",
  });
}

it("advertises the public host, not run.app, behind the edge", async () => {
  const as = await viaEdge(
    mcpOAuthWellKnownRoutes,
    "/.well-known/oauth-authorization-server",
  );
  const meta = (await as.json()) as Record<string, unknown>;
  expect(meta.issuer).toBe(PUBLIC);
  expect(meta.authorization_endpoint).toBe(`${PUBLIC}/api/oauth/mcp/authorize`);
  expect(meta.token_endpoint).toBe(`${PUBLIC}/api/oauth/mcp/token`);
  expect(meta.registration_endpoint).toBe(`${PUBLIC}/api/oauth/mcp/register`);
  expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
  expect(meta.grant_types_supported).toContain("refresh_token");
  expect(meta.authorization_response_iss_parameter_supported).toBe(true);

  const prm = await viaEdge(
    mcpOAuthWellKnownRoutes,
    "/.well-known/oauth-protected-resource/api/mcp",
  );
  const resource = (await prm.json()) as Record<string, unknown>;
  expect(resource.resource).toBe(`${PUBLIC}/api/mcp`);
  expect(resource.authorization_servers).toEqual([PUBLIC]);
});

it("sends a signed-out user to login and back to the same authorize request", async () => {
  const clientId = await registerChatGpt();
  const { challenge } = pkce();
  const query = chatGptAuthorizeQuery(clientId, challenge);

  const res = await viaEdge(mcpOAuthRoutes, `/authorize?${query}`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!, PUBLIC);
  expect(location.pathname).toBe("/login");
  const returnTo = location.searchParams.get("returnTo")!;
  // Same-origin relative path: what the login screen's safePath accepts.
  expect(returnTo.startsWith("/api/oauth/mcp/authorize?")).toBe(true);
  expect(returnTo.startsWith("//")).toBe(false);
  const back = new URL(returnTo, PUBLIC).searchParams;
  for (const [key, value] of query) expect(back.get(key)).toBe(value);
});

it("shows a signed-in user the consent page, then calls ChatGPT back with code, state and iss", async () => {
  const clientId = await registerChatGpt();
  const { verifier, challenge } = pkce();
  const query = chatGptAuthorizeQuery(clientId, challenge);
  const state = query.get("state")!;

  const consent = await viaEdge(mcpOAuthRoutes, `/authorize?${query}`, {
    cookie: `session=${SESSION}`,
  });
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain("RealAdvisor");
  expect(html).toContain('action="/api/oauth/mcp/authorize"');

  const approved = await viaEdge(mcpOAuthRoutes, "/authorize", {
    ...form({
      client_id: clientId,
      redirect_uri: CHATGPT_REDIRECT,
      state,
      code_challenge: challenge,
      scope: query.get("scope")!,
      workspace_id: WORKSPACE_ID,
      decision: "allow",
    }),
    cookie: `session=${SESSION}`,
  });
  expect(approved.status).toBe(302);
  const callback = new URL(approved.headers.get("location")!);
  expect(`${callback.origin}${callback.pathname}`).toBe(CHATGPT_REDIRECT);
  expect(callback.searchParams.get("state")).toBe(state);
  expect(callback.searchParams.get("iss")).toBe(PUBLIC);
  const code = callback.searchParams.get("code")!;
  expect(code).toMatch(/^mcpac_/);

  const token = await viaEdge(
    mcpOAuthRoutes,
    "/token",
    form({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: CHATGPT_REDIRECT,
      resource: `${PUBLIC}/api/mcp`,
    }),
  );
  expect(token.status).toBe(200);
  const tokens = (await token.json()) as Record<string, string | number>;
  expect(tokens.access_token).toMatch(/^mcpat_/);
  expect(tokens.refresh_token).toMatch(/^mcprt_/);
  expect(tokens.token_type).toBe("Bearer");

  const refreshed = await viaEdge(
    mcpOAuthRoutes,
    "/token",
    form({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: String(tokens.refresh_token),
      resource: `${PUBLIC}/api/mcp`,
    }),
  );
  expect(refreshed.status).toBe(200);
  const rotated = (await refreshed.json()) as Record<string, string>;
  expect(rotated.access_token).toMatch(/^mcpat_/);
  expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
});

it("still refuses a code without the right PKCE verifier", async () => {
  const clientId = await registerChatGpt();
  const { challenge } = pkce();
  const query = chatGptAuthorizeQuery(clientId, challenge);
  const approved = await viaEdge(mcpOAuthRoutes, "/authorize", {
    ...form({
      client_id: clientId,
      redirect_uri: CHATGPT_REDIRECT,
      state: query.get("state")!,
      code_challenge: challenge,
      workspace_id: WORKSPACE_ID,
      decision: "allow",
    }),
    cookie: `session=${SESSION}`,
  });
  const code = new URL(approved.headers.get("location")!).searchParams.get(
    "code",
  )!;
  const token = await viaEdge(
    mcpOAuthRoutes,
    "/token",
    form({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: pkce().verifier,
    }),
  );
  expect(token.status).toBe(400);
});

it("puts iss on denials and error redirects too", async () => {
  const clientId = await registerChatGpt();
  const { challenge } = pkce();

  const denied = await viaEdge(mcpOAuthRoutes, "/authorize", {
    ...form({
      client_id: clientId,
      redirect_uri: CHATGPT_REDIRECT,
      state: "s1",
      code_challenge: challenge,
      workspace_id: WORKSPACE_ID,
      decision: "deny",
    }),
    cookie: `session=${SESSION}`,
  });
  const deniedUrl = new URL(denied.headers.get("location")!);
  expect(deniedUrl.searchParams.get("error")).toBe("access_denied");
  expect(deniedUrl.searchParams.get("state")).toBe("s1");
  expect(deniedUrl.searchParams.get("iss")).toBe(PUBLIC);

  const query = chatGptAuthorizeQuery(clientId, challenge);
  query.set("response_type", "token");
  const bad = await viaEdge(mcpOAuthRoutes, `/authorize?${query}`);
  const badUrl = new URL(bad.headers.get("location")!);
  expect(badUrl.searchParams.get("error")).toBe("unsupported_response_type");
  expect(badUrl.searchParams.get("iss")).toBe(PUBLIC);
});

it("keeps redirect_uri exact-match", async () => {
  const clientId = await registerChatGpt();
  const { challenge } = pkce();
  const query = chatGptAuthorizeQuery(clientId, challenge);
  query.set("redirect_uri", `${CHATGPT_REDIRECT}/other`);
  const res = await viaEdge(mcpOAuthRoutes, `/authorize?${query}`, {
    cookie: `session=${SESSION}`,
  });
  expect(res.status).toBe(400);
  expect(res.headers.get("location")).toBeNull();
});

it("serverInfo carries Mako's icons on the public origin", () => {
  const info = makoServerInfo(PUBLIC);
  expect(info.title).toBe("Mako");
  expect(info.icons?.[0]).toEqual({
    src: `${PUBLIC}/android-chrome-512x512.png`,
    mimeType: "image/png",
    sizes: ["512x512"],
  });
  expect(makoServerInfo()).toEqual({ name: "mako", version: "0.1.0" });
});
