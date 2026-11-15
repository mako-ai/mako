/**
 * The Wise HTTP layer: base URL (production or sandbox), the bearer-token
 * client, readable API errors, and strong customer authentication (SCA) —
 * answering a 403 `x-2fa-approval` challenge with a signature from the
 * connection's private key.
 */
import crypto from "node:crypto";
import axios, { AxiosInstance } from "axios";
import {
  formatHttpApiError,
  headerValue,
  resolveConfiguredBaseUrl,
  type HeaderBag,
  type RetryExecutor,
} from "../base/http-client";

export const WISE_DEFAULT_BASE_URL = "https://api.wise.com";

const SANDBOX_HOST_MARKERS = [
  "sandbox.transferwise.tech",
  "api.sandbox.transferwise",
  "sandbox.wise.com",
];

type WiseErrorBody = {
  error?: string;
  error_description?: string;
  message?: string;
  errors?: Array<{ code?: string; message?: string }>;
};

function describeWiseErrorBody(raw: unknown): string | undefined {
  const data = raw as WiseErrorBody | string | undefined;
  const direct =
    typeof data === "string"
      ? data
      : typeof data?.error_description === "string"
        ? data.error_description
        : typeof data?.message === "string"
          ? data.message
          : typeof data?.error === "string"
            ? data.error
            : undefined;

  const nested = Array.isArray((data as { errors?: unknown[] })?.errors)
    ? (data as Required<Pick<WiseErrorBody, "errors">>).errors
        .map(e => `${e.code ?? "?"}: ${e.message ?? "?"}`)
        .join("; ")
    : undefined;

  return [direct, nested].filter(Boolean).join(" — ");
}

export function formatWiseApiError(error: unknown): string {
  return formatHttpApiError(error, describeWiseErrorBody);
}

export function resolveWiseBaseUrl(configured: unknown): string {
  return resolveConfiguredBaseUrl(configured, WISE_DEFAULT_BASE_URL);
}

export function isWiseSandboxBaseUrl(baseUrl: string): boolean {
  const base = baseUrl.toLowerCase();
  return SANDBOX_HOST_MARKERS.some(marker => base.includes(marker));
}

export function createWiseClient(
  baseURL: string,
  token: string,
): AxiosInstance {
  return axios.create({
    baseURL,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

/**
 * A PEM key as pasted into a single-line secret field: line breaks become
 * spaces, vanish, or arrive as literal "\n". Rebuild the PEM (header, base64
 * body in 64-character lines, footer) so node's crypto can read it.
 */
export function normalizePemKey(raw: string): string {
  const text = raw.replace(/\\n/g, "\n").trim();
  const match = text.match(
    /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/,
  );
  if (!match) return text;
  const body = match[2].replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return (
    [`-----BEGIN ${match[1]}-----`, ...lines, `-----END ${match[1]}-----`].join(
      "\n",
    ) + "\n"
  );
}

/** SHA-256 of a private key's public half (DER), hex: identifies the key, reveals nothing. */
export function publicKeyFingerprint(privatePem: string): string {
  const der = crypto
    .createPublicKey(privatePem)
    .export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export interface ScaMessages {
  /** A 403 that carries no challenge: nothing Mako can sign. */
  noChallenge: string;
  /** A challenge, but no private key on the connection to sign it with. */
  noKey: string;
}

/**
 * Send a request, answering Wise's strong customer authentication: a 403
 * carrying `x-2fa-approval` is retried once with that one-time token signed
 * (SHA256withRSA) by `privateKey`. `messages` explain the two refusals Mako
 * cannot answer itself (no challenge to sign, no key to sign with).
 */
export async function sendWithSca<T>(
  execute: RetryExecutor,
  privateKey: unknown,
  send: (headers?: Record<string, string>) => Promise<T>,
  messages: ScaMessages,
): Promise<T> {
  try {
    return await execute(() => send());
  } catch (error) {
    const response = axios.isAxiosError(error) ? error.response : undefined;
    const approval =
      response?.status === 403
        ? headerValue((response.headers ?? {}) as HeaderBag, "x-2fa-approval")
        : undefined;
    if (!approval) {
      if (response?.status === 403) {
        throw new Error(messages.noChallenge, { cause: error });
      }
      throw error;
    }

    if (typeof privateKey !== "string" || privateKey.trim().length === 0) {
      throw new Error(messages.noKey, { cause: error });
    }
    const pem = normalizePemKey(privateKey);
    const signature = crypto
      .createSign("SHA256")
      .update(approval)
      .sign(pem, "base64");
    try {
      return await execute(() =>
        send({ "x-2fa-approval": approval, "X-Signature": signature }),
      );
    } catch (signedError) {
      // Wise says why it refused a signed request in x-2fa-approval-result;
      // the key's fingerprint (SHA-256 of its public key, never the key)
      // tells which key signed, to compare with the one registered in Wise
      const signedResponse = axios.isAxiosError(signedError)
        ? signedError.response
        : undefined;
      const result = headerValue(
        (signedResponse?.headers ?? {}) as HeaderBag,
        "x-2fa-approval-result",
      );
      const body =
        typeof signedResponse?.data === "string"
          ? signedResponse.data
          : JSON.stringify(signedResponse?.data ?? "");
      throw new Error(
        `Wise refused the signed (SCA) request: HTTP ${signedResponse?.status ?? "?"}` +
          `, x-2fa-approval-result: ${result ?? "none"}` +
          `, signed with key ${publicKeyFingerprint(pem)}` +
          (body && body !== '""' ? `, body: ${body.slice(0, 300)}` : ""),
        { cause: signedError },
      );
    }
  }
}
