import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
} from "../base/BaseConnector";
import { customApi } from "../../connections/callable";
import { ConnectionRequestError, forward } from "../../connections/forward";

/**
 * A Custom API connection: an address, a credential type and its key, and an
 * optional GraphQL mode.
 *
 * Called, never synced. Workflows (`connection(id)` in lib/mako) and agents
 * call it through the connection proxy; it has no entities, and a flow never
 * offers it (connections/kinds.ts). How it is called is `customApi` in
 * connections/callable.ts.
 */
export class CustomApiConnector extends BaseConnector {
  static getConfigSchema() {
    return {
      fields: [
        {
          name: "base_url",
          label: "Address",
          type: "string",
          required: true,
          placeholder: "https://api.example.com/v1",
          helperText:
            "The API's base URL. Every request goes under it; a path outside it is refused.",
        },
        {
          name: "credential_type",
          label: "Credential type",
          type: "select",
          required: true,
          default: "bearer",
          options: [
            { label: "Bearer token", value: "bearer" },
            { label: "API key in a header", value: "api_key_header" },
            { label: "API key in the query string", value: "api_key_query" },
            { label: "Basic auth (username and password)", value: "basic" },
            { label: "None", value: "none" },
          ],
        },
        {
          name: "token",
          label: "Key",
          type: "password",
          required: false,
          showIf: {
            field: "credential_type",
            equals: ["bearer", "api_key_header", "api_key_query"],
          },
        },
        {
          name: "header_name",
          label: "Header name",
          type: "string",
          required: false,
          default: "X-API-Key",
          showIf: { field: "credential_type", equals: "api_key_header" },
        },
        {
          name: "query_param",
          label: "Query parameter",
          type: "string",
          required: false,
          default: "api_key",
          showIf: { field: "credential_type", equals: "api_key_query" },
        },
        {
          name: "username",
          label: "Username",
          type: "string",
          required: false,
          showIf: { field: "credential_type", equals: "basic" },
        },
        {
          name: "password",
          label: "Password",
          type: "password",
          required: false,
          showIf: { field: "credential_type", equals: "basic" },
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
            "Optional. A GET under the address that needs the credential, used by Test. With GraphQL on, Test sends { __typename } instead.",
        },
      ],
    };
  }

  getMetadata() {
    return {
      name: "Custom API",
      version: "1.0.0",
      description:
        "Any HTTP or GraphQL API with a stored key, for workflows and agents to call. Never synced.",
      supportedEntities: [],
    };
  }

  validateConfig() {
    const errors: string[] = [];
    const config = this.dataSource.config ?? {};
    const base = typeof config.base_url === "string" ? config.base_url : "";
    try {
      const url = new URL(base);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        errors.push("The address must start with https://");
      }
    } catch {
      errors.push("An address is required");
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
        customApi,
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
      "A Custom API connection is never synced. Call it from a workflow with connection(id).",
    );
  }
}
