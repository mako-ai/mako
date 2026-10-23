import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
} from "../base/BaseConnector";
import { http } from "../../connections/credential-types";
import { ConnectionRequestError, forward } from "../../connections/forward";

/**
 * A generic HTTP API connection: a base URL and one way to authenticate.
 *
 * Not a sync source. It holds a credential that workflows (`connection(id)`
 * in lib/mako) and agents call through the connection proxy; it has no
 * entities, so a flow never offers it. Its credential type is `http` in
 * connections/credential-types.ts.
 */
export class HttpConnector extends BaseConnector {
  static getConfigSchema() {
    return {
      fields: [
        {
          name: "base_url",
          label: "Base URL",
          type: "string",
          required: true,
          placeholder: "https://api.example.com/v1",
          helperText:
            "Every request goes under this URL. A path outside it is refused.",
        },
        {
          name: "auth_scheme",
          label: "Authentication",
          type: "select",
          required: true,
          default: "bearer",
          options: [
            { label: "Bearer token", value: "bearer" },
            { label: "API key in a header", value: "header" },
            { label: "Basic (username and password)", value: "basic" },
            { label: "API key in the query string", value: "query" },
            { label: "None", value: "none" },
          ],
        },
        {
          name: "token",
          label: "Token or API key",
          type: "password",
          required: false,
          showIf: {
            field: "auth_scheme",
            equals: ["bearer", "header", "query"],
          },
        },
        {
          name: "header_name",
          label: "Header name",
          type: "string",
          required: false,
          default: "X-API-Key",
          showIf: { field: "auth_scheme", equals: "header" },
        },
        {
          name: "query_param",
          label: "Query parameter",
          type: "string",
          required: false,
          default: "api_key",
          showIf: { field: "auth_scheme", equals: "query" },
        },
        {
          name: "username",
          label: "Username",
          type: "string",
          required: false,
          showIf: { field: "auth_scheme", equals: "basic" },
        },
        {
          name: "password",
          label: "Password",
          type: "password",
          required: false,
          showIf: { field: "auth_scheme", equals: "basic" },
        },
        {
          name: "graphql",
          label: "GraphQL API",
          type: "boolean",
          required: false,
          default: false,
          helperText:
            "On: a POST that only queries is a read; a mutation is a write.",
        },
        {
          name: "test_path",
          label: "Test path",
          type: "string",
          required: false,
          placeholder: "/me",
          helperText:
            "Optional. A GET under the base URL that needs the credential, used by Test. With GraphQL on, Test sends { __typename } instead.",
        },
      ],
    };
  }

  getMetadata() {
    return {
      name: "HTTP API",
      version: "1.0.0",
      description:
        "Any HTTP or GraphQL API with a stored credential, for workflows and agents. Not a sync source.",
      supportedEntities: [],
      syncable: false,
    };
  }

  validateConfig() {
    const errors: string[] = [];
    const config = this.dataSource.config ?? {};
    const base = typeof config.base_url === "string" ? config.base_url : "";
    try {
      const url = new URL(base);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        errors.push("The base URL must start with https://");
      }
    } catch {
      errors.push("A base URL is required");
    }
    return { valid: errors.length === 0, errors };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const validation = this.validateConfig();
    if (!validation.valid) {
      return {
        success: false,
        message: "Invalid configuration",
        details: validation.errors,
      };
    }
    const config = this.dataSource.config ?? {};
    const testPath =
      typeof config.test_path === "string" && config.test_path.trim()
        ? config.test_path.trim()
        : "/";
    try {
      const answer = await forward(
        this.dataSource,
        http,
        config.graphql === true
          ? { method: "POST", path: "/", body: { query: "{ __typename }" } }
          : { method: "GET", path: testPath },
        { timeoutMs: 15_000 },
      );
      if (answer.status === 401 || answer.status === 403) {
        return {
          success: false,
          message: `The service refused the credential (HTTP ${answer.status}).`,
        };
      }
      if (answer.status >= 400) {
        return {
          success: false,
          message: `The service answered HTTP ${answer.status}. Set a test path that exists.`,
        };
      }
      return {
        success: true,
        message: `Connected (HTTP ${answer.status}).`,
      };
    } catch (error) {
      return {
        success: false,
        message:
          error instanceof ConnectionRequestError || error instanceof Error
            ? error.message
            : "The request failed",
      };
    }
  }

  getAvailableEntities(): string[] {
    return [];
  }

  async fetchEntity(_options: FetchOptions): Promise<void> {
    throw new Error(
      "An HTTP API connection is not a sync source. Call it from a workflow with connection(id).",
    );
  }
}
