import { v4 as uuidv4 } from "uuid";
import { Session, User, ISession, IUser } from "../database/schema";

/**
 * Session configuration
 */
const SESSION_COOKIE_NAME = "auth_session";
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_REFRESH_THRESHOLD_MS = 12 * 60 * 60 * 1000; // Refresh if less than 12 hours remaining

/**
 * Session attributes that can be stored with a session
 */
export interface SessionAttributes {
  activeWorkspaceId?: string;
}

/**
 * Validated session result
 */
export interface ValidatedSession {
  id: string;
  userId: string;
  expiresAt: Date;
  activeWorkspaceId?: string;
  fresh: boolean; // True if session was just refreshed
}

/**
 * Validated user result
 */
export interface ValidatedUser {
  id: string;
  email: string;
}

/**
 * Cookie attributes for session cookie
 */
export interface CookieAttributes {
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  httpOnly: boolean;
  maxAge?: number;
}

/**
 * Session cookie object
 */
export interface SessionCookie {
  name: string;
  value: string;
  attributes: CookieAttributes;
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return uuidv4().replace(/-/g, "") + uuidv4().replace(/-/g, "");
}

/**
 * Get cookie attributes based on environment
 */
function getCookieAttributes(maxAge?: number): CookieAttributes {
  return {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    httpOnly: true,
    maxAge,
  };
}

/**
 * Session management class - replaces Lucia
 */
class SessionManager {
  /**
   * Session cookie name
   */
  readonly sessionCookieName = SESSION_COOKIE_NAME;

  /**
   * Create a new session for a user
   */
  async createSession(
    userId: string,
    attributes: SessionAttributes = {},
  ): Promise<ValidatedSession> {
    const sessionId = generateSessionId();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    await Session.create({
      _id: sessionId,
      userId,
      expiresAt,
      activeWorkspaceId: attributes.activeWorkspaceId,
    });

    return {
      id: sessionId,
      userId,
      expiresAt,
      activeWorkspaceId: attributes.activeWorkspaceId,
      fresh: true,
    };
  }

  /**
   * Validate session and get user
   * Returns null values if session is invalid or expired
   */
  async validateSession(
    sessionId: string,
  ): Promise<{ session: ValidatedSession | null; user: ValidatedUser | null }> {
    if (!sessionId) {
      return { session: null, user: null };
    }

    const sessionDoc = await Session.findById(sessionId).lean<ISession>();
    if (!sessionDoc) {
      return { session: null, user: null };
    }

    // Check if session is expired
    if (sessionDoc.expiresAt < new Date()) {
      // Delete expired session
      await Session.deleteOne({ _id: sessionId });
      return { session: null, user: null };
    }

    // Get user
    const userDoc = await User.findById(sessionDoc.userId).lean<IUser>();
    if (!userDoc) {
      // User no longer exists, delete orphaned session
      await Session.deleteOne({ _id: sessionId });
      return { session: null, user: null };
    }

    // Check if session needs refresh
    const timeRemaining = sessionDoc.expiresAt.getTime() - Date.now();
    let fresh = false;

    if (timeRemaining < SESSION_REFRESH_THRESHOLD_MS) {
      // Refresh session
      const newExpiresAt = new Date(Date.now() + SESSION_DURATION_MS);
      await Session.updateOne({ _id: sessionId }, { expiresAt: newExpiresAt });
      sessionDoc.expiresAt = newExpiresAt;
      fresh = true;
    }

    return {
      session: {
        id: sessionDoc._id,
        userId: sessionDoc.userId,
        expiresAt: sessionDoc.expiresAt,
        activeWorkspaceId: sessionDoc.activeWorkspaceId,
        fresh,
      },
      user: {
        id: userDoc._id,
        email: userDoc.email,
      },
    };
  }

  /**
   * Invalidate (delete) a session
   */
  async invalidateSession(sessionId: string): Promise<void> {
    await Session.deleteOne({ _id: sessionId });
  }

  /**
   * Invalidate all sessions for a user
   */
  async invalidateUserSessions(userId: string): Promise<void> {
    await Session.deleteMany({ userId });
  }

  /**
   * Update session attributes (e.g., activeWorkspaceId)
   */
  async updateSessionAttributes(
    sessionId: string,
    attributes: Partial<SessionAttributes>,
  ): Promise<void> {
    const updateFields: Record<string, any> = {};

    if (attributes.activeWorkspaceId !== undefined) {
      updateFields.activeWorkspaceId = attributes.activeWorkspaceId;
    }

    if (Object.keys(updateFields).length > 0) {
      await Session.updateOne({ _id: sessionId }, updateFields);
    }
  }

  /**
   * Create a session cookie for setting in response
   */
  createSessionCookie(sessionId: string): SessionCookie {
    return {
      name: SESSION_COOKIE_NAME,
      value: sessionId,
      attributes: getCookieAttributes(
        Math.floor(SESSION_DURATION_MS / 1000), // Convert to seconds
      ),
    };
  }

  /**
   * Create a blank session cookie for clearing/logout
   */
  createBlankSessionCookie(): SessionCookie {
    return {
      name: SESSION_COOKIE_NAME,
      value: "",
      attributes: getCookieAttributes(0), // Expire immediately
    };
  }

  /**
   * Read session ID from cookie header
   */
  readSessionCookie(cookieHeader: string): string | null {
    if (!cookieHeader) {
      return null;
    }

    const cookies = cookieHeader.split(";").map(c => c.trim());
    for (const cookie of cookies) {
      const equalsIndex = cookie.indexOf("=");
      if (equalsIndex === -1) continue;
      const name = cookie.substring(0, equalsIndex);
      const value = cookie.substring(equalsIndex + 1);
      if (name === SESSION_COOKIE_NAME && value) {
        return value;
      }
    }

    return null;
  }

  /**
   * Delete expired sessions (for cleanup)
   */
  async deleteExpiredSessions(): Promise<number> {
    const result = await Session.deleteMany({
      expiresAt: { $lte: new Date() },
    });
    return result.deletedCount;
  }
}

// Export singleton instance
export const sessionManager = new SessionManager();

// Export types for use elsewhere
export type { ISession, IUser };
