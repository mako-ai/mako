/**
 * First-party signup attribution.
 *
 * The marketing site (mako.ai) records the visitor's first/last marketing
 * touch (landing page, referrer, UTMs, ad click IDs, device context) in a
 * `mako_attr` cookie on the `.mako.ai` parent domain. Because the app is
 * served same-origin at app.mako.ai, that cookie arrives with the signup
 * request — both the email-register POST and the OAuth callback navigations.
 *
 * At account creation we persist it once into `user_attributions` (keyed by
 * user id, write-once via $setOnInsert) so acquisition context can be joined
 * against product usage without relying on third-party analytics cookies.
 *
 * Privacy: no IP address is stored; the cookie only carries what the browser
 * already sent. Values are whitelisted and truncated before persisting.
 */
import { UserAttribution } from "../database/schema";
import { loggers } from "../logging";

const logger = loggers.auth();

export const ATTRIBUTION_COOKIE = "mako_attr";

const MAX_RAW_COOKIE_BYTES = 8 * 1024;
const SUPPORTED_VERSION = 1;

const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

const CLICK_ID_KEYS = [
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "ttclid",
  "li_fat_id",
  "twclid",
] as const;

export interface AttributionTouch {
  ts?: string;
  landing_page?: string;
  referrer?: string;
  utm?: Partial<Record<(typeof UTM_KEYS)[number], string>>;
  click_ids?: Partial<Record<(typeof CLICK_ID_KEYS)[number], string>>;
  user_agent?: string;
  screen?: string;
  viewport?: string;
  language?: string;
  timezone?: string;
}

export interface ParsedAttribution {
  sid?: string;
  first: AttributionTouch;
  last: AttributionTouch;
  /** Denormalized for indexed lookups: last-touch gclid, else first-touch. */
  gclid?: string;
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, max)
    : undefined;
}

/**
 * Whitelist-copy one touch. Only known keys survive (this also neutralizes
 * `$`/dotted keys a crafted cookie could try to smuggle into MongoDB).
 */
function sanitizeTouch(raw: unknown): AttributionTouch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const touch: AttributionTouch = {
    ts: str(t.ts, 32),
    landing_page: str(t.landing_page, 512),
    referrer: str(t.referrer, 512),
    user_agent: str(t.user_agent, 256),
    screen: str(t.screen, 16),
    viewport: str(t.viewport, 16),
    language: str(t.language, 16),
    timezone: str(t.timezone, 64),
  };
  const utmRaw = (t.utm ?? {}) as Record<string, unknown>;
  const utm: AttributionTouch["utm"] = {};
  for (const k of UTM_KEYS) {
    const v = str(utmRaw[k], 128);
    if (v) utm[k] = v;
  }
  if (Object.keys(utm).length) touch.utm = utm;

  const idsRaw = (t.click_ids ?? {}) as Record<string, unknown>;
  const clickIds: AttributionTouch["click_ids"] = {};
  for (const k of CLICK_ID_KEYS) {
    const v = str(idsRaw[k], 256);
    if (v) clickIds[k] = v;
  }
  if (Object.keys(clickIds).length) touch.click_ids = clickIds;

  return touch;
}

/** Parse + sanitize the raw cookie value. Returns null when absent/invalid. */
export function parseAttributionCookieValue(
  raw: string | undefined,
): ParsedAttribution | null {
  if (!raw || raw.length > MAX_RAW_COOKIE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const cookie = parsed as Record<string, unknown>;
  if (cookie.v !== SUPPORTED_VERSION) return null;

  const first = sanitizeTouch(cookie.first);
  const last = sanitizeTouch(cookie.last) ?? first;
  if (!first || !last) return null;

  return {
    sid: str(cookie.sid, 64),
    first,
    last,
    gclid: last.click_ids?.gclid ?? first.click_ids?.gclid,
  };
}

/** Request-derived context the auth controller forwards into the service. */
export interface SignupContext {
  /** Raw value of the `mako_attr` cookie from the signup request, if any. */
  attributionCookie?: string;
  /** ISO 3166-1 alpha-2 country from an edge header, if available. */
  country?: string;
}

/**
 * Persist attribution for a newly created user. Write-once (`$setOnInsert`):
 * repeat calls for the same user are no-ops. Never throws — attribution must
 * never break signup.
 */
export async function captureSignupAttribution(
  options: SignupContext & {
    userId: string;
    signupMethod: "email" | "google" | "github";
  },
): Promise<void> {
  try {
    const parsed = parseAttributionCookieValue(options.attributionCookie);
    if (!parsed) return;

    await UserAttribution.updateOne(
      { _id: options.userId },
      {
        $setOnInsert: {
          _id: options.userId,
          sid: parsed.sid,
          gclid: parsed.gclid,
          signupMethod: options.signupMethod,
          country: str(options.country, 2),
          firstTouch: parsed.first,
          lastTouch: parsed.last,
          capturedAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    logger.warn("Failed to persist signup attribution", {
      userId: options.userId,
      error,
    });
  }
}
