import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  GitHub,
  Google,
  OAuthRequestError,
  generateCodeVerifier,
  generateState,
} from "./oauth-client";

async function main() {
  // State and PKCE verifiers: 32 random bytes, base64url without padding.
  assert.match(generateState(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(generateCodeVerifier(), generateCodeVerifier());

  // Google: authorization-code flow with an S256 PKCE challenge.
  const google = new Google("gid", "gsecret", "https://mako.test/cb/google");
  const verifier = generateCodeVerifier();
  const gUrl = google.createAuthorizationURL("st", verifier, [
    "openid",
    "email",
  ]);
  assert.equal(
    gUrl.origin + gUrl.pathname,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  assert.equal(gUrl.searchParams.get("response_type"), "code");
  assert.equal(gUrl.searchParams.get("client_id"), "gid");
  assert.equal(
    gUrl.searchParams.get("redirect_uri"),
    "https://mako.test/cb/google",
  );
  assert.equal(gUrl.searchParams.get("state"), "st");
  assert.equal(gUrl.searchParams.get("scope"), "openid email");
  assert.equal(gUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    gUrl.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
  );

  // GitHub: no PKCE.
  const github = new GitHub("hid", "hsecret", "https://mako.test/cb/github");
  const hUrl = github.createAuthorizationURL("st2", ["user:email"]);
  assert.equal(
    hUrl.origin + hUrl.pathname,
    "https://github.com/login/oauth/authorize",
  );
  assert.equal(hUrl.searchParams.get("scope"), "user:email");
  assert.equal(hUrl.searchParams.get("code_challenge"), null);

  // Token exchange: client credentials as HTTP Basic, form-encoded body.
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let reply: () => Response = () => Response.json({});
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply();
  }) as typeof fetch;
  try {
    reply = () =>
      Response.json({
        access_token: "at",
        id_token: "a.b.c",
        token_type: "Bearer",
      });
    const tokens = await google.validateAuthorizationCode("code1", verifier);
    assert.equal(tokens.accessToken(), "at");
    assert.equal(tokens.idToken(), "a.b.c");
    const [call] = calls;
    assert.equal(call.url, "https://oauth2.googleapis.com/token");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(
      headers.Authorization,
      `Basic ${Buffer.from("gid:gsecret").toString("base64")}`,
    );
    const body = new URLSearchParams(String(call.init.body));
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "code1");
    assert.equal(body.get("code_verifier"), verifier);
    assert.equal(body.get("redirect_uri"), "https://mako.test/cb/google");

    // No id_token (GitHub): idToken() is null rather than throwing.
    reply = () => Response.json({ access_token: "gh" });
    const ghTokens = await github.validateAuthorizationCode("code2");
    assert.equal(ghTokens.accessToken(), "gh");
    assert.equal(ghTokens.idToken(), null);
    assert.equal(
      new URLSearchParams(String(calls[1].init.body)).get("code_verifier"),
      null,
    );

    // GitHub reports a bad code as HTTP 200 with an `error` field.
    reply = () =>
      Response.json({
        error: "bad_verification_code",
        error_description: "expired",
      });
    await assert.rejects(
      github.validateAuthorizationCode("stale"),
      (err: unknown) =>
        err instanceof OAuthRequestError &&
        err.code === "bad_verification_code",
    );

    // Non-JSON and missing-token responses are errors too.
    reply = () => new Response("<html>502</html>", { status: 502 });
    await assert.rejects(
      google.validateAuthorizationCode("c", verifier),
      OAuthRequestError,
    );
    reply = () => Response.json({ token_type: "Bearer" });
    await assert.rejects(
      google.validateAuthorizationCode("c", verifier),
      OAuthRequestError,
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  process.stdout.write("oauth-client tests passed\n");
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
