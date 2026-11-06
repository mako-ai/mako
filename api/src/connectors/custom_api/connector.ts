import {
  BaseConnector,
  ConnectionTestResult,
  FetchOptions,
} from "../base/BaseConnector";
import { customApi } from "../../connections/callable";
import { forward } from "../../connections/forward";

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
          // Not `credential_type`: a field named like a credential is
          // treated as a secret and masked when read back.
          name: "auth_type",
          label: "Credential type",
          type: "select",
          required: true,
          default: "bearer",
          options: [
            { label: "Bearer token", value: "bearer" },
            { label: "API key in a header", value: "api_key_header" },
            { label: "API key in the query string", value: "api_key_query" },
            { label: "Basic auth (username and password)", value: "basic" },
            {
              label: "Google service account (access token)",
              value: "google_service_account",
            },
            {
              label: "Google service account (ID token: Cloud Run, IAP)",
              value: "google_id_token",
            },
            { label: "None", value: "none" },
          ],
        },
        {
          name: "token",
          label: "Key",
          type: "password",
          required: false,
          showIf: {
            field: "auth_type",
            equals: ["bearer", "api_key_header", "api_key_query"],
          },
        },
        {
          name: "header_name",
          label: "Header name",
          type: "string",
          required: false,
          default: "X-API-Key",
          showIf: { field: "auth_type", equals: "api_key_header" },
        },
        {
          name: "query_param",
          label: "Query parameter",
          type: "string",
          required: false,
          default: "api_key",
          showIf: { field: "auth_type", equals: "api_key_query" },
        },
        {
          name: "username",
          label: "Username",
          type: "string",
          // Often the key itself (Close-style, no password): kept as one.
          encrypted: true,
          required: false,
          showIf: { field: "auth_type", equals: "basic" },
        },
        {
          name: "password",
          label: "Password",
          type: "password",
          required: false,
          showIf: { field: "auth_type", equals: "basic" },
        },
        {
          name: "service_account_json",
          label: "Service account key (JSON)",
          type: "textarea",
          rows: 10,
          encrypted: true,
          required: false,
          placeholder: `{
  "type": "service_account",
  "client_email": "svc@project.iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n",
  ...
}`,
          helperText:
            "The JSON key file. Each request gets a short-lived Google token made from it; the key itself is never sent.",
          showIf: {
            field: "auth_type",
            equals: ["google_service_account", "google_id_token"],
          },
        },
        {
          name: "scopes",
          label: "Scopes",
          type: "string",
          required: false,
          placeholder: "https://www.googleapis.com/auth/cloud-platform",
          helperText: "Separated by spaces or commas. Default: cloud-platform.",
          showIf: { field: "auth_type", equals: "google_service_account" },
        },
        {
          name: "subject",
          label: "Act as user (optional)",
          type: "string",
          required: false,
          placeholder: "someone@yourcompany.com",
          helperText:
            "Google Workspace APIs only: the user the service account acts for, with domain-wide delegation.",
          showIf: { field: "auth_type", equals: "google_service_account" },
        },
        {
          name: "audience",
          label: "Audience (optional)",
          type: "string",
          required: false,
          placeholder: "https://my-service-abc123-ew.a.run.app",
          helperText:
            "Who the ID token is for. Default: the address's origin, as Cloud Run expects. For IAP, the OAuth client ID.",
          showIf: { field: "auth_type", equals: "google_id_token" },
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
          name: "extra_headers",
          label: "Headers",
          type: "object_array",
          required: false,
          helperText:
            "Optional. Sent with every request, e.g. Notion-Version. Not for keys: anyone who can see the connection sees them. The credential's header and transport headers cannot be set.",
          itemFields: [
            {
              name: "name",
              label: "Header name",
              type: "string",
              required: true,
              placeholder: "Notion-Version",
            },
            {
              name: "value",
              label: "Value",
              type: "string",
              required: true,
              placeholder: "2022-06-28",
            },
          ],
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

  async testConnection(): Promise<ConnectionTestResult> {
    // A missing or non-http(s) address is refused by the proxy's own check
    // (connections/forward.ts `urlUnder`), with a message the form shows.
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
        message: error instanceof Error ? error.message : "The request failed",
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
