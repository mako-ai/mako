/**
 * General API client that handles authentication and error responses
 */
import { getApiBasePath } from "./api-base-path";

interface ApiRequestOptions extends RequestInit {
  params?: Record<string, string>;
}

// Flag to prevent multiple 401 redirects
let isRedirectingToLogin = false;

class ApiClient {
  private basePath: string;

  constructor() {
    this.basePath = getApiBasePath(import.meta.env.VITE_API_URL);
  }

  /**
   * Get active workspace ID from localStorage
   */
  private getActiveWorkspaceId(): string | null {
    return localStorage.getItem("activeWorkspaceId");
  }

  /**
   * Build URL with query parameters
   */
  private buildUrl(path: string, params?: Record<string, string>): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const fullPath =
      this.basePath === "/"
        ? normalizedPath
        : `${this.basePath}${normalizedPath}`;
    const url = new URL(fullPath, window.location.origin);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    return url.toString();
  }

  /**
   * Handle API response and errors
   */
  private async handleResponse<T>(response: Response): Promise<T> {
    // Handle 401 Unauthorized - redirect to login (but avoid redirect loop)
    if (response.status === 401) {
      // Clear any stored auth state
      localStorage.removeItem("activeWorkspaceId");

      // Only redirect if not already redirecting and not on login/register page
      const currentPath = window.location.pathname;
      const isAuthPage =
        currentPath === "/login" || currentPath === "/register";

      if (!isAuthPage && !isRedirectingToLogin) {
        isRedirectingToLogin = true;
        window.location.href = "/login";
      }
      throw new Error("Unauthorized");
    }

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: "An error occurred" }));
      throw new Error(error.error || `HTTP error! status: ${response.status}`);
    }

    // Handle empty responses
    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text as unknown as T;
    }
  }

  /**
   * Make authenticated API request
   */
  async request<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
    const { params, headers = {}, ...restOptions } = options;

    const url = this.buildUrl(path, params);

    // Add workspace header if available
    const workspaceId = this.getActiveWorkspaceId();
    const workspaceHeaders: Record<string, string> = {};
    if (workspaceId) {
      workspaceHeaders["x-workspace-id"] = workspaceId;
    }

    const response = await fetch(url, {
      ...restOptions,
      headers: {
        "Content-Type": "application/json",
        ...workspaceHeaders,
        ...headers,
      },
      credentials: "include", // Always include credentials for cookie-based auth
    });

    return this.handleResponse<T>(response);
  }

  /**
   * GET request
   */
  async get<T>(
    path: string,
    params?: Record<string, string>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    return this.request<T>(path, {
      method: "GET",
      params,
      signal: options?.signal,
    });
  }

  /**
   * POST request
   */
  async post<T>(
    path: string,
    data?: any,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: data ? JSON.stringify(data) : undefined,
      signal: options?.signal,
    });
  }

  /**
   * POST and return JSON for specific non-2xx statuses without throwing
   * (e.g. 400 with structured { code } for preview safety).
   */
  async postWithStatus<T>(
    path: string,
    data?: unknown,
    options?: {
      signal?: AbortSignal;
      /** Status codes to parse as JSON body instead of throwing */
      alsoOk?: number[];
    },
  ): Promise<{ status: number; body: T }> {
    const alsoOk = new Set(options?.alsoOk ?? [400, 403]);
    const url = this.buildUrl(path);
    const workspaceId = this.getActiveWorkspaceId();
    const workspaceHeaders: Record<string, string> = {};
    if (workspaceId) {
      workspaceHeaders["x-workspace-id"] = workspaceId;
    }

    const response = await fetch(url, {
      method: "POST",
      body: data ? JSON.stringify(data) : undefined,
      signal: options?.signal,
      headers: {
        "Content-Type": "application/json",
        ...workspaceHeaders,
      },
      credentials: "include",
    });

    if (response.status === 401) {
      localStorage.removeItem("activeWorkspaceId");
      const currentPath = window.location.pathname;
      const isAuthPage =
        currentPath === "/login" || currentPath === "/register";
      if (!isAuthPage && !isRedirectingToLogin) {
        isRedirectingToLogin = true;
        window.location.href = "/login";
      }
      throw new Error("Unauthorized");
    }

    const text = await response.text();
    let body: T = {} as T;
    if (text) {
      try {
        body = JSON.parse(text) as T;
      } catch {
        body = text as unknown as T;
      }
    }

    if (response.ok || alsoOk.has(response.status)) {
      return { status: response.status, body };
    }

    const errBody = body as { error?: string };
    throw new Error(errBody?.error || `HTTP error! status: ${response.status}`);
  }

  /**
   * PUT request
   */
  async put<T>(
    path: string,
    data?: any,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    return this.request<T>(path, {
      method: "PUT",
      body: data ? JSON.stringify(data) : undefined,
      signal: options?.signal,
    });
  }

  /**
   * DELETE request
   */
  async delete<T>(
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    return this.request<T>(path, { method: "DELETE", signal: options?.signal });
  }

  /**
   * PATCH request
   */
  async patch<T>(path: string, data?: any): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      body: data ? JSON.stringify(data) : undefined,
    });
  }
}

// Export singleton instance
export const apiClient = new ApiClient();
