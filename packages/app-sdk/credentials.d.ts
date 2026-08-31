export const CREDENTIALS_PATH: string;

export interface StoredCredential {
  apiUrl: string;
  workspaceId: string | null;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** ISO timestamp. */
  expiresAt?: string;
  scopes?: string[];
  savedAt?: string;
}

export function normalizeApiUrl(url: string): string;
export function credentialKey(apiUrl: string, workspaceId?: string | null): string;
export function readCredentialStore(file?: string): Record<string, StoredCredential>;
export function writeCredentialStore(store: Record<string, StoredCredential>, file?: string): void;
export function findCredential(
  apiUrl: string,
  workspaceId?: string | null,
  store?: Record<string, StoredCredential>,
): StoredCredential | null;
export function saveCredential(
  apiUrl: string,
  workspaceId: string | null,
  entry: Omit<StoredCredential, "apiUrl" | "workspaceId" | "savedAt">,
  file?: string,
): void;
export function removeCredential(apiUrl: string, workspaceId?: string | null, file?: string): boolean;
export function refreshCredential(
  entry: StoredCredential,
  fetchImpl?: typeof fetch,
): Promise<StoredCredential>;
export function getAccessToken(
  apiUrl: string,
  workspaceId?: string | null,
  options?: { file?: string; fetch?: typeof fetch },
): Promise<string | null>;
