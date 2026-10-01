// `mako whoami` — which host/workspace this checkout is signed in to, and
// whether that sign-in still works. An expired access token is refreshed
// (and saved) when the login holds a refresh token; otherwise it says so
// and points at `mako login`, rather than printing a past expiry date as if
// it were fine.
import {
  findCredential,
  refreshCredential,
  saveCredential,
} from "@makoai/app-sdk/credentials";

function describe(entry) {
  return `${entry.apiUrl}${entry.workspaceId ? ` / workspace ${entry.workspaceId}` : ""}`;
}

function scopesLine(entry) {
  return Array.isArray(entry.scopes) && entry.scopes.length > 0
    ? ` Scopes: ${entry.scopes.join(" ")}.`
    : "";
}

export async function whoami(ctx, io = { log: console.log }, deps = {}) {
  const now = deps.now ?? Date.now();
  const refresh = deps.refreshCredential ?? refreshCredential;
  const save = deps.saveCredential ?? saveCredential;
  const entry = (deps.findCredential ?? findCredential)(ctx.apiUrl, ctx.workspaceId);
  if (ctx.apiKey) io.log(`API key configured for ${ctx.apiUrl} (MAKO_API_KEY).`);
  if (!entry) {
    if (ctx.apiKey) return 0;
    io.log(`Not signed in to ${ctx.apiUrl}. Run \`mako login\`.`);
    return 1;
  }

  const expiresAt = entry.expiresAt ? Date.parse(entry.expiresAt) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt > now) {
    io.log(`Signed in to ${describe(entry)} (token expires ${entry.expiresAt}).${scopesLine(entry)}`);
    return 0;
  }

  const when = Number.isFinite(expiresAt) ? `expired ${entry.expiresAt}` : "has no expiry on record";
  if (entry.refreshToken && entry.clientId) {
    try {
      const refreshed = await refresh(entry, deps.fetch);
      save(refreshed.apiUrl ?? entry.apiUrl, entry.workspaceId, refreshed);
      io.log(
        `Signed in to ${describe(entry)} (token ${when}; refreshed, now expires ${refreshed.expiresAt}).${scopesLine(refreshed)}`,
      );
      return 0;
    } catch (error) {
      io.log(
        `Signed in to ${describe(entry)}, but the token ${when} and could not be refreshed ` +
          `(${error instanceof Error ? error.message.split(" — ")[0] : String(error)}). Run \`mako login\`.`,
      );
      return 1;
    }
  }
  io.log(`Signed in to ${describe(entry)}, but the token ${when}. Run \`mako login\`.`);
  return 1;
}
