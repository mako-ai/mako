import { matchesStripePaymentMethodEventTime } from "./stripe/webhook-clock";

const authorizers = new Map([
  ["stripe", matchesStripePaymentMethodEventTime],
  ["ws:stripe", matchesStripePaymentMethodEventTime],
]);

export function acceptsProviderEventTime(
  sourceType: string | undefined,
  ...input: Parameters<typeof matchesStripePaymentMethodEventTime>
): boolean {
  return authorizers.get(sourceType ?? "")?.(...input) ?? false;
}
