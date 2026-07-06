import { IDatabaseConnection } from "../../database/workspace-schema";

/**
 * Build a minimal in-memory `IDatabaseConnection` for driver unit tests.
 *
 * Drivers only read `type` + `connection.*` fields when building SQL, so this
 * intentionally omits Mongoose document machinery. Cast through `unknown` to the
 * interface — tests never persist or hydrate these.
 */
export function makeFakeConnection(
  type: string,
  connection: Record<string, unknown> = {},
): IDatabaseConnection {
  return {
    _id: "fake-connection-id",
    name: `fake-${type}`,
    type,
    connection,
  } as unknown as IDatabaseConnection;
}

/** A parseable-but-fake BigQuery service account (no real key material). */
export const FAKE_BIGQUERY_SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "fake-project",
  client_email: "fake@fake-project.iam.gserviceaccount.com",
  // Not a real key — only needs to satisfy `parseServiceAccount`; emulator paths
  // never sign/exchange it.
  private_key: "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n",
  token_uri: "https://oauth2.googleapis.com/token",
});
