/**
 * Credential types: how a key is sent with a request.
 *
 * Code, not stored. Four ways, whatever the service: an API key in a header,
 * an API key in the query string, a bearer token, or basic auth (OAuth
 * later). A connector fixes its own (Close sends its key as basic auth,
 * Stripe and Wise as a bearer token); a Custom API connection picks one
 * (connections/callable.ts).
 */

export const CREDENTIAL_TYPES = [
  "bearer",
  "api_key_header",
  "api_key_query",
  "basic",
] as const;
export type CredentialTypeId = (typeof CREDENTIAL_TYPES)[number];

/** One filled-in credential, as a request needs it. */
export type Credential =
  | { type: "bearer"; token: string }
  | { type: "api_key_header"; token: string; header: string }
  | { type: "api_key_query"; token: string; param: string }
  | { type: "basic"; username: string; password: string }
  /** No credential (a public API). */
  | { type: "none" };

/** A request on its way to the service, before the credential is added. */
export interface OutgoingRequest {
  method: string;
  url: URL;
  /** Lower-case names. */
  headers: Record<string, string>;
  /** Already encoded. */
  body?: string;
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** Add `credential` to `request`, the way its type sends it. */
export function applyCredential(
  request: OutgoingRequest,
  credential: Credential,
): void {
  switch (credential.type) {
    case "bearer":
      request.headers.authorization = `Bearer ${credential.token}`;
      return;
    case "api_key_header":
      request.headers[credential.header.toLowerCase()] = credential.token;
      return;
    case "api_key_query":
      request.url.searchParams.set(credential.param, credential.token);
      return;
    case "basic":
      request.headers.authorization = basic(
        credential.username,
        credential.password,
      );
      return;
    case "none":
      return;
  }
}

/** Header names the credential travels in: never passed back in an answer. */
export function credentialHeaders(credential: Credential): string[] {
  return credential.type === "api_key_header"
    ? ["authorization", credential.header.toLowerCase()]
    : ["authorization"];
}

/** The values that must never appear in an answer. */
export function credentialSecrets(credential: Credential): string[] {
  switch (credential.type) {
    case "bearer":
    case "api_key_header":
    case "api_key_query":
      return [credential.token];
    case "basic":
      return [credential.password, credential.username].filter(Boolean);
    case "none":
      return [];
  }
}
