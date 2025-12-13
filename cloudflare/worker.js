/**
 * Cloudflare Worker for PR Preview Routing
 *
 * Routes requests from pr-{number}.mako.ai to the corresponding
 * Cloud Run service URL stored in KV.
 *
 * Setup:
 * 1. Create KV namespace: wrangler kv:namespace create MAKO_PR_DEPLOYMENTS
 * 2. Update wrangler.toml with the namespace ID
 * 3. Deploy: wrangler deploy
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const hostname = url.hostname;

    // Extract PR number from subdomain (pr-123.mako.ai)
    const match = hostname.match(/^pr-(\d+)\.mako\.ai$/);
    if (!match) {
      return new Response(
        JSON.stringify({
          error: "Invalid preview URL",
          message: "Expected format: pr-{number}.mako.ai",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const prNumber = match[1];

    // Look up Cloud Run URL from KV
    const targetUrl = await env.MAKO_PR_DEPLOYMENTS.get(prNumber);

    if (!targetUrl) {
      return new Response(
        JSON.stringify({
          error: "Preview not found",
          message: `No preview deployment found for PR #${prNumber}. The PR may still be deploying or has been closed.`,
          pr: prNumber,
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Build the proxy URL
    const proxyUrl = new URL(url.pathname + url.search, targetUrl);

    // Create new headers, preserving originals but updating host
    const proxyHeaders = new Headers(request.headers);
    proxyHeaders.set("Host", new URL(targetUrl).host);
    proxyHeaders.set("X-Forwarded-Host", hostname);
    proxyHeaders.set("X-Forwarded-Proto", "https");
    proxyHeaders.set("X-PR-Number", prNumber);

    // Proxy the request to Cloud Run
    const proxyRequest = new Request(proxyUrl.toString(), {
      method: request.method,
      headers: proxyHeaders,
      body: request.body,
      redirect: "manual",
    });

    try {
      const response = await fetch(proxyRequest);

      // Clone response headers and add CORS if needed
      const responseHeaders = new Headers(response.headers);

      // Handle redirects - rewrite Location header to use preview URL
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("Location");
        if (location) {
          try {
            const locationUrl = new URL(location);
            // If redirect points to Cloud Run, rewrite to preview URL
            if (locationUrl.host === new URL(targetUrl).host) {
              locationUrl.host = hostname;
              locationUrl.protocol = "https:";
              responseHeaders.set("Location", locationUrl.toString());
            }
          } catch {
            // Keep original location if parsing fails
          }
        }
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: "Proxy error",
          message: `Failed to reach preview deployment: ${error.message}`,
          pr: prNumber,
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
};
