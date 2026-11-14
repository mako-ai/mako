import bcrypt from "bcrypt";
import { randomInt, randomUUID } from "crypto";
import { sessionManager, ValidatedSession, ValidatedUser } from "./session";
import {
  User,
  OAuthAccount,
  EmailVerification,
  Session,
} from "../database/schema";
import type { OAuthProvider } from "./oauth-providers";
import { workspaceService } from "../services/workspace.service";
import { emailService } from "../services/email.service";
import {
  validateAndNormalizeEmail,
  normalizeEmail,
} from "../utils/email.utils";
import {
  captureSignupAttribution,
  type SignupContext,
} from "./signup-attribution";
import { loggers } from "../logging";
import { AuthError } from "./auth-errors";

const logger = loggers.auth();

/** `validateAndNormalizeEmail`, with its (user-facing) failure as an AuthError. */
function requireValidEmail(email: string): string {
  try {
    return validateAndNormalizeEmail(email);
  } catch (error) {
    throw new AuthError(
      error instanceof Error ? error.message : "Invalid email format",
      400,
    );
  }
}

/**
 * Send a verification-code email; false (logged, never thrown) on failure.
 *
 * A failed send must not fail the request that created the code: the code is
 * already stored, so the user can ask for another one, whereas surfacing the
 * transport error both leaks internals ("fetch failed") and — for register —
 * reports failure for an account that WAS created.
 */
async function trySendVerificationEmail(
  email: string,
  code: string,
  verifyUrl: string,
): Promise<boolean> {
  try {
    await emailService.sendVerificationEmail(email, code, verifyUrl);
    return true;
  } catch (error) {
    logger.error("Failed to send verification email", { error, email });
    return false;
  }
}

const EMAIL_SEND_FAILED =
  "We couldn't send the email right now. Please try again in a few minutes.";

/**
 * Generate a random ID (replacement for Lucia's generateId)
 */
function generateId(length: number = 15): string {
  const id = randomUUID().replace(/-/g, "");
  return id.substring(0, length);
}

/**
 * Generate a 6-digit verification code using cryptographically secure randomness
 */
function generateVerificationCode(): string {
  return randomInt(100000, 1000000).toString();
}

/**
 * Authentication service with business logic
 */
export class AuthService {
  /**
   * Register a new user with email and password
   * Creates an unverified user and sends verification email
   */
  async register(email: string, password: string, signup?: SignupContext) {
    // Validate input
    if (!password) {
      throw new AuthError("Password is required");
    }

    if (password.length < 8) {
      throw new AuthError("Password must be at least 8 characters long");
    }

    const normalizedEmail = requireValidEmail(email);

    // Check if user already exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      // Check if this is an OAuth-only user (no password set)
      if (!existingUser.hashedPassword) {
        // Check if user has OAuth accounts linked
        const oauthAccounts = await OAuthAccount.find({
          userId: existingUser._id,
        });
        if (oauthAccounts.length > 0) {
          const providers = oauthAccounts.map(a => a.provider).join(", ");
          throw new AuthError(
            `This email is linked to a ${providers} account. Please login with ${providers} and set a password from your account settings.`,
            409,
          );
        }
      }

      // If user exists but is not verified, resend verification email
      // SECURITY: Do NOT update the password - this prevents account takeover attacks
      // where an attacker could overwrite a legitimate user's password before verification
      if (!existingUser.emailVerified && existingUser.hashedPassword) {
        // Delete old verification codes and send new one
        await EmailVerification.deleteMany({
          email: normalizedEmail,
          type: "registration",
        });

        // Generate and send new verification code (password stays unchanged)
        const code = generateVerificationCode();
        await EmailVerification.create({
          email: normalizedEmail,
          code,
          type: "registration",
          expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
        });

        const verifyUrl = `${process.env.CLIENT_URL}/verify-email?email=${encodeURIComponent(normalizedEmail)}&code=${code}`;
        const emailSent = await trySendVerificationEmail(
          normalizedEmail,
          code,
          verifyUrl,
        );

        // Return success but indicate this was a resend, not a password update
        // The user should use their original password to log in after verification
        return { user: existingUser, requiresVerification: true, emailSent };
      }
      throw new AuthError("User with this email already exists", 409);
    }

    // Hash password
    const rounds = parseInt(process.env.BCRYPT_ROUNDS || "10");
    const hashedPassword = await bcrypt.hash(password, rounds);

    // Create unverified user
    const userId = generateId(15);
    const user = await User.create({
      _id: userId,
      email: normalizedEmail,
      hashedPassword,
      emailVerified: false,
    });

    // Persist first-party marketing attribution (best-effort, never throws).
    await captureSignupAttribution({
      userId,
      signupMethod: "email",
      ...signup,
    });

    // Generate verification code
    const code = generateVerificationCode();
    await EmailVerification.create({
      email: normalizedEmail,
      code,
      type: "registration",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    });

    // Send verification email
    const verifyUrl = `${process.env.CLIENT_URL}/verify-email?email=${encodeURIComponent(normalizedEmail)}&code=${code}`;
    const emailSent = await trySendVerificationEmail(
      normalizedEmail,
      code,
      verifyUrl,
    );

    return { user, requiresVerification: true, emailSent };
  }

  /**
   * Verify email with code and complete registration
   */
  async verifyEmail(email: string, code: string) {
    const normalizedEmail = normalizeEmail(email);

    // Find verification record
    const verification = await EmailVerification.findOne({
      email: normalizedEmail,
      code,
      type: "registration",
      expiresAt: { $gt: new Date() },
    });

    if (!verification) {
      throw new AuthError("Invalid or expired verification code");
    }

    // Find user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      throw new AuthError("Invalid or expired verification code");
    }

    // Mark user as verified
    user.emailVerified = true;
    await user.save();

    // Delete verification record
    await EmailVerification.deleteOne({ _id: verification._id });

    // Check for existing workspaces - don't auto-create, let frontend handle onboarding
    const workspaces = await workspaceService.getWorkspacesForUser(user._id);

    // Only set activeWorkspaceId if user has exactly one workspace (auto-select)
    // For 0 or 2+ workspaces, let frontend handle selection/creation
    const activeWorkspaceId =
      workspaces.length === 1
        ? workspaces[0].workspace._id.toString()
        : undefined;

    // Create session (may be without activeWorkspaceId for onboarding/selection)
    const session = await sessionManager.createSession(user._id, {
      activeWorkspaceId,
    });

    return { user, session, hasWorkspaces: workspaces.length > 0 };
  }

  /**
   * Resend verification email
   */
  async resendVerification(email: string) {
    const normalizedEmail = normalizeEmail(email);

    // Find user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      throw new AuthError("User not found", 404);
    }

    if (user.emailVerified) {
      throw new AuthError("Email is already verified", 409);
    }

    // Delete old verification codes
    await EmailVerification.deleteMany({
      email: normalizedEmail,
      type: "registration",
    });

    // Generate new verification code
    const code = generateVerificationCode();
    await EmailVerification.create({
      email: normalizedEmail,
      code,
      type: "registration",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    });

    // Send verification email
    const verifyUrl = `${process.env.CLIENT_URL}/verify-email?email=${encodeURIComponent(normalizedEmail)}&code=${code}`;
    if (!(await trySendVerificationEmail(normalizedEmail, code, verifyUrl))) {
      throw new AuthError(EMAIL_SEND_FAILED, 503);
    }
  }

  /**
   * Login user with email and password
   */
  async login(email: string, password: string) {
    // Validate input
    if (!password) {
      throw new AuthError("Password is required");
    }

    // Find user
    const normalizedEmail = requireValidEmail(email);
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      throw new AuthError("Invalid email or password", 401);
    }

    // Check if user has password (not OAuth only)
    if (!user.hashedPassword) {
      throw new AuthError("Please login with your OAuth provider", 401);
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.hashedPassword);
    if (!validPassword) {
      throw new AuthError("Invalid email or password", 401);
    }

    // Check if email is verified
    if (!user.emailVerified) {
      // Send a new verification code. A failed send must not turn into an
      // opaque error here: the user still needs to be told to verify.
      const sent = await this.resendVerification(email).then(
        () => true,
        (error: unknown) => {
          if (!(error instanceof AuthError)) {
            logger.error("Resend on unverified login failed", { error });
          }
          return false;
        },
      );
      throw new AuthError(
        sent
          ? "Please verify your email before logging in. A new verification code has been sent."
          : "Please verify your email before logging in. We couldn't send a new code just now; request one from the verification page.",
        403,
      );
    }

    // Get user's workspaces
    // Only set activeWorkspaceId if user has exactly one workspace (auto-select)
    // For 0 or 2+ workspaces, let frontend handle selection/creation
    const workspaces = await workspaceService.getWorkspacesForUser(user._id);
    const activeWorkspaceId =
      workspaces.length === 1
        ? workspaces[0].workspace._id.toString()
        : undefined;

    // Create session
    const session = await sessionManager.createSession(user._id, {
      activeWorkspaceId,
    });

    return { user, session };
  }

  /**
   * Local-development login shortcut: mint a session for an existing user
   * WITHOUT verifying a password. Only ever reachable through the guards in
   * auth/dev-login.ts (non-production + loopback + configured secret); this
   * method itself performs no authentication and must never be called from a
   * path that has not already checked them.
   *
   * Deliberately skips the OAuth-only and email-verified checks too: the whole
   * point is to get into a local workspace as whichever account you actually
   * use, which is usually a Google signup with no password at all.
   */
  async devLogin(email: string) {
    const normalizedEmail = requireValidEmail(email);
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      // Same opaque message as the real login path.
      throw new AuthError("Invalid email or password", 401);
    }

    const workspaces = await workspaceService.getWorkspacesForUser(user._id);
    const activeWorkspaceId =
      workspaces.length === 1
        ? workspaces[0].workspace._id.toString()
        : undefined;

    const session = await sessionManager.createSession(user._id, {
      activeWorkspaceId,
    });

    logger.warn("Dev login used (password bypass)", {
      email: normalizedEmail,
    });

    return { user, session };
  }

  /**
   * Create a fresh session for an already-authenticated user id.
   * Used by the desktop deep-link handoff (/api/auth/desktop/complete),
   * where identity was established by redeeming a one-time desktop auth code.
   */
  async createSessionForUser(userId: string) {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error("User account not found");
    }

    // Only set activeWorkspaceId if user has exactly one workspace (auto-select)
    // For 0 or 2+ workspaces, let frontend handle selection/creation
    const workspaces = await workspaceService.getWorkspacesForUser(user._id);
    const activeWorkspaceId =
      workspaces.length === 1
        ? workspaces[0].workspace._id.toString()
        : undefined;

    const session = await sessionManager.createSession(user._id, {
      activeWorkspaceId,
    });

    return { user, session };
  }

  /**
   * Handle OAuth callback and create/login user
   */
  async handleOAuthCallback(
    provider: OAuthProvider,
    providerUserId: string | undefined,
    email?: string,
    signup?: SignupContext,
  ) {
    // Provider user id is essential to uniquely identify an OAuth account. If it's missing we
    // treat this as a fatal OAuth error instead of silently creating duplicate placeholder
    // accounts that later collide on the unique email index.
    if (!providerUserId) {
      throw new Error(
        "OAuth callback did not include a valid provider user id",
      );
    }

    // Normalise provider-specific placeholder email when the real e-mail isn't available
    // (e.g. when a GitHub account has no public e-mail).  The placeholder includes the
    // provider user id so that it stays unique across different accounts.
    const fallbackEmail = `${provider}_${providerUserId}@oauth.local`;

    // Check if OAuth account exists
    const existingAccount = await OAuthAccount.findOne({
      provider,
      providerUserId,
    });

    if (existingAccount) {
      // User exists, create session
      const user = await User.findById(existingAccount.userId);
      if (!user) {
        throw new Error("User account not found");
      }

      // Get user's workspaces
      // Only set activeWorkspaceId if user has exactly one workspace (auto-select)
      // For 0 or 2+ workspaces, let frontend handle selection/creation
      const workspaces = await workspaceService.getWorkspacesForUser(user._id);
      const activeWorkspaceId =
        workspaces.length === 1
          ? workspaces[0].workspace._id.toString()
          : undefined;

      const session = await sessionManager.createSession(user._id, {
        activeWorkspaceId,
      });
      return { user, session, isNewUser: false };
    }

    // New OAuth account
    let user;
    let isNewUser = true;

    if (email) {
      // Check if user with this email exists
      const normalizedOAuthEmail = normalizeEmail(email);
      user = await User.findOne({ email: normalizedOAuthEmail });

      if (user) {
        isNewUser = false;
      } else {
        // Create new user - OAuth users are verified by default
        const userId = generateId(15);
        user = await User.create({
          _id: userId,
          email: normalizedOAuthEmail,
          emailVerified: true, // OAuth users are verified
        });
      }
    } else {
      // Create user with placeholder e-mail when none was supplied.
      const userId = generateId(15);
      user = await User.create({
        _id: userId,
        email: fallbackEmail,
        emailVerified: true, // OAuth users are verified
      });
    }

    // If user exists but not verified, mark as verified (OAuth verifies email)
    // SECURITY: Also clear any existing password to prevent account takeover attacks.
    // Attack scenario: Attacker pre-registers with victim's email and sets a password.
    // When victim later signs up via OAuth, without clearing the password, the attacker
    // could still log in using the email/password they set.
    if (!user.emailVerified) {
      user.emailVerified = true;
      user.hashedPassword = undefined;
      await user.save();

      // Clean up any pending verification records since OAuth supersedes email verification
      await EmailVerification.deleteMany({
        email: user.email,
        type: "registration",
      });
    }

    // Create OAuth account link
    await OAuthAccount.create({
      userId: user._id,
      provider,
      providerUserId,
      email: email ?? fallbackEmail,
    });

    // Persist first-party marketing attribution for genuinely new accounts
    // (best-effort, never throws).
    if (isNewUser) {
      await captureSignupAttribution({
        userId: user._id,
        signupMethod: provider,
        ...signup,
      });
    }

    // Check for existing workspaces - don't auto-create, let frontend handle onboarding
    const workspaces = await workspaceService.getWorkspacesForUser(user._id);

    // Only set activeWorkspaceId if user has exactly one workspace (auto-select)
    // For 0 or 2+ workspaces, let frontend handle selection/creation
    const activeWorkspaceId =
      workspaces.length === 1
        ? workspaces[0].workspace._id.toString()
        : undefined;

    // Create session (may be without activeWorkspaceId for onboarding/selection)
    const session = await sessionManager.createSession(user._id, {
      activeWorkspaceId,
    });

    return { user, session, isNewUser };
  }

  /**
   * Validate session and get user
   */
  async validateSession(sessionId: string): Promise<{
    session: ValidatedSession | null;
    user: ValidatedUser | null;
  }> {
    const result = await sessionManager.validateSession(sessionId);

    if (!result.session || !result.user) {
      return { session: null, user: null };
    }

    // Get full user data
    const user = await User.findById(result.user.id);
    if (!user) {
      return { session: null, user: null };
    }

    return {
      session: result.session,
      user: {
        id: user._id,
        email: user.email,
      },
    };
  }

  /**
   * Logout user by invalidating session
   */
  async logout(sessionId: string) {
    await sessionManager.invalidateSession(sessionId);
  }

  /**
   * Get OAuth accounts linked to a user
   */
  async getLinkedAccounts(userId: string) {
    const accounts = await OAuthAccount.find({ userId });
    return accounts.map(account => ({
      provider: account.provider,
      email: account.email,
      linkedAt: account.createdAt,
    }));
  }

  /**
   * Link password to existing OAuth user (after email verification)
   */
  async linkPassword(
    email: string,
    password: string,
    verificationCode: string,
  ) {
    const normalizedEmail = normalizeEmail(email);

    // Verify the code
    const verification = await EmailVerification.findOne({
      email: normalizedEmail,
      code: verificationCode,
      type: "link_password",
      expiresAt: { $gt: new Date() },
    });

    if (!verification) {
      throw new AuthError("Invalid or expired verification code");
    }

    // Find user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      throw new AuthError("User not found", 404);
    }

    if (user.hashedPassword) {
      throw new AuthError("Password is already set for this account", 409);
    }

    // Validate password
    if (!password || password.length < 8) {
      throw new AuthError("Password must be at least 8 characters long");
    }

    // Hash and save password
    const rounds = parseInt(process.env.BCRYPT_ROUNDS || "10");
    const hashedPassword = await bcrypt.hash(password, rounds);
    user.hashedPassword = hashedPassword;
    await user.save();

    // Delete verification record
    await EmailVerification.deleteOne({ _id: verification._id });

    return { user };
  }

  /**
   * Send verification code to link password to OAuth account
   */
  async sendLinkPasswordVerification(email: string) {
    const normalizedEmail = normalizeEmail(email);

    // Find user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      throw new AuthError("User not found", 404);
    }

    if (user.hashedPassword) {
      throw new AuthError("Password is already set for this account", 409);
    }

    // Delete old verification codes
    await EmailVerification.deleteMany({
      email: normalizedEmail,
      type: "link_password",
    });

    // Generate new verification code
    const code = generateVerificationCode();
    await EmailVerification.create({
      email: normalizedEmail,
      code,
      type: "link_password",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    });

    // Send verification email
    const verifyUrl = `${process.env.CLIENT_URL}/set-password?email=${encodeURIComponent(normalizedEmail)}&code=${code}`;
    if (!(await trySendVerificationEmail(normalizedEmail, code, verifyUrl))) {
      throw new AuthError(EMAIL_SEND_FAILED, 503);
    }
  }

  /**
   * Request password reset - sends email with reset link
   * For security, always returns success even if email doesn't exist
   */
  async requestPasswordReset(email: string) {
    const normalizedEmail = normalizeEmail(email);

    // Find user - but don't reveal if they exist or not
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      // Return silently for security - don't reveal if email exists
      logger.debug("Password reset requested for non-existent email", {
        email: normalizedEmail,
      });
      return;
    }

    // Check if user has a password (not OAuth-only)
    if (!user.hashedPassword) {
      // User is OAuth-only - silently ignore for security
      logger.debug("Password reset requested for OAuth-only account", {
        email: normalizedEmail,
      });
      return;
    }

    // Delete old password reset codes for this email
    await EmailVerification.deleteMany({
      email: normalizedEmail,
      type: "password_reset",
    });

    // Generate new reset code
    const code = generateVerificationCode();
    await EmailVerification.create({
      email: normalizedEmail,
      code,
      type: "password_reset",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    });

    // Send password reset email
    const resetUrl = `${process.env.CLIENT_URL}/reset-password?email=${encodeURIComponent(normalizedEmail)}&code=${code}`;
    await emailService.sendPasswordResetEmail(normalizedEmail, resetUrl);
  }

  /**
   * Reset password with verification code
   */
  async resetPassword(email: string, code: string, newPassword: string) {
    const normalizedEmail = normalizeEmail(email);

    // Validate password
    if (!newPassword) {
      throw new AuthError("Password is required");
    }

    if (newPassword.length < 8) {
      throw new AuthError("Password must be at least 8 characters long");
    }

    // Find verification record
    const verification = await EmailVerification.findOne({
      email: normalizedEmail,
      code,
      type: "password_reset",
      expiresAt: { $gt: new Date() },
    });

    if (!verification) {
      throw new AuthError("Invalid or expired reset code");
    }

    // Find user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      throw new AuthError("Invalid or expired reset code");
    }

    // Hash and save new password
    const rounds = parseInt(process.env.BCRYPT_ROUNDS || "10");
    const hashedPassword = await bcrypt.hash(newPassword, rounds);
    user.hashedPassword = hashedPassword;
    await user.save();

    // Delete verification record
    await EmailVerification.deleteOne({ _id: verification._id });

    // Invalidate all existing sessions for this user (security measure)
    await Session.deleteMany({ userId: user._id });

    return { success: true };
  }

  /**
   * Update user's onboarding qualification data
   */
  async updateOnboardingData(
    userId: string,
    data: {
      role?: string;
      companySize?: "hobby" | "startup" | "growth" | "enterprise";
      primaryDatabase?: string;
      dataWarehouse?: string;
    },
  ) {
    const user = await User.findById(userId);
    if (!user) {
      throw new AuthError("User not found", 404);
    }

    // Update onboarding data
    user.onboarding = {
      ...user.onboarding,
      ...data,
      completedAt: new Date(),
    };

    await user.save();
    return { user };
  }
}
