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
}

interface AuthResponse {
  user: User;
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
   */
  async register(credentials: RegisterCredentials): Promise<User> {
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
    return data.user;
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
   * Get current user
   */
  async getMe(): Promise<User | null> {
    try {
      const response = await fetch(this.buildUrl("/auth/me"), {
        method: "GET",
        credentials: "include",
      });

      if (response.status === 401) {
        return null;
      }

      const data = await this.handleResponse<{ user: User }>(response);
      return data.user;
    } catch (error) {
      return null;
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
   * Initiate OAuth login
   */
  initiateOAuth(provider: "google" | "github") {
    window.location.href = this.buildUrl(`/auth/${provider}`);
  }
}

// Export singleton instance
export const authClient = new AuthClient();

// Export types
export type { User, LoginCredentials, RegisterCredentials, AuthResponse };
