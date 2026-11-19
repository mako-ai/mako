import type {
  DeleteWebhookSubscriptionOptions,
  PauseWebhookSubscriptionOptions,
  ProvisionWebhookOptions,
  ProvisionWebhookResult,
  UpdateWebhookSubscriptionOptions,
} from "../connectors/base/BaseConnector";

export interface WebhookProvisioner {
  /** Create the subscription (or adopt one already on the URL). */
  create(options: ProvisionWebhookOptions): Promise<ProvisionWebhookResult>;
  /** Adopt the subscription on the URL and set its events; null when none. */
  update(
    options: UpdateWebhookSubscriptionOptions,
  ): Promise<ProvisionWebhookResult | null>;
  /** Remove every subscription on the URL; only where `canDelete`. */
  delete?(options: DeleteWebhookSubscriptionOptions): Promise<number>;
  /**
   * Pause or resume the subscription(s) on the URL; how many changed.
   * Absent: the vendor's subscriptions cannot be paused from here.
   */
  setPaused?(options: PauseWebhookSubscriptionOptions): Promise<number>;
}
