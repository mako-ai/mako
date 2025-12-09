import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { sessionManager, ValidatedSession, ValidatedUser } from "./session";
import { User, OAuthAccount, EmailVerification } from "../database/schema";
import type { OAuthProvider } from "./arctic";
import { workspaceService } from "../services/workspace.service";
import { emailService } from "../services/email.service";
import {
  validateAndNormalizeEmail,
  normalizeEmail,
} from "../utils/email.utils";

/**
 * Generate a random ID (replacement for Lucia's generateId)
 */
function generateId(length: number = 15): string {
  const id = uuidv4().replace(/-/g, "");
  return id.substring(0, length);
}

/**
 * Generate a 6-digit verification code
 */
function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Authentication service with business logic
 */
export class AuthService {
  /**
   * Register a new user with email and password
   * Creates an unverified user and sends verification email
   */
  async register(email: string, password: string) {
    // Validate input
    if (!password) {
      throw new Error("Email and password are required");
    }

    if (password.length < 8) {
      throw new Error("Password must be at least 8 characters long");
    }

    const normalizedEmail = validateAndNormalizeEmail(email);

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
          throw new Error(
            `This email is linked to a ${providers} account. Please login with ${providers} and set a password from your account settings.`,
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
        await emailService.sendVerificationEmail(
          normalizedEmail,
          code,
          verifyUrl,
        );

        // Return success but indicate this was a resend, not a password update
        // The user should use their original password to log in after verification
        return { user: existingUser, requiresVerification: true };
      }
      throw new Error("User with this email already exists");
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
    await emailService.sendVerificationEmail(normalizedEmail, code, verifyUrl);

    return { user, requiresVerification: true };
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
      throw new Error("Invalid or expired verification code");
    }

    // Find user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      throw new Error("User not found");
    }

    // Mark user as verified
    user.emailVerified = true;
    await user.save();

    // Delete verification record
    await EmailVerification.deleteOne({ _id: verification._id });

    // Check for pending invitations
    const pendingInvites =
      await workspaceService.getPendingInvitesForEmail(normalizedEmail);

    // Check for existing workspaces
    const workspaces = await workspaceService.getWorkspacesForUser(user._id);

    let activeWorkspaceId: string | undefined;

    // If user has workspaces, use the first one
    if (workspaces.length > 0) {
      activeWorkspaceId = workspaces[0].workspace._id.toString();
    }
    // If there are pending invites, don't create a workspace - let user choose
    else if (pendingInvites.length > 0) {
      // No active workspace - user will be shown onboarding
      activeWorkspaceId = undefined;
    }
    // No invites and no workspaces - create default workspace
    else {
      const workspace = await workspaceService.createWorkspace(
        user._id,
        `${normalizedEmail}'s Workspace`,
      );
      activeWorkspaceId = workspace._id.toString();
    }

    // Create session (may be without activeWorkspaceId for onboarding)
    const session = await sessionManager.createSession(user._id, {
      activeWorkspaceId,
    });

    return { user, session, hasWorkspaces: !!activeWorkspaceId };
  }

  /**
   * Resend verification email
   */
  async resendVerification(email: string) {
    const normalizedEmail = normalizeEmail(email);

    // Find user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      throw new Error("User not found");
    }

    if (user.emailVerified) {
      throw new Error("Email is already verified");
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
    await emailService.sendVerificationEmail(normalizedEmail, code, verifyUrl);
  }

  /**
   * Login user with email and password
   */
  async login(email: string, password: string) {
    // Validate input
    if (!password) {
      throw new Error("Email and password are required");
    }

    // Find user
    const normalizedEmail = validateAndNormalizeEmail(email);
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      throw new Error("Invalid email or password");
    }

    // Check if user has password (not OAuth only)
    if (!user.hashedPassword) {
      throw new Error("Please login with your OAuth provider");
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.hashedPassword);
    if (!validPassword) {
      throw new Error("Invalid email or password");
    }

    // Check if email is verified
    if (!user.emailVerified) {
      // Send a new verification code
      await this.resendVerification(email);
      throw new Error(
        "Please verify your email before logging in. A new verification code has been sent.",
      );
    }

    // Get user's workspaces
    const workspaces = await workspaceService.getWorkspacesForUser(user._id);
    const activeWorkspaceId =
      workspaces.length > 0
        ? workspaces[0].workspace._id.toString()
        : undefined;

    // Create session
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
      const workspaces = await workspaceService.getWorkspacesForUser(user._id);
      const activeWorkspaceId =
        workspaces.length > 0
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

    // Check for pending invitations
    const pendingInvites = await workspaceService.getPendingInvitesForEmail(
      user.email,
    );

    // Check for existing workspaces
    const workspaces = await workspaceService.getWorkspacesForUser(user._id);
    let activeWorkspaceId: string | undefined;

    // If user has workspaces, use the first one
    if (workspaces.length > 0) {
      activeWorkspaceId = workspaces[0].workspace._id.toString();
    }
    // If there are pending invites, don't create a workspace - let user choose
    else if (pendingInvites.length > 0) {
      // No active workspace - user will be shown onboarding
      activeWorkspaceId = undefined;
    }
    // No invites and no workspaces - create default workspace
    else {
      const workspace = await workspaceService.createWorkspace(
        user._id,
        `${user.email}'s Workspace`,
      );
      activeWorkspaceId = workspace._id.toString();
    }

    // Create session (may be without activeWorkspaceId for onboarding)
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
      throw new Error("Invalid or expired verification code");
    }

    // Find user
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      throw new Error("User not found");
    }

    if (user.hashedPassword) {
      throw new Error("Password is already set for this account");
    }

    // Validate password
    if (!password || password.length < 8) {
      throw new Error("Password must be at least 8 characters long");
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
      throw new Error("User not found");
    }

    if (user.hashedPassword) {
      throw new Error("Password is already set for this account");
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
    await emailService.sendVerificationEmail(normalizedEmail, code, verifyUrl);
  }
}
