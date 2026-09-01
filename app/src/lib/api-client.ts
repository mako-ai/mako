/**
 * General API client that handles authentication and error responses
 */
import { getApiBasePath } from "./api-base-path";
import { handleUnauthorized } from "./auth-redirect";
import { ApiError } from "../api/result";

interface ApiRequestOptions extends RequestInit {
  params?: Record<string, string>;
}

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
    // Handle 401 Unauthorized - verify the session before redirecting so a
    // transient 401 during a deploy doesn't bounce the user to /login.
    if (response.status === 401) {
      void handleUnauthorized();
      throw new ApiError("Unauthorized", 401);
    }

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: "An error occurred" }));
      // ApiError (extends Error) carries the HTTP status so callers can
      // distinguish "not found" from "no access" without string parsing.
      throw new ApiError(
        error.error || `HTTP error! status: ${response.status}`,
        response.status,
      );
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

    // Only claim a JSON body when there IS one. `post(path)` with no data sends
    // an empty body, and a `Content-Type: application/json` on an empty body
    // makes the server's JSON validator try to parse it — "Malformed JSON in
    // request body", a 500 on every route that accepts an optional body. That
    // is what broke "start with demo data" in onboarding for two weeks.
    const contentType: Record<string, string> =
      restOptions.body === undefined || restOptions.body === null
        ? {}
        : { "Content-Type": "application/json" };
    const response = await fetch(url, {
      ...restOptions,
      headers: {
        ...contentType,
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
      void handleUnauthorized();
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
   * PUT and return JSON for specific non-2xx statuses without throwing
   * (e.g. 409 draft_conflict on revision-checked console autosaves).
   */
  async putWithStatus<T>(
    path: string,
    data?: unknown,
    options?: {
      signal?: AbortSignal;
      /** Status codes to parse as JSON body instead of throwing */
      alsoOk?: number[];
    },
  ): Promise<{ status: number; body: T }> {
    const alsoOk = new Set(options?.alsoOk ?? [409]);
    const url = this.buildUrl(path);
    const workspaceId = this.getActiveWorkspaceId();
    const workspaceHeaders: Record<string, string> = {};
    if (workspaceId) {
      workspaceHeaders["x-workspace-id"] = workspaceId;
    }

    const response = await fetch(url, {
      method: "PUT",
      body: data ? JSON.stringify(data) : undefined,
      signal: options?.signal,
      headers: {
        "Content-Type": "application/json",
        ...workspaceHeaders,
      },
      credentials: "include",
    });

    if (response.status === 401) {
      void handleUnauthorized();
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
