/**
 * The Calendly HTTP layer and record helpers: bearer client, readable API
 * errors, URI → id, list pages, and same-origin path resolution.
 */
import axios, { AxiosInstance } from "axios";
import {
  clampPageSize,
  formatHttpApiError,
  resolveConfiguredBaseUrl,
  type RetryExecutor,
} from "../base/http-client";

export const CALENDLY_DEFAULT_BASE_URL = "https://api.calendly.com";
export const CALENDLY_MAX_PAGE_LIMIT = 100;

export type CalendlyListResponse<T = Record<string, unknown>> = {
  collection: T[];
  pagination: {
    next_page_token?: string | null;
    count?: number;
  };
};

/** What the Calendly fetch and webhook modules read from the connector. */
export interface CalendlyContext {
  api(): AxiosInstance;
  execute: RetryExecutor;
  sleep(ms: number): Promise<void>;
  /** The connection's sync batch size setting. */
  batchSize(): number;
  /** The connection's rate-limit delay setting. */
  rateLimitDelay(): number;
  baseUrl(): string;
  /** The token's user and organization URIs (cached). */
  currentUser(): Promise<{ user_uri: string; organization_uri: string }>;
}

export function resolveCalendlyBaseUrl(configured: unknown): string {
  return resolveConfiguredBaseUrl(configured, CALENDLY_DEFAULT_BASE_URL);
}

export function createCalendlyClient(
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
 * The path of an API-returned URI, refusing any URI outside the configured
 * base so the token is never sent to another host.
 */
export function calendlyRelativePath(
  ctx: CalendlyContext,
  uri: string,
): string {
  const base = ctx.baseUrl();
  if (!uri.startsWith(`${base}/`)) {
    throw new Error(
      `Refusing to call non-Calendly URL returned by API (expected base ${base})`,
    );
  }
  return uri.slice(base.length);
}

// Calendly requires count in [1, 100]; a 0 batch size falls back.
export function calendlyPageCount(
  ctx: CalendlyContext,
  batchSize?: number,
): number {
  return clampPageSize(batchSize, ctx.batchSize(), CALENDLY_MAX_PAGE_LIMIT);
}

/** One list page; undefined/null params are left out. */
export async function fetchCalendlyPage<T = Record<string, unknown>>(
  ctx: CalendlyContext,
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<CalendlyListResponse<T>> {
  const api = ctx.api();
  const cleaned: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    cleaned[key] = value;
  }
  const response = await ctx.execute(() => api.get(path, { params: cleaned }));
  const data = response.data as Partial<CalendlyListResponse<T>>;
  return {
    collection: Array.isArray(data.collection) ? data.collection : [],
    pagination: data.pagination ?? {},
  };
}

export function uuidFromUri(uri: unknown): string {
  if (typeof uri !== "string" || uri.length === 0) return "";
  const trimmed = uri.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** A record keyed by its URI's last segment when it has no `id`. */
export function withId(
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (record == null) return record;
  if (typeof record.id === "string" && record.id.length > 0) return record;
  const id = uuidFromUri(record.uri);
  return id ? { ...record, id } : record;
}

/** An organization membership with its embedded user flattened. */
export function flattenMembership(
  membership: Record<string, unknown>,
): Record<string, unknown> {
  const user =
    membership.user && typeof membership.user === "object"
      ? (membership.user as Record<string, unknown>)
      : undefined;
  return withId({
    ...membership,
    user_uri: user?.uri ?? null,
    user_email: user?.email ?? null,
    user_name: user?.name ?? null,
    user_slug: user?.slug ?? null,
    user_timezone: user?.timezone ?? null,
    user_scheduling_url: user?.scheduling_url ?? null,
    user_avatar_url: user?.avatar_url ?? null,
    user_locale: user?.locale ?? null,
  });
}

type CalendlyErrorBody = {
  message?: string;
  title?: string;
  details?: Array<{ message?: string; parameter?: string }>;
};

function describeCalendlyErrorBody(raw: unknown): string | undefined {
  const data = raw as CalendlyErrorBody | string | undefined;

  const direct =
    typeof data === "string"
      ? data
      : typeof data?.message === "string"
        ? data.message
        : typeof data?.title === "string"
          ? data.title
          : undefined;

  const details = Array.isArray((data as { details?: unknown[] })?.details)
    ? (data as Required<Pick<CalendlyErrorBody, "details">>).details
        .map(d => `${d.parameter ?? "?"}: ${d.message ?? "?"}`)
        .join("; ")
    : undefined;

  return [direct, details].filter(Boolean).join(" — ");
}

export function formatCalendlyApiError(error: unknown): string {
  return formatHttpApiError(error, describeCalendlyErrorBody);
}
