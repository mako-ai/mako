/**
 * Analytics utility for GTM dataLayer-based event tracking.
 * All events are pushed to window.dataLayer for GTM to handle distribution
 * to GA4, PostHog, and other configured destinations.
 */

// Marketing events - sent to GA4 + Google Ads for attribution and conversions
type MarketingEvent =
  | "page_view"
  | "sign_up"
  | "login"
  | "database_connection_created"
  | "connector_created"
  | "invite_sent"
  | "invite_accepted"
  | "workspace_created"
  | "onboarding_completed"
  | "email_verified";

// Product events - sent to PostHog via GTM for product analytics
type ProductEvent =
  | "query_executed"
  | "console_saved"
  | "flow_created"
  | "ai_chat_message_sent"
  | "api_key_created"
  | "password_reset_requested"
  | "logout";

export type AnalyticsEvent = MarketingEvent | ProductEvent;

/**
 * Push an event to the GTM dataLayer.
 * GTM will handle routing to appropriate destinations (GA4, PostHog, etc.)
 */
export function trackEvent(
  event: AnalyticsEvent,
  properties?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;

  // Ensure dataLayer exists
  window.dataLayer = window.dataLayer || [];

  window.dataLayer.push({
    event,
    ...properties,
    // Add timestamp for all events
    event_timestamp: new Date().toISOString(),
  });
}

/**
 * Track a page view event for SPA navigation.
 * Should be called on route changes.
 */
export function trackPageView(path: string, title: string): void {
  trackEvent("page_view", {
    page_path: path,
    page_title: title,
    page_referrer: document.referrer || undefined,
  });
}

/**
 * Identify a user for analytics purposes.
 * Pushes user traits to dataLayer for GTM to forward to destinations.
 */
export function identify(
  userId: string,
  traits?: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;

  window.dataLayer = window.dataLayer || [];

  window.dataLayer.push({
    event: "identify",
    user_id: userId,
    ...traits,
  });
}

/**
 * Reset/clear user identification (e.g., on logout).
 */
export function resetIdentity(): void {
  if (typeof window === "undefined") return;

  window.dataLayer = window.dataLayer || [];

  window.dataLayer.push({
    event: "reset_identity",
    user_id: null,
  });
}
