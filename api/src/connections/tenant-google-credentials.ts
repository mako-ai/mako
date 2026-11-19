/**
 * Credentials for a tenant's Google connection (Cloud SQL, GCS, BigQuery
 * destination). A tenant connection always signs in with the service-account
 * key its owner supplied. It never falls back to Mako's own Application
 * Default Credentials (the API's Cloud Run service account): a tenant who
 * names a resource that account can reach would act as Mako.
 *
 * TODO: switch to the shared service-account validator once the
 * google-credential-type-check change lands. Until then this is the single
 * place that parses and checks the key.
 */

export interface TenantServiceAccount {
  /** The parsed key file, passed to Google clients as `credentials`. */
  credentials: Record<string, unknown>;
  client_email: string;
  private_key: string;
  project_id?: string;
}

/**
 * The service account in `raw` (JSON string or parsed object). Throws a clear
 * error when the key is missing or is not a service-account key, so no caller
 * reaches a Google client without tenant-supplied credentials.
 */
export function requireTenantServiceAccount(
  raw: unknown,
  what: string,
): TenantServiceAccount {
  const missing = () =>
    new Error(
      `${what} requires a Google service account JSON key. Mako does not use its own Google credentials for your connections.`,
    );
  if (raw === undefined || raw === null) throw missing();
  if (typeof raw === "string" && !raw.trim()) throw missing();

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `${what}: the service account JSON key is not valid JSON.`,
      );
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${what}: the service account JSON key must be an object.`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "service_account") {
    throw new Error(
      `${what}: the credential must be a service account key (type "service_account").`,
    );
  }
  const { client_email, private_key, project_id } = obj;
  if (
    typeof client_email !== "string" ||
    !client_email.trim() ||
    typeof private_key !== "string" ||
    !private_key.trim()
  ) {
    throw new Error(
      `${what}: the service account JSON key must include client_email and private_key.`,
    );
  }
  return {
    credentials: obj,
    client_email,
    private_key,
    project_id: typeof project_id === "string" ? project_id : undefined,
  };
}
