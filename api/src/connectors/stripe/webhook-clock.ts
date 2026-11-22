const paymentMethodEvents = new Set([
  "payment_method.attached",
  "payment_method.detached",
  "payment_method.updated",
  "payment_method.automatically_updated",
]);

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function matchesStripePaymentMethodEventTime(
  event: { eventId: string; eventType?: string; rawPayload?: unknown },
  record: {
    entity: string;
    operation: string;
    recordId: string;
    sourceTs: Date;
  },
): boolean {
  if (
    record.entity !== "payment_methods" ||
    record.operation !== "upsert" ||
    !event.eventType ||
    !paymentMethodEvents.has(event.eventType)
  ) {
    return false;
  }

  const raw = asObject(event.rawPayload);
  if (
    raw?.object !== "event" ||
    raw.id !== event.eventId ||
    raw.type !== event.eventType
  ) {
    return false;
  }

  const object = asObject(asObject(raw.data)?.object);
  const related = asObject(raw.related_object);
  const created = raw.created;
  return (
    (object?.id ?? related?.id) === record.recordId &&
    typeof created === "number" &&
    Number.isSafeInteger(created) &&
    created > 0 &&
    created <= 253_402_300_799 &&
    record.sourceTs.getTime() === created * 1000
  );
}
