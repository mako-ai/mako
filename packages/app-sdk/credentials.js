// @makoai/app-sdk/credentials — the laptop credential store shared by the
// `mako` CLI (which writes it) and the Vite plugin (which reads it).
//
// `mako login` runs the same OAuth 2.1 sign-in Claude Code uses against the
// Mako MCP server (PKCE, loopback redirect, rotating refresh tokens) and keeps
// the result here. Tokens are always workspace-bound and read-only — exactly
// what a local dev server needs and nothing more.
//
// Plain ESM, Node built-ins only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CREDENTIALS_PATH =
  process.env.MAKO_CREDENTIALS_FILE ||
  path.join(os.homedir(), ".mako", "credentials.json");

const REFRESH_SKEW_MS = 60 * 1000;

export function normalizeApiUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

/** Storage key: one entry per (host, workspace). "*" = workspace unknown. */
export function credentialKey(apiUrl, workspaceId) {
  return `${normalizeApiUrl(apiUrl)}#${workspaceId || "*"}`;
}

export function readCredentialStore(file = CREDENTIALS_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeCredentialStore(store, file = CREDENTIALS_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}

/**
 * The stored entry for a host + workspace: the exact match first, then the
 * host's wildcard entry (a login done outside any workspace checkout).
 */
export function findCredential(apiUrl, workspaceId, store = readCredentialStore()) {
  return (
    store[credentialKey(apiUrl, workspaceId)] ??
    store[credentialKey(apiUrl, null)] ??
    null
  );
}

export function saveCredential(apiUrl, workspaceId, entry, file = CREDENTIALS_PATH) {
  const store = readCredentialStore(file);
  store[credentialKey(apiUrl, workspaceId)] = {
    ...entry,
    apiUrl: normalizeApiUrl(apiUrl),
    workspaceId: workspaceId || null,
    savedAt: new Date().toISOString(),
  };
  writeCredentialStore(store, file);
}

export function removeCredential(apiUrl, workspaceId, file = CREDENTIALS_PATH) {
  const store = readCredentialStore(file);
  const key = credentialKey(apiUrl, workspaceId);
  const had = key in store;
  delete store[key];
  writeCredentialStore(store, file);
  return had;
}

/** Refresh an entry's access token through the MCP OAuth token endpoint. */
export async function refreshCredential(entry, fetchImpl = globalThis.fetch) {
  if (!entry?.refreshToken || !entry?.clientId) {
    throw new Error("stored credential has no refresh token; run `mako login` again");
  }
  const res = await fetchImpl(`${normalizeApiUrl(entry.apiUrl)}/api/oauth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: entry.refreshToken,
      client_id: entry.clientId,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token refresh failed: HTTP ${res.status} ${text.slice(0, 200)} — run \`mako login\` again`);
  }
  const body = await res.json();
  return {
    ...entry,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? entry.refreshToken,
    expiresAt: new Date(Date.now() + Number(body.expires_in || 3600) * 1000).toISOString(),
    scopes: typeof body.scope === "string" ? body.scope.split(" ") : entry.scopes,
  };
}

/**
 * A usable bearer token for (apiUrl, workspaceId), refreshing and persisting
 * when the stored one is about to expire. Null when nobody logged in.
 */
export async function getAccessToken(apiUrl, workspaceId, options = {}) {
  const file = options.file ?? CREDENTIALS_PATH;
  const entry = findCredential(apiUrl, workspaceId, readCredentialStore(file));
  if (!entry) return null;
  const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : 0;
  if (entry.accessToken && expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return entry.accessToken;
  }
  const refreshed = await refreshCredential(entry, options.fetch);
  saveCredential(refreshed.apiUrl, entry.workspaceId, refreshed, file);
  return refreshed.accessToken;
}
