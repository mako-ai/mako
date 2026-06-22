import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { setCookie, getCookie } from "hono/cookie";
import { generateState, generateCodeVerifier } from "arctic";
import { sessionManager } from "./session";
import { getGoogle, getGitHub, isOAuthDisabled } from "./arctic";
import { AuthService } from "./auth.service";
import { authMiddleware, rateLimitMiddleware } from "./auth.middleware";
import { isSuperAdminEmail } from "./super-admin";
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
import {
  createDesktopAuthCode,
  redeemDesktopAuthCode,
  isValidChallenge,
  DESKTOP_AUTH_CODE_TTL_MS,
} from "./desktop-auth";
import { loggers } from "../logging";
import { OPEN_RESPONSES } from "../openapi/core";

const logger = loggers.auth();

type Variables = {
  user: any;
  session: any;
};

const authService = new AuthService();
export const authRoutes = new OpenAPIHono<{ Variables: Variables }>({
  defaultHook: (result, c) => {
    if (!result.success) {
      const message =
        result.error.issues[0]?.message ?? "Invalid request payload";
      return c.json({ success: false, error: message }, 400);
    }
    return undefined;
  },
});

// Responses for auth endpoints: open JSON bodies + redirects (OAuth flows).
const AUTH_RESP = { ...OPEN_RESPONSES, 302: { description: "Redirect" } };
const JsonBody = {
  required: false,
  content: {
    "application/json": { schema: z.record(z.string(), z.any()) },
  },
};

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

authRoutes.openapi(
  createRoute({
    method: "get",
    path: "/config",
    tags: ["Authentication"],
    summary: "Get auth configuration",
    security: [],
    responses: { ...AUTH_RESP },
  }),
  async c => {
    return c.json({
      oauthEnabled: !isOAuthDisabled(),
      providers: isOAuthDisabled() ? [] : ["google", "github"],
    });
  },
);

// ── Email/password routes (unchanged) ────────────────────────────────────────

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/register",
    tags: ["Authentication"],
    summary: "Register a new account",
    security: [],
    middleware: [authRateLimiter] as const,
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              email: z.string().email(),
              password: z.string().min(8),
            }),
          },
        },
      },
    },
    responses: { ...AUTH_RESP },
  }),
  async c => {
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
  },
);

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/verify-email",
    tags: ["Authentication"],
    summary: "Verify email with a code",
    security: [],
    middleware: [authRateLimiter] as const,
    request: { body: JsonBody },
    responses: { ...AUTH_RESP },
  }),
  async c => {
    try {
      const { email, code } = await c.req.json();

      if (!email || !code) {
        return c.json(
          { error: "Email and verification code are required" },
          400,
        );
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
  },
);

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/resend-verification",
    tags: ["Authentication"],
    summary: "Resend the verification email",
    security: [],
    middleware: [authRateLimiter] as const,
    request: { body: JsonBody },
    responses: { ...AUTH_RESP },
  }),
  async c => {
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
  },
);

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/login",
    tags: ["Authentication"],
    summary: "Log in with email and password",
    security: [],
    middleware: [authRateLimiter] as const,
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              email: z.string().email(),
              password: z.string(),
            }),
          },
        },
      },
    },
    responses: { ...AUTH_RESP },
  }),
  async c => {
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
  },
);

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/logout",
    tags: ["Authentication"],
    summary: "Log out",
    security: [{ cookieAuth: [] }],
    middleware: [authMiddleware] as const,
    responses: { ...AUTH_RESP },
  }),
  async c => {
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
  },
);

authRoutes.openapi(
  createRoute({
    method: "get",
    path: "/me",
    tags: ["Authentication"],
    summary: "Get the current user",
    security: [{ cookieAuth: [] }],
    middleware: [authMiddleware] as const,
    responses: { ...AUTH_RESP },
  }),
  async c => {
    try {
      const user = c.get("user");

      const linkedAccounts = await authService.getLinkedAccounts(user.id);

      return c.json({
        user: {
          id: user.id,
          email: user.email,
          linkedAccounts,
          isSuperAdmin: isSuperAdminEmail(user.email),
        },
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  },
);

authRoutes.openapi(
  createRoute({
    method: "put",
    path: "/onboarding",
    tags: ["Authentication"],
    summary: "Save onboarding data",
    security: [{ cookieAuth: [] }],
    middleware: [authMiddleware] as const,
    request: { body: JsonBody },
    responses: { ...AUTH_RESP },
  }),
  async c => {
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
  },
);

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/refresh",
    tags: ["Authentication"],
    summary: "Refresh the session",
    security: [{ cookieAuth: [] }],
    responses: { ...AUTH_RESP },
  }),
  async c => {
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
  },
);

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/request-set-password",
    tags: ["Authentication"],
    summary: "Request a set-password code",
    security: [{ cookieAuth: [] }],
    middleware: [authMiddleware] as const,
    responses: { ...AUTH_RESP },
  }),
  async c => {
    try {
      const user = c.get("user");

      await authService.sendLinkPasswordVerification(user.email);

      return c.json({
        message: "Verification code sent to your email.",
      });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  },
);

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/set-password",
    tags: ["Authentication"],
    summary: "Set a password (link credentials)",
    security: [{ cookieAuth: [] }],
    middleware: [authMiddleware] as const,
    request: { body: JsonBody },
    responses: { ...AUTH_RESP },
  }),
  async c => {
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
  },
);

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/forgot-password",
    tags: ["Authentication"],
    summary: "Request a password reset",
    security: [],
    middleware: [authRateLimiter] as const,
    request: { body: JsonBody },
    responses: { ...AUTH_RESP },
  }),
  async c => {
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
  },
);

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/reset-password",
    tags: ["Authentication"],
    summary: "Reset a password with a code",
    security: [],
    middleware: [authRateLimiter] as const,
    request: { body: JsonBody },
    responses: { ...AUTH_RESP },
  }),
  async c => {
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
  },
);

// ── Google OAuth initiation (proxy-aware) ────────────────────────────────────

authRoutes.openapi(
  createRoute({
    method: "get",
    path: "/google",
    tags: ["Authentication"],
    summary: "Begin Google OAuth",
    security: [],
    request: { query: z.object({ origin: z.string().optional() }) },
    responses: { ...AUTH_RESP },
  }),
  async c => {
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
    if (rawOrigin && !isAllowedOrigin(rawOrigin)) {
      logger.warn("OAuth proxy: rejected untrusted origin", {
        origin: rawOrigin,
      });
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }
    const origin = rawOrigin || productionUrl;

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
  },
);

// ── Google OAuth callback (always runs on production) ────────────────────────

authRoutes.openapi(
  createRoute({
    method: "get",
    path: "/google/callback",
    tags: ["Authentication"],
    summary: "Google OAuth callback",
    security: [],
    request: {
      query: z.object({
        code: z.string().optional(),
        state: z.string().optional(),
      }),
    },
    responses: { ...AUTH_RESP },
  }),
  async c => {
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
        typeof tokens.idToken === "function"
          ? tokens.idToken()
          : tokens.idToken;

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
          return c.redirect(
            `${process.env.CLIENT_URL}/login?error=oauth_error`,
          );
        }

        googleUser = await response.json();
      }

      if (!googleUser.sub) {
        logger.error("Google user info did not contain 'sub' identifier", {
          googleUser,
        });
        return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
      }

      // Clear OAuth cookies
      setCookie(c, "google_oauth_state", "", { maxAge: 0, path: "/" });
      setCookie(c, "google_code_verifier", "", { maxAge: 0, path: "/" });

      const productionUrl = getProductionUrl();
      const isCallerProduction =
        productionUrl &&
        new URL(callerOrigin).origin === new URL(productionUrl).origin;

      if (isCallerProduction) {
        const { session, isNewUser } = await authService.handleOAuthCallback(
          "google",
          googleUser.sub.toString(),
          googleUser.email,
        );

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

      // Cross-origin: send OAuth identity so the receiver can create its own local session
      const transferToken = createTransferToken({
        provider: "google",
        providerUserId: googleUser.sub.toString(),
        email: googleUser.email,
      });
      const receiveUrl = new URL(`${callerOrigin}/api/auth/oauth-receive`);
      receiveUrl.searchParams.set("token", transferToken);
      logger.info("OAuth proxy: redirecting session to caller origin", {
        callerOrigin,
      });
      return c.redirect(receiveUrl.toString());
    } catch (error: any) {
      logger.error("Google OAuth error", { error });
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }
  },
);

// ── GitHub OAuth initiation (proxy-aware) ────────────────────────────────────

authRoutes.openapi(
  createRoute({
    method: "get",
    path: "/github",
    tags: ["Authentication"],
    summary: "Begin GitHub OAuth",
    security: [],
    request: { query: z.object({ origin: z.string().optional() }) },
    responses: { ...AUTH_RESP },
  }),
  async c => {
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
    if (rawOrigin && !isAllowedOrigin(rawOrigin)) {
      logger.warn("OAuth proxy: rejected untrusted origin", {
        origin: rawOrigin,
      });
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }
    const origin = rawOrigin || productionUrl;

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
  },
);

// ── GitHub OAuth callback (always runs on production) ────────────────────────

authRoutes.openapi(
  createRoute({
    method: "get",
    path: "/github/callback",
    tags: ["Authentication"],
    summary: "GitHub OAuth callback",
    security: [],
    request: {
      query: z.object({
        code: z.string().optional(),
        state: z.string().optional(),
      }),
    },
    responses: { ...AUTH_RESP },
  }),
  async c => {
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

      // Clear OAuth cookie
      setCookie(c, "github_oauth_state", "", { maxAge: 0, path: "/" });

      const productionUrl = getProductionUrl();
      const isCallerProduction =
        productionUrl &&
        new URL(callerOrigin).origin === new URL(productionUrl).origin;

      if (isCallerProduction) {
        const { session, isNewUser } = await authService.handleOAuthCallback(
          "github",
          githubUser.id.toString(),
          primaryEmail || githubUser.email,
        );

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

      const transferToken = createTransferToken({
        provider: "github",
        providerUserId: githubUser.id.toString(),
        email: primaryEmail || githubUser.email,
      });
      const receiveUrl = new URL(`${callerOrigin}/api/auth/oauth-receive`);
      receiveUrl.searchParams.set("token", transferToken);
      logger.info("OAuth proxy: redirecting session to caller origin", {
        callerOrigin,
      });
      return c.redirect(receiveUrl.toString());
    } catch (error: any) {
      logger.error("GitHub OAuth error", { error });
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }
  },
);

// ── Desktop app authentication (browser → desktop deep-link handoff) ─────────
// The desktop app opens the system browser at /desktop-auth?challenge=<S256>.
// Once the user is signed in there, the page mints a one-time code bound to
// the challenge (POST /desktop/code, session-cookie authenticated) and fires
// a mako://auth?code=... deep link. The desktop app then loads
// GET /desktop/complete?code&verifier inside its window, which redeems the
// code and sets the session cookie for the Electron session.

const desktopCodeRateLimiter = rateLimitMiddleware(60_000, 10);

authRoutes.openapi(
  createRoute({
    method: "post",
    path: "/desktop/code",
    tags: ["Authentication"],
    summary: "Mint a desktop auth code",
    security: [{ cookieAuth: [] }],
    middleware: [authMiddleware, desktopCodeRateLimiter] as const,
    request: { body: JsonBody },
    responses: { ...AUTH_RESP },
  }),
  async c => {
    try {
      const user = c.get("user");
      const body = await c.req.json().catch(() => ({}));
      const challenge = body?.challenge;

      if (!isValidChallenge(challenge)) {
        return c.json(
          { success: false, error: "Missing or malformed challenge" },
          400,
        );
      }

      const code = await createDesktopAuthCode(user.id, challenge);

      return c.json({
        code,
        expiresIn: Math.floor(DESKTOP_AUTH_CODE_TTL_MS / 1000),
      });
    } catch (error: any) {
      logger.error("Desktop auth code creation failed", { error });
      return c.json(
        { success: false, error: "Failed to create desktop auth code" },
        500,
      );
    }
  },
);

// Public by design: identity is proven by the one-time code + PKCE verifier.
// This URL is only ever loaded inside the Mako Desktop window so the session
// cookie lands in the desktop app's browser session.
authRoutes.openapi(
  createRoute({
    method: "get",
    path: "/desktop/complete",
    tags: ["Authentication"],
    summary: "Complete desktop auth handoff",
    security: [],
    request: {
      query: z.object({
        code: z.string().optional(),
        verifier: z.string().optional(),
      }),
    },
    responses: { ...AUTH_RESP },
  }),
  async c => {
    try {
      const code = c.req.query("code");
      const verifier = c.req.query("verifier");

      const userId = await redeemDesktopAuthCode(code, verifier);
      if (!userId) {
        return c.redirect(`${process.env.CLIENT_URL}/login?error=desktop_auth`);
      }

      const { session } = await authService.createSessionForUser(userId);

      const sessionCookie = sessionManager.createSessionCookie(session.id);
      setCookie(
        c,
        sessionCookie.name,
        sessionCookie.value,
        convertCookieAttributes(sessionCookie.attributes),
      );

      logger.info("Desktop auth handoff completed", { userId });
      return c.redirect(`${process.env.CLIENT_URL}/`);
    } catch (error: any) {
      logger.error("Desktop auth completion error", { error });
      return c.redirect(`${process.env.CLIENT_URL}/login?error=desktop_auth`);
    }
  },
);

// ── OAuth receive endpoint (non-production instances) ────────────────────────
// After the production callback completes OAuth, it redirects the user here
// with a signed transfer token. This endpoint verifies the token, sets the
// session cookie locally, and redirects to the frontend.

authRoutes.openapi(
  createRoute({
    method: "get",
    path: "/oauth-receive",
    tags: ["Authentication"],
    summary: "Receive a cross-origin OAuth session",
    security: [],
    request: { query: z.object({ token: z.string().optional() }) },
    responses: { ...AUTH_RESP },
  }),
  async c => {
    try {
      const token = c.req.query("token");

      if (!token) {
        logger.warn("OAuth receive: missing token");
        return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
      }

      const transferData = verifyTransferToken(token);
      if (!transferData) {
        logger.warn("OAuth receive: invalid or expired transfer token");
        return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
      }

      const { session, isNewUser } = await authService.handleOAuthCallback(
        transferData.provider as "google" | "github",
        transferData.providerUserId,
        transferData.email,
      );

      const sessionCookie = sessionManager.createSessionCookie(session.id);
      setCookie(
        c,
        sessionCookie.name,
        sessionCookie.value,
        convertCookieAttributes(sessionCookie.attributes),
      );

      const redirectUrl = isNewUser
        ? `${process.env.CLIENT_URL}/?new_user=${transferData.provider}`
        : `${process.env.CLIENT_URL}/`;
      return c.redirect(redirectUrl);
    } catch (error: any) {
      logger.error("OAuth receive error", { error });
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }
  },
);

export default authRoutes;
