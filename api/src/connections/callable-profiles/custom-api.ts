/**
 * The Custom API connection, as a call_connection profile: data only, no
 * connector folder. The request side moved here unchanged from callable.ts
 * (the header and Google helpers it uses stay there, tested from there). The
 * schema and Test (custom-api-test.ts) came from the deleted
 * `connectors/custom_api/`: `connection` makes the type creatable and
 * testable from the form without it (profile-connector.ts).
 *
 * Called, never synced. Workflows (`connection(id)` in lib/mako) and agents
 * call it through the connection proxy; it has no entities, and a flow never
 * offers it (connections/kinds.ts).
 */
import {
  customApiCredentialType,
  googleAudience,
  googleCredentialRefusal,
  googleScopes,
  isGraphqlRead,
  staticHeaders,
  staticHeadersRefusal,
  text,
  trimSlash,
  type Credential,
  type CallableConnection,
} from "../callable";
import { CUSTOM_API_TYPE } from "../kinds";
import { testCustomApiConnection } from "./custom-api-test";
import type { CallableProfile } from ".";

/**
 * Any HTTP API: an address, one credential type and its key. With `graphql`
 * on, only a POST of a query to the endpoint itself reads (isGraphqlRead);
 * everything else, a GET included, writes.
 */
const customApiCallable: CallableConnection = {
  type: CUSTOM_API_TYPE,
  baseUrl: config => trimSlash(text(config.base_url)),
  baseUrlFields: ["base_url"],
  appOnlyFields: [
    "auth_type",
    "header_name",
    "query_param",
    "graphql",
    "extra_headers",
    // Who the Google token speaks for and where it is valid.
    "scopes",
    "subject",
    "audience",
  ],
  configRefusal: config =>
    staticHeadersRefusal(config) ?? googleCredentialRefusal(config),
  // After the caller's headers; the credential is added after these.
  extraHeaders: (_request, config) => staticHeaders(config ?? {}),
  credential(config): Credential {
    const token = text(config.token);
    switch (customApiCredentialType(config)) {
      case "bearer":
        return { type: "bearer", token };
      case "api_key_header":
        return {
          type: "api_key_header",
          token,
          header: text(config.header_name) || "X-API-Key",
        };
      case "api_key_query":
        return {
          type: "api_key_query",
          token,
          param: text(config.query_param) || "api_key",
        };
      case "basic":
        return {
          type: "basic",
          username: text(config.username),
          password: text(config.password),
        };
      case "google_service_account":
        return {
          type: "google_service_account",
          key: text(config.service_account_json),
          scopes: googleScopes(config),
          ...(text(config.subject) ? { subject: text(config.subject) } : {}),
        };
      case "google_id_token":
        return {
          type: "google_id_token",
          key: text(config.service_account_json),
          audience: googleAudience(config),
        };
      case "none":
        return { type: "none" };
    }
  },
  reads(request, config) {
    return config.graphql === true && isGraphqlRead(request);
  },
  onlyReads: config => config.graphql === true,
};

export const customApiProfile: CallableProfile = {
  type: CUSTOM_API_TYPE,
  callable: customApiCallable,
  operations: () => [],
  connection: {
    name: "Custom API",
    description:
      "Any HTTP or GraphQL API with a stored key, for workflows and agents to call. Never synced.",
    test: connection => testCustomApiConnection(connection, customApiCallable),
  },
  configSchema: {
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
      {
        name: "test_expect",
        label: "Test expects",
        type: "string",
        required: false,
        placeholder: "ok=true",
        helperText:
          "Optional. A JSON field and the value Test needs in the answer, as path=value (e.g. ok=true, data.status=active). For APIs that report errors in a 200 body. Slack is checked for ok=true (on /auth.test unless a test path is set) by default.",
      },
    ],
  },
};
