import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import {
  authClient,
  type User,
  type LoginCredentials,
  type RegisterCredentials,
} from "../lib/auth-client";
import { identify, trackEvent } from "../lib/analytics";

/**
 * Auth context state interface
 */
interface AuthContextState {
  user: User | null;
  loading: boolean;
  error: string | null;
  login: (credentials: LoginCredentials) => Promise<void>;
  register: (
    credentials: RegisterCredentials,
  ) => Promise<{ requiresVerification: boolean }>;
  verifyEmail: (email: string, code: string) => Promise<void>;
  resendVerification: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  loginWithOAuth: (provider: "google" | "github") => void;
  clearError: () => void;
}

/**
 * Auth context
 */
const AuthContext = createContext<AuthContextState | undefined>(undefined);

/**
 * Auth provider component
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Check authentication status on mount
   */
  useEffect(() => {
    checkAuth();
  }, []);

  /**
   * Check if user is authenticated
   */
  const checkAuth = async () => {
    try {
      setLoading(true);
      const currentUser = await authClient.getMe();
      setUser(currentUser);

      // Identify user for analytics on app start (only if authenticated)
      if (currentUser) {
        identify(currentUser.id, { email: currentUser.email });

        // Check for OAuth sign-up flag (set by backend after OAuth callback)
        // Value is the provider name: "google" or "github"
        const params = new URLSearchParams(window.location.search);
        const oauthProvider = params.get("new_user");
        if (oauthProvider) {
          // Clean up URL by removing the new_user param (always, even if invalid)
          params.delete("new_user");
          const newUrl =
            params.toString().length > 0
              ? `${window.location.pathname}?${params.toString()}`
              : window.location.pathname;
          window.history.replaceState({}, "", newUrl);

          // Validate that the provider is a legitimate OAuth provider to prevent
          // analytics pollution from crafted URLs
          const validOAuthProviders = ["google", "github"] as const;
          if (
            validOAuthProviders.includes(
              oauthProvider as (typeof validOAuthProviders)[number],
            )
          ) {
            // Track sign_up event for OAuth users with specific provider
            trackEvent("sign_up", { method: oauthProvider });
          }
        }
      }
    } catch (err) {
      console.error("Auth check failed:", err);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Login user
   */
  const login = useCallback(async (credentials: LoginCredentials) => {
    try {
      setError(null);
      setLoading(true);
      const user = await authClient.login(credentials);
      setUser(user);
      // Identify user for analytics on login
      identify(user.id, { email: user.email });
    } catch (err: any) {
      setError(err.message || "Login failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Register user
   */
  const register = useCallback(
    async (
      credentials: RegisterCredentials,
    ): Promise<{ requiresVerification: boolean }> => {
      try {
        setError(null);
        setLoading(true);
        const { user, requiresVerification } =
          await authClient.register(credentials);

        // Only set user if verification is not required
        // (shouldn't happen with new flow, but for safety)
        if (!requiresVerification) {
          setUser(user);
          // Identify user for analytics on registration
          identify(user.id, { email: user.email });
        }

        return { requiresVerification };
      } catch (err: any) {
        setError(err.message || "Registration failed");
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  /**
   * Verify email with code
   */
  const verifyEmail = useCallback(async (email: string, code: string) => {
    try {
      setError(null);
      setLoading(true);
      const user = await authClient.verifyEmail(email, code);
      setUser(user);
      // Identify user for analytics after email verification
      identify(user.id, { email: user.email });
    } catch (err: any) {
      setError(err.message || "Verification failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Resend verification email
   */
  const resendVerification = useCallback(async (email: string) => {
    try {
      setError(null);
      await authClient.resendVerification(email);
    } catch (err: any) {
      setError(err.message || "Failed to resend verification");
      throw err;
    }
  }, []);

  /**
   * Logout user
   */
  const logout = useCallback(async () => {
    try {
      setError(null);
      setLoading(true);
      await authClient.logout();
      setUser(null);
    } catch (err: any) {
      setError(err.message || "Logout failed");
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Login with OAuth provider
   */
  const loginWithOAuth = useCallback((provider: "google" | "github") => {
    authClient.initiateOAuth(provider);
  }, []);

  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const value: AuthContextState = {
    user,
    loading,
    error,
    login,
    register,
    verifyEmail,
    resendVerification,
    logout,
    loginWithOAuth,
    clearError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to use auth context
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
