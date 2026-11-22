// Roll this contract out only where queue and destination both honor it.
const bigQueryProviderEventEntities = new Map([
  ["stripe", "payment_methods"],
  ["ws:stripe", "payment_methods"],
]);

export function allowsProviderEventTime(input: {
  sourceType?: string;
  destinationType?: string;
  entity: string;
  operation: "upsert" | "delete";
}): boolean {
  return (
    input.destinationType === "bigquery" &&
    input.operation === "upsert" &&
    bigQueryProviderEventEntities.get(input.sourceType ?? "") === input.entity
  );
}
