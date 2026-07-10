const SUPPORTED_HOSTS = new Set(["app.mako.ai", "app-canary.mako.ai"]);

const ALWAYS_AVAILABLE_PATHS = new Set(["/health", "/api/version"]);

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

function isWebhookPath(pathname) {
  return (
    pathname.startsWith("/api/webhooks/") ||
    pathname === "/api/github/webhook"
  );
}

function isMaintenanceSafe(pathname) {
  return ALWAYS_AVAILABLE_PATHS.has(pathname) || isWebhookPath(pathname);
}

function parseRouteConfig(rawConfig) {
  if (!rawConfig) return null;

  try {
    const config = JSON.parse(rawConfig);
    const origin = new URL(config.origin);
    if (origin.protocol !== "https:") return null;

    return {
      origin: origin.toString(),
      maintenance: config.maintenance === true,
    };
  } catch {
    return null;
  }
}

async function constantTimeEqual(left, right) {
  if (!left || !right) return false;

  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);

  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function maintenanceBypassed(request, env) {
  const configuredToken = env.MAINTENANCE_BYPASS_TOKEN;
  const suppliedToken = request.headers.get("X-Mako-Maintenance-Token");
  return constantTimeEqual(configuredToken, suppliedToken);
}

function rewriteRedirect(responseHeaders, targetUrl, publicUrl) {
  const location = responseHeaders.get("Location");
  if (!location) return;

  try {
    const locationUrl = new URL(location, targetUrl);
    const targetHost = new URL(targetUrl).host;
    if (locationUrl.host !== targetHost) return;

    locationUrl.protocol = publicUrl.protocol;
    locationUrl.host = publicUrl.host;
    responseHeaders.set("Location", locationUrl.toString());
  } catch {
    // Preserve malformed or non-URL Location values exactly as received.
  }
}

async function proxyRequest(request, targetUrl, publicUrl) {
  const upstreamUrl = new URL(publicUrl.pathname + publicUrl.search, targetUrl);
  const upstreamRequest = new Request(upstreamUrl.toString(), request);
  upstreamRequest.headers.set("Host", upstreamUrl.host);
  upstreamRequest.headers.set("X-Forwarded-Host", publicUrl.host);
  upstreamRequest.headers.set("X-Forwarded-Proto", "https");

  const upstreamResponse = await fetch(upstreamRequest, {
    redirect: "manual",
  });
  const responseHeaders = new Headers(upstreamResponse.headers);
  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    rewriteRedirect(responseHeaders, targetUrl, publicUrl);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
    webSocket: upstreamResponse.webSocket,
  });
}

export default {
  async fetch(request, env) {
    const publicUrl = new URL(request.url);
    if (!SUPPORTED_HOSTS.has(publicUrl.hostname)) {
      return jsonResponse(404, { error: "unsupported_host" });
    }

    // Origin and maintenance state are one JSON value so each Cloudflare PoP
    // sees a coherent route configuration even while KV propagates globally.
    const routeConfig = parseRouteConfig(
      await env.MAKO_APP_ROUTING.get(`route:${publicUrl.hostname}`),
    );
    if (!routeConfig) {
      return jsonResponse(503, { error: "origin_not_configured" });
    }

    if (
      routeConfig.maintenance &&
      !isMaintenanceSafe(publicUrl.pathname) &&
      !(await maintenanceBypassed(request, env))
    ) {
      return jsonResponse(
        503,
        {
          error: "maintenance",
          message: "Mako is temporarily unavailable during scheduled maintenance.",
        },
        { "Retry-After": "300" },
      );
    }

    try {
      return await proxyRequest(request, routeConfig.origin, publicUrl);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "app_router_proxy_error",
          host: publicUrl.hostname,
          path: publicUrl.pathname,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return jsonResponse(502, { error: "origin_unavailable" });
    }
  },
};
