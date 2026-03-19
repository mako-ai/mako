import * as crypto from "crypto";
import { z } from "zod";

export const cdcOperationSchema = z.enum(["upsert", "delete"]);
export const cdcSourceSchema = z.enum(["webhook", "backfill"]);

export const normalizedCdcEventSchema = z.object({
  entity: z.string().min(1),
  recordId: z.string().min(1),
  operation: cdcOperationSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
  sourceTs: z.date(),
  source: cdcSourceSchema,
  changeId: z.string().optional(),
  runId: z.string().optional(),
});

export type CdcOperation = z.infer<typeof cdcOperationSchema>;
export type CdcSource = z.infer<typeof cdcSourceSchema>;
export type NormalizedCdcEvent = z.infer<typeof normalizedCdcEventSchema>;

export function normalizeCdcEvent(
  candidate: Omit<NormalizedCdcEvent, "sourceTs"> & { sourceTs?: Date | string },
): NormalizedCdcEvent {
  const sourceTs =
    candidate.sourceTs instanceof Date
      ? candidate.sourceTs
      : new Date(candidate.sourceTs || Date.now());

  const parsed = normalizedCdcEventSchema.parse({
    ...candidate,
    sourceTs,
  });

  return parsed;
}

export function buildCdcIdempotencyKey(event: NormalizedCdcEvent): string {
  const payloadHash = crypto
    .createHash("sha1")
    .update(JSON.stringify(event.payload || {}))
    .digest("hex");

  return [
    event.source,
    event.entity,
    event.recordId,
    event.operation,
    event.sourceTs.toISOString(),
    payloadHash,
  ].join(":");
}
