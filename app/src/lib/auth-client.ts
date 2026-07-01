/**
 * Authentication client for handling all auth-related API calls
 */
import { getApiBasePath } from "./api-base-path";

interface LoginCredentials {
  email: string;
  password: string;
}

interface RegisterCredentials extends LoginCredentials {
  confirmPassword?: string;
}

interface User {
  id: string;
  email: string;
  createdAt?: string;
  linkedAccounts?: Array<{
    provider: string;
    email?: string;
    linkedAt: string;
  }>;
  /**
   * True if the user's email appears in `SUPER_ADMIN_EMAILS` on the server.
   * Cosmetic only — actual admin routes are server-enforced.
   */
  isSuperAdmin?: boolean;
}

interface AuthResponse {
  user: User;
  requiresVerification?: boolean;
  message?: string;
}

class AuthClient {
  private basePath: string;

  constructor() {
    this.basePath = getApiBasePath(import.meta.env.VITE_API_URL);
  }

  private buildUrl(path: string): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return this.basePath === "/"
      ? normalizedPath
      : `${this.basePath}${normalizedPath}`;
  }

  /**
   * Helper method to handle API responses
   */
  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: "An error occurred" }));
      throw new Error(error.error || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Register a new user
   * Returns user and whether verification is required
   */
  async register(
    credentials: RegisterCredentials,
  ): Promise<{ user: User; requiresVerification: boolean }> {
    if (
      credentials.confirmPassword &&
      credentials.password !== credentials.confirmPassword
    ) {
      throw new Error("Passwords do not match");
    }

    const response = await fetch(this.buildUrl("/auth/register"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    });

    const data = await this.handleResponse<AuthResponse>(response);
    return {
      user: data.user,
      requiresVerification: data.requiresVerification ?? false,
    };
  }

  /**
   * Verify email with code
   */
  async verifyEmail(email: string, code: string): Promise<User> {
    const response = await fetch(this.buildUrl("/auth/verify-email"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ email, code }),
    });

    const data = await this.handleResponse<AuthResponse>(response);
    return data.user;
  }

  /**
   * Resend verification email
   */
  async resendVerification(email: string): Promise<void> {
    const response = await fetch(this.buildUrl("/auth/resend-verification"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ email }),
    });

    await this.handleResponse(response);
  }

  /**
   * Login user
   */
  async login(credentials: LoginCredentials): Promise<User> {
    const response = await fetch(this.buildUrl("/auth/login"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(credentials),
    });

    const data = await this.handleResponse<AuthResponse>(response);
    return data.user;
  }

  /**
   * Logout user
   */
  async logout(): Promise<void> {
    const response = await fetch(this.buildUrl("/auth/logout"), {
      method: "POST",
      credentials: "include",
    });

    await this.handleResponse(response);
  }

  /**
   * Get current user.
   *
   * A page load during a rolling deploy can briefly hit a starting/draining
   * instance (or a momentarily unreachable database) and fail with a network
   * error or 5xx even though the session cookie is still valid. Treating that
   * as "logged out" bounced users to `/login` on essentially every redeploy.
   *
   * So we retry transient failures with backoff to ride out the deploy window
   * and only conclude the user is unauthenticated on a definitive `401`.
   */
  async getMe(): Promise<User | null> {
    const backoffsMs = [300, 800, 1500, 2500];

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(this.buildUrl("/auth/me"), {
          method: "GET",
          credentials: "include",
          cache: "no-store",
        });

        // Definitive answer from the server — the session is genuinely gone.
        if (response.status === 401) {
          return null;
        }

        if (response.ok) {
          const data = await this.handleResponse<{ user: User }>(response);
          return data.user;
        }
        // Other statuses (502/503/504/etc.) are likely a deploy blip — retry.
      } catch {
        // Network error — likely a deploy blip — retry.
      }

      const backoff = backoffsMs[attempt];
      if (backoff === undefined) {
        // Exhausted retries without a definitive answer (extended outage);
        // fall back to unauthenticated so the app doesn't hang.
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }

  /**
   * Refresh session
   */
  async refresh(): Promise<User | null> {
    try {
      const response = await fetch(this.buildUrl("/auth/refresh"), {
        method: "POST",
        credentials: "include",
      });

      if (response.status === 401) {
        return null;
      }

      const data = await this.handleResponse<AuthResponse>(response);
      return data.user;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if OAuth is enabled
   * Uses environment variable set at build time
   */
  isOAuthEnabled(): boolean {
    return import.meta.env.VITE_DISABLE_OAUTH !== "true";
  }

  /**
   * Get auth configuration from server
   * Useful for dynamic OAuth status checking
   */
  async getAuthConfig(): Promise<{
    oauthEnabled: boolean;
    providers: string[];
  }> {
    try {
      const response = await fetch(this.buildUrl("/auth/config"), {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        return { oauthEnabled: true, providers: ["google", "github"] };
      }

      return response.json();
    } catch {
      // Default to enabled if we can't reach the server
      return { oauthEnabled: true, providers: ["google", "github"] };
    }
  }

  /**
   * Initiate OAuth login
   */
  initiateOAuth(provider: "google" | "github") {
    window.location.href = this.buildUrl(`/auth/${provider}`);
  }

  /**
   * Mint a one-time desktop auth code bound to a PKCE challenge.
   * Called from the /desktop-auth handoff page in the system browser;
   * the code is then delivered to the desktop app via mako://auth?code=...
   */
  async createDesktopAuthCode(
    challenge: string,
  ): Promise<{ code: string; expiresIn: number }> {
    const response = await fetch(this.buildUrl("/auth/desktop/code"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ challenge }),
    });

    return this.handleResponse<{ code: string; expiresIn: number }>(response);
  }

  /**
   * Request password reset
   */
  async requestPasswordReset(email: string): Promise<void> {
    const response = await fetch(this.buildUrl("/auth/forgot-password"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ email }),
    });

    await this.handleResponse(response);
  }

  /**
   * Reset password with code
   */
  async resetPassword(
    email: string,
    code: string,
    password: string,
  ): Promise<void> {
    const response = await fetch(this.buildUrl("/auth/reset-password"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ email, code, password }),
    });

    await this.handleResponse(response);
  }
}

// Export singleton instance
export const authClient = new AuthClient();

// Export types
export type { User, LoginCredentials, RegisterCredentials, AuthResponse };
