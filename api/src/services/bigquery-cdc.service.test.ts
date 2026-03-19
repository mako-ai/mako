import {
  mapBackfillRecordsToChanges,
  sanitizeBackfillPayloadForIdempotency,
} from "./bigquery-cdc.service";

describe("sanitizeBackfillPayloadForIdempotency", () => {
  it("removes volatile sync metadata fields recursively", () => {
    const sanitized = sanitizeBackfillPayloadForIdempotency({
      id: "abc",
      _syncedAt: "2026-03-01T00:00:00.000Z",
      _mako_source_ts: "2026-03-01T00:00:01.000Z",
      nested: {
        keep: "value",
        _mako_ingest_seq: 123,
      },
      list: [
        {
          keep: true,
          _mako_run_id: "run-1",
        },
      ],
    });

    expect(sanitized).toEqual({
      id: "abc",
      nested: {
        keep: "value",
      },
      list: [
        {
          keep: true,
        },
      ],
    });
  });
});

describe("mapBackfillRecordsToChanges", () => {
  it("builds stable idempotency keys when only volatile fields change", async () => {
    const first = await mapBackfillRecordsToChanges({
      entity: "contacts",
      runId: "run-a",
      records: [
        {
          id: "c_1",
          name: "Jonas",
          _syncedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    });
    const second = await mapBackfillRecordsToChanges({
      entity: "contacts",
      runId: "run-b",
      records: [
        {
          id: "c_1",
          name: "Jonas",
          _syncedAt: "2026-03-02T11:59:59.000Z",
        },
      ],
    });

    const firstChange = first[0]!;
    const secondChange = second[0]!;

    expect(firstChange.idempotencyKey).toBe(secondChange.idempotencyKey);
    expect(firstChange.sourceTs?.toISOString()).toBe(
      secondChange.sourceTs?.toISOString(),
    );
  });

  it("uses deterministic fallback id/sourceTs when source record has no identifiers", async () => {
    const [a] = await mapBackfillRecordsToChanges({
      entity: "opportunities",
      records: [{ status: "open", amount: 100 }],
    });
    const [b] = await mapBackfillRecordsToChanges({
      entity: "opportunities",
      records: [{ status: "open", amount: 100, _syncedAt: new Date().toISOString() }],
    });

    expect(a.recordId).toBe(b.recordId);
    expect(a.recordId.startsWith("missing-id:")).toBe(true);
    expect(a.sourceTs?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(b.sourceTs?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });
});
