import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import { generateState, generateCodeVerifier } from "arctic";
import { sessionManager } from "./session";
import { getGoogle, getGitHub, isOAuthDisabled } from "./arctic";
import { AuthService } from "./auth.service";
import { authMiddleware, rateLimitMiddleware } from "./auth.middleware";

// Type definitions for extended Hono context
type Variables = {
  user: any;
  session: any;
};

const authService = new AuthService();
export const authRoutes = new Hono<{ Variables: Variables }>();

// Helper to convert session cookie attributes to Hono format
const convertCookieAttributes = (attributes: any) => ({
  ...attributes,
  sameSite: attributes.sameSite
    ? ((attributes.sameSite.charAt(0).toUpperCase() +
        attributes.sameSite.slice(1)) as "Strict" | "Lax" | "None")
    : undefined,
});

// Apply rate limiting to auth endpoints
const authRateLimiter = rateLimitMiddleware(
  parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000"), // 15 minutes
  parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "5"),
);

/**
 * Get auth configuration (OAuth enabled/disabled status)
 * Used by frontend to conditionally show OAuth buttons
 */
authRoutes.get("/config", async c => {
  return c.json({
    oauthEnabled: !isOAuthDisabled(),
    providers: isOAuthDisabled() ? [] : ["google", "github"],
  });
});

/**
 * Register new user
 * Creates an unverified user and sends verification email
 */
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

/**
 * Verify email with code
 */
authRoutes.post("/verify-email", authRateLimiter, async c => {
  try {
    const { email, code } = await c.req.json();

    if (!email || !code) {
      return c.json({ error: "Email and verification code are required" }, 400);
    }

    const { user, session } = await authService.verifyEmail(email, code);

    // Set session cookie
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

/**
 * Resend verification email
 */
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

/**
 * Login user
 */
authRoutes.post("/login", authRateLimiter, async c => {
  try {
    const { email, password } = await c.req.json();

    const { user, session } = await authService.login(email, password);

    // Set session cookie
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

/**
 * Logout user
 */
authRoutes.post("/logout", authMiddleware, async c => {
  try {
    const session = c.get("session");

    await authService.logout(session.id);

    // Clear session cookie
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

/**
 * Get current user
 */
authRoutes.get("/me", authMiddleware, async c => {
  try {
    const user = c.get("user");

    // Get linked accounts
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

/**
 * Refresh session
 */
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

    // Refresh session if needed
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

/**
 * Request to set password for OAuth-only account
 */
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

/**
 * Set password for OAuth-only account (with verification code)
 */
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

/**
 * Request password reset
 */
authRoutes.post("/forgot-password", authRateLimiter, async c => {
  try {
    const { email } = await c.req.json();

    if (!email) {
      return c.json({ error: "Email is required" }, 400);
    }

    await authService.requestPasswordReset(email);

    // Always return success for security (don't reveal if email exists)
    return c.json({
      message:
        "If an account exists with this email, you will receive a password reset link.",
    });
  } catch (error: any) {
    // Log but don't expose internal errors
    console.error("Password reset request error:", error);
    return c.json({
      message:
        "If an account exists with this email, you will receive a password reset link.",
    });
  }
});

/**
 * Reset password with code
 */
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

/**
 * Google OAuth initiation
 */
authRoutes.get("/google", async c => {
  // Check if OAuth is disabled (PR preview environments)
  if (isOAuthDisabled()) {
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_disabled`);
  }

  const state = generateState();
  const codeVerifier = generateCodeVerifier();

  // Store state and code verifier in cookies
  setCookie(c, "google_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10, // 10 minutes
    sameSite: "Lax",
  });

  setCookie(c, "google_code_verifier", codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10, // 10 minutes
    sameSite: "Lax",
  });

  const url = await getGoogle().createAuthorizationURL(state, codeVerifier, [
    "openid",
    "email",
  ]);

  return c.redirect(url.toString());
});

/**
 * Google OAuth callback
 */
authRoutes.get("/google/callback", async c => {
  try {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const storedState = getCookie(c, "google_oauth_state");
    const codeVerifier = getCookie(c, "google_code_verifier");

    if (
      !code ||
      !state ||
      !storedState ||
      !codeVerifier ||
      state !== storedState
    ) {
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }

    const tokens = await getGoogle().validateAuthorizationCode(
      code,
      codeVerifier,
    );

    // Attempt to extract user info from ID token first to reduce external calls
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
        console.error("Failed to parse Google ID token", err);
      }
    }

    // Fallback to userinfo endpoint if needed
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
        console.error(
          "Failed to fetch Google user info",
          await response.text(),
        );
        return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
      }

      googleUser = await response.json();
    }

    if (!googleUser.sub) {
      console.error(
        "Google user info did not contain 'sub' identifier after all attempts",
        googleUser,
      );
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }

    const { session, isNewUser } = await authService.handleOAuthCallback(
      "google",
      googleUser.sub.toString(),
      googleUser.email,
    );

    // Set session cookie
    const sessionCookie = sessionManager.createSessionCookie(session.id);
    setCookie(
      c,
      sessionCookie.name,
      sessionCookie.value,
      convertCookieAttributes(sessionCookie.attributes),
    );

    // Clear OAuth cookies
    setCookie(c, "google_oauth_state", "", { maxAge: 0 });
    setCookie(c, "google_code_verifier", "", { maxAge: 0 });

    // Include new_user flag for analytics tracking on client
    const redirectUrl = isNewUser
      ? `${process.env.CLIENT_URL}/?new_user=google`
      : `${process.env.CLIENT_URL}/`;
    return c.redirect(redirectUrl);
  } catch (error: any) {
    console.error("Google OAuth error:", error);
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
  }
});

/**
 * GitHub OAuth initiation
 */
authRoutes.get("/github", async c => {
  // Check if OAuth is disabled (PR preview environments)
  if (isOAuthDisabled()) {
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_disabled`);
  }

  const state = generateState();

  setCookie(c, "github_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10, // 10 minutes
    sameSite: "Lax",
  });

  const url = await getGitHub().createAuthorizationURL(state, ["user:email"]);

  return c.redirect(url.toString());
});

/**
 * GitHub OAuth callback
 */
authRoutes.get("/github/callback", async c => {
  try {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const storedState = getCookie(c, "github_oauth_state");

    if (!code || !state || !storedState || state !== storedState) {
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }

    const tokens = await getGitHub().validateAuthorizationCode(code);

    // Get user info from GitHub
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokens.accessToken()}`,
      },
    });

    const githubUser: any = await userResponse.json();

    if (!githubUser.id) {
      console.error("GitHub user info did not contain 'id'", githubUser);
      return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
    }

    // Get primary email
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

    // Set session cookie
    const sessionCookie = sessionManager.createSessionCookie(session.id);
    setCookie(
      c,
      sessionCookie.name,
      sessionCookie.value,
      convertCookieAttributes(sessionCookie.attributes),
    );

    // Clear OAuth cookie
    setCookie(c, "github_oauth_state", "", { maxAge: 0 });

    // Include new_user flag for analytics tracking on client
    const redirectUrl = isNewUser
      ? `${process.env.CLIENT_URL}/?new_user=github`
      : `${process.env.CLIENT_URL}/`;
    return c.redirect(redirectUrl);
  } catch (error: any) {
    console.error("GitHub OAuth error:", error);
    return c.redirect(`${process.env.CLIENT_URL}/login?error=oauth_error`);
  }
});

export default authRoutes;
