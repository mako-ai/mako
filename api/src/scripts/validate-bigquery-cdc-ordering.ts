import { selectLatestChangePerRecord } from "../services/bigquery-cdc.service";

type Change = {
  recordId: string;
  sourceTs: string;
  ingestSeq: number;
  op: "upsert" | "delete";
  source: "webhook" | "backfill";
};

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function runScenarios() {
  // Scenario 1: delete-before-backfill-row (delete must win)
  const scenario1: Change[] = [
    {
      recordId: "1",
      sourceTs: "2026-03-01T10:00:00.000Z",
      ingestSeq: 20,
      op: "delete",
      source: "webhook",
    },
    {
      recordId: "1",
      sourceTs: "2026-03-01T09:00:00.000Z",
      ingestSeq: 21,
      op: "upsert",
      source: "backfill",
    },
  ];
  const winner1 = selectLatestChangePerRecord(scenario1)[0];
  assert(
    winner1.op === "delete" && winner1.source === "webhook",
    "Scenario 1 failed: stale backfill resurrected deleted row",
  );

  // Scenario 2: stale backfill update vs newer webhook update (webhook must win)
  const scenario2: Change[] = [
    {
      recordId: "2",
      sourceTs: "2026-03-01T11:00:00.000Z",
      ingestSeq: 40,
      op: "upsert",
      source: "backfill",
    },
    {
      recordId: "2",
      sourceTs: "2026-03-01T12:00:00.000Z",
      ingestSeq: 41,
      op: "upsert",
      source: "webhook",
    },
  ];
  const winner2 = selectLatestChangePerRecord(scenario2)[0];
  assert(
    winner2.source === "webhook",
    "Scenario 2 failed: stale backfill overwrote newer webhook",
  );

  // Scenario 3: duplicate webhook deliveries (higher ingestSeq tie-break)
  const scenario3: Change[] = [
    {
      recordId: "3",
      sourceTs: "2026-03-01T13:00:00.000Z",
      ingestSeq: 50,
      op: "upsert",
      source: "webhook",
    },
    {
      recordId: "3",
      sourceTs: "2026-03-01T13:00:00.000Z",
      ingestSeq: 51,
      op: "upsert",
      source: "webhook",
    },
  ];
  const winner3 = selectLatestChangePerRecord(scenario3)[0];
  assert(
    winner3.ingestSeq === 51,
    "Scenario 3 failed: tie-break by ingestSeq did not hold",
  );

  // Scenario 4: retriggered backfill with older rows (should not override newer state)
  const scenario4: Change[] = [
    {
      recordId: "4",
      sourceTs: "2026-03-03T10:00:00.000Z",
      ingestSeq: 90,
      op: "upsert",
      source: "webhook",
    },
    {
      recordId: "4",
      sourceTs: "2026-02-25T10:00:00.000Z",
      ingestSeq: 120,
      op: "upsert",
      source: "backfill",
    },
  ];
  const winner4 = selectLatestChangePerRecord(scenario4)[0];
  assert(
    winner4.source === "webhook",
    "Scenario 4 failed: retriggered backfill overrode newer state",
  );

  process.stdout.write("BigQuery CDC ordering scenarios: PASS\n");
}

runScenarios();
