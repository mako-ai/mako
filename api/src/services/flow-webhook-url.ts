/**
 * Request-derived base URLs for webhook endpoints: the public origin a
 * provider can reach, inferred from forwarding headers, then env candidates.
 */

export type RequestContextLike = {
  req: {
    url: string;
    header: (name: string) => string | undefined;
  };
};

export function getRequestBaseUrl(c: RequestContextLike): string {
  const requestUrl = new URL(c.req.url);
  const forwardedHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = (forwardedHost || c.req.header("host"))?.split(",")[0]?.trim();
  const forwardedProto = c.req
    .header("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol = forwardedProto || requestUrl.protocol.replace(":", "");

  if (host) {
    return `${protocol}://${host}`;
  }

  return requestUrl.origin;
}

export function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost")
  ) {
    return true;
  }

  if (/^10\./.test(host) || /^192\.168\./.test(host)) {
    return true;
  }

  const match172 = host.match(/^172\.(\d{1,3})\./);
  if (match172) {
    const secondOctet = Number(match172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) {
      return true;
    }
  }

  return false;
}

export function resolveWebhookBaseUrl(
  c: RequestContextLike,
  preferredBaseUrl?: string,
): string {
  if (preferredBaseUrl) {
    try {
      return new URL(preferredBaseUrl).origin;
    } catch {
      // Ignore invalid preferred URL and fall back to inferred values.
    }
  }

  const requestBaseUrl = getRequestBaseUrl(c);
  try {
    const parsedRequestBase = new URL(requestBaseUrl);
    if (!isLoopbackOrPrivateHostname(parsedRequestBase.hostname)) {
      return parsedRequestBase.origin;
    }
  } catch {
    // Fall through to env candidates.
  }

  const envCandidates = [
    process.env.WEBHOOK_PUBLIC_BASE_URL,
    process.env.PUBLIC_URL,
    process.env.API_BASE_URL,
    process.env.BASE_URL,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of envCandidates) {
    try {
      const parsed = new URL(candidate);
      if (!isLoopbackOrPrivateHostname(parsed.hostname)) {
        return parsed.origin;
      }
    } catch {
      // Ignore invalid env URL candidate and keep checking.
    }
  }

  return requestBaseUrl;
}
