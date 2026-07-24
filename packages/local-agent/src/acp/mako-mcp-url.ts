/**
 * Allowlist for ACP `mcpUrl` so Local Agent never forwards a minted MCP Bearer
 * to an attacker-controlled host (probe + session attach both hit this URL).
 */

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function envAllowedHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const raw of (process.env.MAKO_AGENT_ALLOWED_MCP_HOSTS || "").split(
    ",",
  )) {
    const host = raw.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  // Origins allowed for Local Agent CORS often share the API host
  // (Vite proxy / PR preview). Map origin → hostname.
  for (const raw of (process.env.MAKO_AGENT_ALLOWED_ORIGINS || "").split(",")) {
    const origin = raw.trim();
    if (!origin) continue;
    try {
      hosts.add(new URL(origin).hostname.toLowerCase());
    } catch {
      // ignore malformed entries
    }
  }
  return hosts;
}

function isAllowedMakoMcpHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (isLoopbackHost(host)) return true;
  if (host === "app.mako.ai") return true;
  // PR previews: https://pr-739.mako.ai (Vite) proxying /api → API.
  if (/^pr-\d+\.mako\.ai$/.test(host)) return true;
  // Cloud Run API hosts used by previews / some Desktop builds.
  if (host.endsWith(".a.run.app") && host.includes("mako")) return true;
  return envAllowedHosts().has(host);
}

/**
 * Validate and normalize a Mako MCP URL. Throws a user-facing Error on reject.
 * Returns the normalized href (no hash; trailing slash stripped from path).
 */
export function assertAllowedMakoMcpUrl(mcpUrl: string): string {
  const trimmed = mcpUrl.trim();
  if (!trimmed) {
    throw new Error("mcpUrl is required to attach Mako workspace tools");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("mcpUrl is not a valid URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("mcpUrl must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("mcpUrl must not include credentials");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("mcpUrl may only use http on localhost");
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/api/mcp") {
    throw new Error("mcpUrl must point to /api/mcp");
  }

  if (!isAllowedMakoMcpHost(url.hostname)) {
    throw new Error(
      `mcpUrl host is not allowed (${url.hostname}). Use the same Mako API host as the browser (app.mako.ai, localhost, or a PR preview).`,
    );
  }

  url.hash = "";
  url.pathname = "/api/mcp";
  return url.href;
}
