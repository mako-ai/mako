import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import { generateState, generateCodeVerifier } from "arctic";
import { sessionManager } from "./session";
import { getGoogle, getGitHub, isOAuthDisabled } from "./arctic";
import { AuthService } from "./auth.service";
import { authMiddleware, rateLimitMiddleware } from "./auth.middleware";
import {
  getRequestOrigin,
  getProductionUrl,
  isProduction,
  isAllowedOrigin,
  encodeOAuthState,
  decodeOAuthState,
  createTransferToken,
  verifyTransferToken,
} from "./oauth-proxy";
import { loggers } from "../logging";

const logger = loggers.auth();

type Variables = {
  user: any;
  session: any;
};

const authService = new AuthService();
export const authRoutes = new Hono<{ Variables: Variables }>();

const convertCookieAttributes = (attributes: any) => ({
  ...attributes,
  sameSite: attributes.sameSite
    ? ((attributes.sameSite.charAt(0).toUpperCase() +
        attributes.sameSite.slice(1)) as "Strict" | "Lax" | "None")
    : undefined,
});

const authRateLimiter = rateLimitMiddleware(
  parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"),
  parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "5"),
);

// ── Auth config ──────────────────────────────────────────────────────────────

authRoutes.get("/config", async c => {
  return c.json({
    oauthEnabled: !isOAuthDisabled(),
    providers: isOAuthDisabled() ? [] : ["google", "github"],
  });
});

// ── Email/password routes (unchanged) ────────────────────────────────────────

authRoutes.post("/register", authRateLimiter, async c => {
  try {
    const { email, password } = await c.req.json();

    const { user, requiresVerification } = await authService.register(
      email,
      password,
    );

    return c.json({
      user: {
        id: user._id,
        email: user.email,
        createdAt: user.createdAt,
        emailVerified: user.emailVerified,
      },
      requiresVerification,
      message: "Verification email sent. Please check your inbox.",
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

authRoutes.post("/verify-email", authRateLimiter, async c => {
  try {
    const { email, code } = await c.req.json();

    if (!email || !code) {
      return c.json({ error: "Email and verification code are required" }, 400);
    }

    const { user, session } = await authService.verifyEmail(email, code);

    const sessionCookie = sessionManager.createSessionCookie(session.id);
    setCookie(
      c,
      sessionCookie.name,
      sessionCookie.value,
      convertCookieAttributes(sessionCookie.attributes),
    );

    return c.json({
      user: {
        id: user._id,
        email: user.email,
        createdAt: user.createdAt,
        emailVerified: user.emailVerified,
      },
      message: "Email verified successfully",
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

authRoutes.post("/resend-verification", authRateLimiter, async c => {
  try {
    const { email } = await c.req.json();

    if (!email) {
      return c.json({ error: "Email is required" }, 400);
    }

    await authService.resendVerification(email);

    return c.json({
      message: "Verification email sent. Please check your inbox.",
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

authRoutes.post("/login", authRateLimiter, async c => {
  try {
    const { email, password } = await c.req.json();

    const { user, session } = await authService.login(email, password);

    const sessionCookie = sessionManager.createSessionCookie(session.id);
    setCookie(
      c,
      sessionCookie.name,
      sessionCookie.value,
      convertCookieAttributes(sessionCookie.attributes),
    );

    return c.json({
      user: {
        id: user._id,
        email: user.email,
        createdAt: user.createdAt,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

authRoutes.post("/logout", authMiddleware, async c => {
  try {
    const session = c.get("session");

    await authService.logout(session.id);

    const sessionCookie = sessionManager.createBlankSessionCookie();
    setCookie(
      c,
      sessionCookie.name,
      sessionCookie.value,
      convertCookieAttributes(sessionCookie.attributes),
    );

    return c.json({ message: "Logged out successfully" });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

authRoutes.get("/me", authMiddleware, async c => {
  try {
    const user = c.get("user");

    const linkedAccounts = await authService.getLinkedAccounts(user.id);

    return c.json({
      user: {
        id: user.id,
        email: user.email,
        linkedAccounts,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

authRoutes.put("/onboarding", authMiddleware, async c => {
  try {
    const user = c.get("user");
    const { role, companySize, primaryDatabase, dataWarehouse } =
      await c.req.json();

    await authService.updateOnboardingData(user.id, {
      role,
      companySize,
      primaryDatabase,
      dataWarehouse,
    });

    return c.json({
      success: true,
      message: "Onboarding data saved successfully",
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

authRoutes.post("/refresh", async c => {
  try {
    const sessionId = sessionManager.readSessionCookie(
      c.req.header("Cookie") || "",
    );

    if (!sessionId) {
      return c.json({ error: "No session found" }, 401);
    }

    const { session, user } = await authService.validateSession(sessionId);

    if (!session || !user) {
      return c.json({ error: "Invalid session" }, 401);
    }

    if (session.fresh) {
      const sessionCookie = sessionManager.createSessionCookie(session.id);
      setCookie(
        c,
        sessionCookie.name,
        sessionCookie.value,
        convertCookieAttributes(sessionCookie.attributes),
      );
    }

    return c.json({
      user: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

authRoutes.post("/request-set-password", authMiddleware, async c => {
  try {
    const user = c.get("user");

    await authService.sendLinkPasswordVerification(user.email);

    return c.json({
      message: "Verification code sent to your email.",
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

authRoutes.post("/set-password", authMiddleware, async c => {
  try {
    const user = c.get("user");
    const { password, code } = await c.req.json();

    if (!password || !code) {
      return c.json(
        { error: "Password and verification code are required" },
        400,
      );
    }

    await authService.linkPassword(user.email, password, code);

    return c.json({
      message:
        "Password set successfully. You can now login with your email and password.",
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

authRoutes.post("/forgot-password", authRateLimiter, async c => {
  try {
    const { email } = await c.req.json();

    if (!email) {
      return c.json({ error: "Email is required" }, 400);
    }

    await authService.requestPasswordReset(email);

    return c.json({
      message:
        "If an account exists with this email, you will receive a password reset link.",
    });
  } catch (error: any) {
    logger.error("Password reset request error", { error });
    return c.json({
      message:
        "If an account exists with this email, you will receive a password reset link.",
    });
  }
});

authRoutes.post("/reset-password", authRateLimiter, async c => {
  try {
    const { email, code, password } = await c.req.json();

    if (!email || !code || !password) {
      return c.json(
        { error: "Email, code, and new password are required" },
        400,
      );
    }

    await authService.resetPassword(email, code, password);

    return c.json({
      message:
        "Password reset successfully. You can now login with your new password.",
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

// ── Google OAuth initiation (proxy-aware) ────────────────────────────────────

authRoutes.get("/google", async c => {
  if (isOAuthDisabled()) {
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_disabled`);
  }

  const productionUrl = getProductionUrl();

  // Non-production: redirect to production's /google with ?origin=<caller>
  if (!isProduction(c)) {
    const callerOrigin = getRequestOrigin(c);
    const target = new URL(`${productionUrl}/api/auth/google`);
    target.searchParams.set("origin", callerOrigin);
    logger.info("OAuth proxy: redirecting to production for Google login", {
      callerOrigin,
    });
    return c.redirect(target.toString());
  }

  // Production: read the caller's origin (or default to production)
  const rawOrigin = c.req.query("origin");
  const origin =
    rawOrigin && isAllowedOrigin(rawOrigin) ? rawOrigin : productionUrl;

  if (rawOrigin && !isAllowedOrigin(rawOrigin)) {
    logger.warn("OAuth proxy: rejected untrusted origin", {
      origin: rawOrigin,
    });
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
  }

  const nonce = generateState();
  const codeVerifier = generateCodeVerifier();
  const state = encodeOAuthState(nonce, origin);

  setCookie(c, "google_oauth_state", nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10,
    sameSite: "Lax",
    path: "/",
  });

  setCookie(c, "google_code_verifier", codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10,
    sameSite: "Lax",
    path: "/",
  });

  const url = await getGoogle().createAuthorizationURL(state, codeVerifier, [
    "openid",
    "email",
  ]);

  return c.redirect(url.toString());
});

// ── Google OAuth callback (always runs on production) ────────────────────────

authRoutes.get("/google/callback", async c => {
  try {
    const code = c.req.query("code");
    const stateParam = c.req.query("state");
    const storedNonce = getCookie(c, "google_oauth_state");
    const codeVerifier = getCookie(c, "google_code_verifier");

    // Decode and verify HMAC-signed state
    const stateData = stateParam ? decodeOAuthState(stateParam) : null;
    if (
      !code ||
      !stateData ||
      !storedNonce ||
      !codeVerifier ||
      stateData.nonce !== storedNonce
    ) {
      logger.warn("Google OAuth callback: invalid state or missing params");
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }

    const callerOrigin = stateData.origin;
    if (!isAllowedOrigin(callerOrigin)) {
      logger.warn("Google OAuth callback: untrusted caller origin", {
        origin: callerOrigin,
      });
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }

    const tokens = await getGoogle().validateAuthorizationCode(
      code,
      codeVerifier,
    );

    let googleUser: any;

    const rawIdToken =
      typeof tokens.idToken === "function" ? tokens.idToken() : tokens.idToken;

    if (typeof rawIdToken === "string" && rawIdToken.includes(".")) {
      try {
        const payload = JSON.parse(
          Buffer.from(rawIdToken.split(".")[1], "base64").toString("utf8"),
        );
        googleUser = {
          sub: payload.sub,
          email: payload.email,
        };
      } catch (err) {
        logger.warn("Failed to parse Google ID token", { error: err });
      }
    }

    if (!googleUser || !googleUser.sub) {
      const response = await fetch(
        "https://openidconnect.googleapis.com/v1/userinfo",
        {
          headers: {
            Authorization: `Bearer ${tokens.accessToken()}`,
          },
        },
      );

      if (!response.ok) {
        logger.error("Failed to fetch Google user info", {
          response: await response.text(),
        });
        return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
      }

      googleUser = await response.json();
    }

    if (!googleUser.sub) {
      logger.error("Google user info did not contain 'sub' identifier", {
        googleUser,
      });
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }

    const { session, isNewUser } = await authService.handleOAuthCallback(
      "google",
      googleUser.sub.toString(),
      googleUser.email,
    );

    // Clear OAuth cookies
    setCookie(c, "google_oauth_state", "", { maxAge: 0, path: "/" });
    setCookie(c, "google_code_verifier", "", { maxAge: 0, path: "/" });

    const productionUrl = getProductionUrl();
    const isCallerProduction = callerOrigin === productionUrl;

    if (isCallerProduction) {
      // Same-origin: set cookie directly and redirect
      const sessionCookie = sessionManager.createSessionCookie(session.id);
      setCookie(
        c,
        sessionCookie.name,
        sessionCookie.value,
        convertCookieAttributes(sessionCookie.attributes),
      );

      const redirectUrl = isNewUser
        ? `${process.env.CLIENT_URL}/?new_user=google`
        : `${process.env.CLIENT_URL}/`;
      return c.redirect(redirectUrl);
    }

    // Cross-origin: redirect to caller's /api/auth/oauth-receive with signed transfer token
    const transferToken = createTransferToken(session.id);
    const receiveUrl = new URL(`${callerOrigin}/api/auth/oauth-receive`);
    receiveUrl.searchParams.set("token", transferToken);
    if (isNewUser) {
      receiveUrl.searchParams.set("new_user", "google");
    }
    logger.info("OAuth proxy: redirecting session to caller origin", {
      callerOrigin,
    });
    return c.redirect(receiveUrl.toString());
  } catch (error: any) {
    logger.error("Google OAuth error", { error });
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
  }
});

// ── GitHub OAuth initiation (proxy-aware) ────────────────────────────────────

authRoutes.get("/github", async c => {
  if (isOAuthDisabled()) {
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_disabled`);
  }

  const productionUrl = getProductionUrl();

  // Non-production: redirect to production's /github with ?origin=<caller>
  if (!isProduction(c)) {
    const callerOrigin = getRequestOrigin(c);
    const target = new URL(`${productionUrl}/api/auth/github`);
    target.searchParams.set("origin", callerOrigin);
    logger.info("OAuth proxy: redirecting to production for GitHub login", {
      callerOrigin,
    });
    return c.redirect(target.toString());
  }

  // Production: read the caller's origin (or default to production)
  const rawOrigin = c.req.query("origin");
  const origin =
    rawOrigin && isAllowedOrigin(rawOrigin) ? rawOrigin : productionUrl;

  if (rawOrigin && !isAllowedOrigin(rawOrigin)) {
    logger.warn("OAuth proxy: rejected untrusted origin", {
      origin: rawOrigin,
    });
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
  }

  const nonce = generateState();
  const state = encodeOAuthState(nonce, origin);

  setCookie(c, "github_oauth_state", nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10,
    sameSite: "Lax",
    path: "/",
  });

  const url = await getGitHub().createAuthorizationURL(state, ["user:email"]);

  return c.redirect(url.toString());
});

// ── GitHub OAuth callback (always runs on production) ────────────────────────

authRoutes.get("/github/callback", async c => {
  try {
    const code = c.req.query("code");
    const stateParam = c.req.query("state");
    const storedNonce = getCookie(c, "github_oauth_state");

    // Decode and verify HMAC-signed state
    const stateData = stateParam ? decodeOAuthState(stateParam) : null;
    if (
      !code ||
      !stateData ||
      !storedNonce ||
      stateData.nonce !== storedNonce
    ) {
      logger.warn("GitHub OAuth callback: invalid state or missing params");
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }

    const callerOrigin = stateData.origin;
    if (!isAllowedOrigin(callerOrigin)) {
      logger.warn("GitHub OAuth callback: untrusted caller origin", {
        origin: callerOrigin,
      });
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }

    const tokens = await getGitHub().validateAuthorizationCode(code);

    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokens.accessToken()}`,
      },
    });

    const githubUser: any = await userResponse.json();

    if (!githubUser.id) {
      logger.error("GitHub user info did not contain 'id'", { githubUser });
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }

    const emailResponse = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${tokens.accessToken()}`,
      },
    });

    const emails = (await emailResponse.json()) as any[];
    const primaryEmail = emails.find(e => e.primary)?.email;

    const { session, isNewUser } = await authService.handleOAuthCallback(
      "github",
      githubUser.id.toString(),
      primaryEmail || githubUser.email,
    );

    // Clear OAuth cookie
    setCookie(c, "github_oauth_state", "", { maxAge: 0, path: "/" });

    const productionUrl = getProductionUrl();
    const isCallerProduction = callerOrigin === productionUrl;

    if (isCallerProduction) {
      const sessionCookie = sessionManager.createSessionCookie(session.id);
      setCookie(
        c,
        sessionCookie.name,
        sessionCookie.value,
        convertCookieAttributes(sessionCookie.attributes),
      );

      const redirectUrl = isNewUser
        ? `${process.env.CLIENT_URL}/?new_user=github`
        : `${process.env.CLIENT_URL}/`;
      return c.redirect(redirectUrl);
    }

    const transferToken = createTransferToken(session.id);
    const receiveUrl = new URL(`${callerOrigin}/api/auth/oauth-receive`);
    receiveUrl.searchParams.set("token", transferToken);
    if (isNewUser) {
      receiveUrl.searchParams.set("new_user", "github");
    }
    logger.info("OAuth proxy: redirecting session to caller origin", {
      callerOrigin,
    });
    return c.redirect(receiveUrl.toString());
  } catch (error: any) {
    logger.error("GitHub OAuth error", { error });
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
  }
});

// ── OAuth receive endpoint (non-production instances) ────────────────────────
// After the production callback completes OAuth, it redirects the user here
// with a signed transfer token. This endpoint verifies the token, sets the
// session cookie locally, and redirects to the frontend.

authRoutes.get("/oauth-receive", async c => {
  const token = c.req.query("token");
  const newUser = c.req.query("new_user");

  if (!token) {
    logger.warn("OAuth receive: missing token");
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
  }

  const sessionId = verifyTransferToken(token);
  if (!sessionId) {
    logger.warn("OAuth receive: invalid or expired transfer token");
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
  }

  // Verify the session actually exists
  const { session, user } = await authService.validateSession(sessionId);
  if (!session || !user) {
    logger.warn("OAuth receive: session not found for transfer token");
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
  }

  const sessionCookie = sessionManager.createSessionCookie(sessionId);
  setCookie(
    c,
    sessionCookie.name,
    sessionCookie.value,
    convertCookieAttributes(sessionCookie.attributes),
  );

  const redirectUrl = newUser
    ? `${process.env.CLIENT_URL}/?new_user=${newUser}`
    : `${process.env.CLIENT_URL}/`;
  return c.redirect(redirectUrl);
});

export default authRoutes;
