/**
 * Centralized handling for `401 Unauthorized` responses from the API.
 *
 * A naive client redirects to `/login` on the first 401 it sees. During a
 * rolling deploy, in-flight requests can briefly hit a starting/draining
 * instance (or a momentarily unreachable database) and come back 401/5xx even
 * though the user's session is still valid. That bounced users to `/login` on
 * essentially every deploy.
 *
 * Instead we verify the session against `/auth/me` (with a short retry/backoff
 * to ride out the deploy window) before deciding. We only redirect when the
 * server gives a definitive 401 for `/auth/me` — a genuinely dead session.
 * Transient/indeterminate failures are swallowed so the user stays put and the
 * next request succeeds once the new revision is serving.
 */
import { getApiBasePath } from "./api-base-path";

const LOGIN_PATH = "/login";
const AUTH_PAGES = new Set([LOGIN_PATH, "/register"]);

/** Total `/auth/me` probe attempts before giving up (treating as transient). */
const VERIFY_MAX_ATTEMPTS = 3;
/** Backoff between probe attempts; index N is the wait after attempt N. */
const VERIFY_BACKOFF_MS = [300, 800];

let isRedirectingToLogin = false;
let inFlightVerification: Promise<void> | null = null;

function authMeUrl(): string {
  const basePath = getApiBasePath(import.meta.env.VITE_API_URL);
  const path = "/auth/me";
  return basePath === "/" ? path : `${basePath}${path}`;
}

function onAuthPage(): boolean {
  if (typeof window === "undefined") return false;
  return AUTH_PAGES.has(window.location.pathname);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clearActiveWorkspace(): void {
  try {
    localStorage.removeItem("activeWorkspaceId");
  } catch {
    // ignore storage failures (private mode / SSR)
  }
}

function redirectToLogin(): void {
  if (typeof window === "undefined" || isRedirectingToLogin || onAuthPage()) {
    return;
  }
  isRedirectingToLogin = true;
  clearActiveWorkspace();
  window.location.href = LOGIN_PATH;
}

/**
 * Probe `/auth/me` to decide whether the session is actually gone.
 *
 * @returns `true` when alive, `false` when the server returns a definitive
 *   401, `null` when undetermined after retries (network/5xx — treated as a
 *   transient deploy blip, so we do not log the user out).
 */
async function probeSession(): Promise<boolean | null> {
  for (let attempt = 0; attempt < VERIFY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(authMeUrl(), {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
      if (res.status === 401) return false;
      if (res.ok) return true;
      // Other statuses (502/503/504/etc.) are likely a deploy blip — retry.
    } catch {
      // Network error — likely a deploy blip — retry.
    }
    const backoff = VERIFY_BACKOFF_MS[attempt];
    if (backoff !== undefined) await delay(backoff);
  }
  return null;
}

/**
 * Call when an authenticated request returns `401`. Verifies the session via
 * `/auth/me` before redirecting to `/login`; concurrent 401s share a single
 * verification so we never fire more than one probe at a time. Returns a
 * promise that resolves once the decision (redirect or stay) has been made.
 */
export function handleUnauthorized(): Promise<void> {
  if (typeof window === "undefined" || isRedirectingToLogin || onAuthPage()) {
    return Promise.resolve();
  }
  if (inFlightVerification) return inFlightVerification;

  inFlightVerification = probeSession()
    .then(alive => {
      if (alive === false) redirectToLogin();
    })
    .finally(() => {
      inFlightVerification = null;
    });

  return inFlightVerification;
}

/** Test-only: reset module-level state between cases. */
export function __resetAuthRedirectState(): void {
  isRedirectingToLogin = false;
  inFlightVerification = null;
}
