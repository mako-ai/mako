import { describe, it, expect } from "vitest";
import {
  computeEntityPendingBacklog,
  computeEntitySeqGap,
  computePendingLagSeconds,
} from "./backlog";

describe("CDC pending backlog (recover cursor-gap inflation)", () => {
  it("uses real pending count only — not ingest/materialized seq gap", () => {
    // Recover rewound lastMaterializedSeq under an orphan at seq ~110k while
    // head is ~800k; only a couple thousand rows are actually pending.
    const realPending = 2_400;
    const seqGap = computeEntitySeqGap(800_000, 109_999);
    expect(seqGap).toBe(690_001);
    expect(computeEntityPendingBacklog(realPending)).toBe(2_400);
    expect(computeEntityPendingBacklog(realPending)).not.toBe(seqGap);
  });

  it("treats zero / negative pending as empty backlog", () => {
    expect(computeEntityPendingBacklog(0)).toBe(0);
    expect(computeEntityPendingBacklog(-1)).toBe(0);
  });

  it("does not invent lag from a seq gap when nothing is pending", () => {
    expect(
      computePendingLagSeconds({
        pendingCount: 0,
        oldestPendingTs: new Date(Date.now() - 978 * 3600 * 1000),
      }),
    ).toBe(0);
  });

  it("reports lag from the oldest real pending ingestTs", () => {
    const nowMs = Date.parse("2026-08-12T08:00:00.000Z");
    const oldest = new Date(nowMs - 3_600_000);
    expect(
      computePendingLagSeconds({
        pendingCount: 12,
        oldestPendingTs: oldest,
        nowMs,
      }),
    ).toBe(3600);
  });
});
