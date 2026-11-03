import { createHash, randomBytes } from "crypto";

/**
 * Minimal OAuth 2.0 authorization-code client for the two login providers.
 *
 * Replaces the `arctic` package (deprecated on npm, 2026): we only ever used
 * its Google (PKCE) and GitHub clients, which are a URL builder plus one token
 * POST each. Same surface as arctic's so the controller didn't change shape.
 */

export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export class OAuthRequestError extends Error {
  constructor(
    readonly code: string,
    readonly description: string | null,
  ) {
    super(
      `OAuth request error: ${code}${description ? ` (${description})` : ""}`,
    );
    this.name = "OAuthRequestError";
  }
}

export interface OAuthTokens {
  accessToken(): string;
  /** OpenID Connect ID token, when the provider returned one. */
  idToken(): string | null;
}

interface OAuthClientConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

class OAuthClient {
  constructor(private readonly config: OAuthClientConfig) {}

  protected buildAuthorizationURL(
    state: string,
    scopes: string[],
    codeVerifier?: string,
  ): URL {
    const url = new URL(this.config.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("state", state);
    if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
    if (codeVerifier) {
      const challenge = createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("code_challenge", challenge);
    }
    return url;
  }

  protected async exchangeCode(
    code: string,
    codeVerifier?: string,
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
    });
    if (codeVerifier) body.set("code_verifier", codeVerifier);

    const basic = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString("base64");
    const response = await fetch(this.config.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        // GitHub rejects API requests without a User-Agent.
        "User-Agent": "mako",
        Authorization: `Basic ${basic}`,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new OAuthRequestError(
        `http_${response.status}`,
        "token endpoint returned a non-JSON body",
      );
    }
    // GitHub reports failures as HTTP 200 with an `error` field.
    if (typeof data.error === "string") {
      throw new OAuthRequestError(
        data.error,
        typeof data.error_description === "string"
          ? data.error_description
          : null,
      );
    }
    if (!response.ok || typeof data.access_token !== "string") {
      throw new OAuthRequestError(
        `http_${response.status}`,
        "token endpoint returned no access_token",
      );
    }

    const accessToken = data.access_token;
    const idToken = typeof data.id_token === "string" ? data.id_token : null;
    return { accessToken: () => accessToken, idToken: () => idToken };
  }
}

export class Google extends OAuthClient {
  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    super({
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      clientId,
      clientSecret,
      redirectUri,
    });
  }

  createAuthorizationURL(
    state: string,
    codeVerifier: string,
    scopes: string[],
  ): URL {
    return this.buildAuthorizationURL(state, scopes, codeVerifier);
  }

  validateAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<OAuthTokens> {
    return this.exchangeCode(code, codeVerifier);
  }
}

export class GitHub extends OAuthClient {
  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    super({
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      clientId,
      clientSecret,
      redirectUri,
    });
  }

  createAuthorizationURL(state: string, scopes: string[]): URL {
    return this.buildAuthorizationURL(state, scopes);
  }

  validateAuthorizationCode(code: string): Promise<OAuthTokens> {
    return this.exchangeCode(code);
  }
}
