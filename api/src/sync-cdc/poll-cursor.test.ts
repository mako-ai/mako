/**
 * The incremental poll cursor (sync-cdc/poll-cursor.ts).
 *
 * The first half tests the decision functions. The second half replays the
 * two data-loss cases end to end against a small in-memory source and live
 * table: the old cursor (MAX(_syncedAt) of live) loses the change, the poll
 * cursor reads it. The live table merges like the CDC adapters: keyed on the
 * record id, newer `_mako_source_ts` wins.
 *
 * Run: npx tsx src/sync-cdc/poll-cursor.test.ts
 */
import assert from "node:assert/strict";

import {
  decidePollSince,
  DEFAULT_POLL_OVERLAP_MS,
  destinationFallbackSince,
  pollOverlapMsFromEnv,
} from "./poll-cursor";

const at = (iso: string) => new Date(`2026-11-17T${iso}Z`);
const MIN = 60_000;

// ── Overlap config ───────────────────────────────────────────────────
assert.equal(DEFAULT_POLL_OVERLAP_MS, 10 * MIN);
assert.equal(pollOverlapMsFromEnv({}), 10 * MIN);
assert.equal(
  pollOverlapMsFromEnv({ CDC_POLL_CURSOR_OVERLAP_MINUTES: "15" }),
  15 * MIN,
);
assert.equal(pollOverlapMsFromEnv({ CDC_POLL_CURSOR_OVERLAP_MINUTES: "0" }), 0);
assert.equal(
  pollOverlapMsFromEnv({ CDC_POLL_CURSOR_OVERLAP_MINUTES: "nope" }),
  10 * MIN,
);
assert.equal(
  pollOverlapMsFromEnv({ CDC_POLL_CURSOR_OVERLAP_MINUTES: "-5" }),
  10 * MIN,
);

// ── decidePollSince ──────────────────────────────────────────────────
assert.equal(
  decidePollSince({ runStartedAt: at("15:00:00"), overlapMs: 10 * MIN }),
  null,
  "no stamp on record → destination fallback",
);
{
  const d = decidePollSince({
    lastPollRunStartedAt: at("14:00:00"),
    runStartedAt: at("15:00:00"),
    overlapMs: 10 * MIN,
  });
  assert.equal(d?.since.toISOString(), at("13:50:00").toISOString());
  assert.equal(d?.anchorKind, "poll");
}
{
  // A backfill that started after the last poll is the later guarantee.
  const d = decidePollSince({
    lastPollRunStartedAt: at("12:00:00"),
    lastBackfillRunStartedAt: at("14:30:00"),
    runStartedAt: at("15:00:00"),
    overlapMs: 10 * MIN,
  });
  assert.equal(d?.since.toISOString(), at("14:20:00").toISOString());
  assert.equal(d?.anchorKind, "backfill");
}
{
  // A stamp later than this run's start is ignored (clock trouble).
  const d = decidePollSince({
    lastPollRunStartedAt: at("16:00:00"),
    lastBackfillRunStartedAt: at("11:00:00"),
    runStartedAt: at("15:00:00"),
    overlapMs: 10 * MIN,
  });
  assert.equal(d?.since.toISOString(), at("10:50:00").toISOString());
}

// ── destinationFallbackSince ─────────────────────────────────────────
assert.deepEqual(
  destinationFallbackSince({
    maxSourceTs: at("14:58:00"),
    maxSyncedAt: at("14:59:30"),
    overlapMs: 10 * MIN,
  }),
  { since: at("14:48:00"), column: "_mako_source_ts" },
);
assert.deepEqual(
  destinationFallbackSince({
    maxSourceTs: null,
    maxSyncedAt: "2026-11-17T14:59:30.000Z",
    overlapMs: 10 * MIN,
  }),
  { since: at("14:49:30"), column: "_syncedAt" },
  "NULL _mako_source_ts → today's anchor minus the overlap",
);
assert.equal(
  destinationFallbackSince({ overlapMs: 10 * MIN }),
  null,
  "empty table → full first read",
);

// ── End-to-end replay ────────────────────────────────────────────────

type SourceRecord = { id: string; updatedAt: Date; value: string };
type LiveRow = {
  id: string;
  value: string;
  _mako_source_ts: Date;
  _syncedAt: Date;
};

class World {
  source = new Map<string, SourceRecord>();
  /** An array, so a merge that appended instead of upserting would show. */
  live: LiveRow[] = [];
  /** CdcEntityState.lastPollRunStartedAt of the one entity. */
  lastPollRunStartedAt: Date | undefined;

  update(id: string, updatedAt: Date, value: string) {
    this.source.set(id, { id, updatedAt, value });
  }

  /** CDC merge: keyed on id, newer `_mako_source_ts` wins. */
  merge(record: SourceRecord, now: Date) {
    const row: LiveRow = {
      id: record.id,
      value: record.value,
      _mako_source_ts: record.updatedAt,
      _syncedAt: now,
    };
    const i = this.live.findIndex(r => r.id === record.id);
    if (i === -1) this.live.push(row);
    else if (row._mako_source_ts >= this.live[i]._mako_source_ts) {
      this.live[i] = row;
    }
  }

  webhook(id: string, now: Date) {
    this.merge(this.source.get(id)!, now);
  }

  /** The cursor this change removes: MAX(_syncedAt) of live. */
  oldSince(): Date | undefined {
    if (this.live.length === 0) return undefined;
    return new Date(Math.max(...this.live.map(r => r._syncedAt.getTime())));
  }

  newSince(runStartedAt: Date): Date | undefined {
    const d = decidePollSince({
      lastPollRunStartedAt: this.lastPollRunStartedAt,
      runStartedAt,
      overlapMs: 10 * MIN,
    });
    if (d) return d.since;
    const maxTs = this.live.length
      ? new Date(Math.max(...this.live.map(r => r._mako_source_ts.getTime())))
      : undefined;
    return destinationFallbackSince({ maxSourceTs: maxTs, overlapMs: 10 * MIN })
      ?.since;
  }

  /**
   * One poll run. It lists the ids updated since `since` when it starts
   * (newest first, like Close), then reads one record per page, one minute
   * apart. `between(page, now)` runs before each page: source changes that
   * land while the poll is running.
   */
  poll(
    cursor: "old" | "new",
    runStartedAt: Date,
    between: (page: number, now: Date) => void = () => {},
  ): { since: Date | undefined; read: string[] } {
    const since =
      cursor === "old" ? this.oldSince() : this.newSince(runStartedAt);
    const ids = [...this.source.values()]
      .filter(r => !since || r.updatedAt >= since)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(r => r.id);
    const read: string[] = [];
    ids.forEach((id, page) => {
      const now = new Date(runStartedAt.getTime() + (page + 1) * MIN);
      between(page, now);
      this.merge(this.source.get(id)!, now);
      read.push(id);
    });
    if (cursor === "new") {
      this.lastPollRunStartedAt =
        this.lastPollRunStartedAt && this.lastPollRunStartedAt > runStartedAt
          ? this.lastPollRunStartedAt
          : runStartedAt;
    }
    return { since, read };
  }

  value(id: string) {
    return this.live.find(r => r.id === id)?.value;
  }
}

/**
 * Case 1 — 17 Nov, PL Close calls. Hourly polls with webhooks on. A call
 * updated at 14:13 never reached the webhook. Another call's webhook landed
 * at 14:58. The 15:00 poll must still read the 14:13 call.
 */
for (const cursor of ["old", "new"] as const) {
  const w = new World();
  w.update("call_a", at("13:30:00"), "v1");
  w.update("call_b", at("13:40:00"), "v1");
  w.poll(cursor, at("14:00:00")); // the 14:00 poll reads both
  w.update("call_a", at("14:13:00"), "v2"); // webhook missed
  w.update("call_b", at("14:58:00"), "v2");
  w.webhook("call_b", at("14:58:05"));

  const { since } = w.poll(cursor, at("15:00:00"));
  if (cursor === "old") {
    assert.equal(since?.toISOString(), at("14:58:05").toISOString());
    assert.equal(
      w.value("call_a"),
      "v1",
      "old cursor: the 14:13 change is lost",
    );
    // …and every later poll misses it too.
    w.poll(cursor, at("16:00:00"));
    assert.equal(w.value("call_a"), "v1");
  } else {
    assert.equal(
      since?.toISOString(),
      at("13:50:00").toISOString(),
      "the webhook write does not move the poll cursor",
    );
    assert.equal(
      w.value("call_a"),
      "v2",
      "poll cursor: the 14:13 change is read",
    );
    assert.equal(w.value("call_b"), "v2");
  }
}

/**
 * Case 2 — no webhooks. A record updated during a poll run, after its page
 * was read, must be read by the next poll.
 */
for (const cursor of ["old", "new"] as const) {
  const w = new World();
  w.update("lead_a", at("13:30:00"), "v1");
  w.update("lead_b", at("13:20:00"), "v1");
  w.update("lead_c", at("13:10:00"), "v1");
  w.poll(cursor, at("14:00:00"));
  w.update("lead_a", at("14:50:00"), "v2");
  w.update("lead_b", at("14:40:00"), "v2");
  w.update("lead_c", at("14:30:00"), "v2");
  // The 15:00 poll reads lead_a first (newest) at 15:01. lead_a changes
  // again at 15:01:30, before page 2 is read at 15:02.
  w.poll(cursor, at("15:00:00"), (page, now) => {
    if (page === 1) w.update("lead_a", new Date(now.getTime() - 30_000), "v3");
  });
  assert.equal(
    w.value("lead_a"),
    "v2",
    "lead_a's page was read before it changed",
  );

  const next = w.poll(cursor, at("16:00:00"));
  if (cursor === "old") {
    assert.equal(next.since?.toISOString(), at("15:03:00").toISOString());
    assert.equal(
      w.value("lead_a"),
      "v2",
      "old cursor: the in-flight change is lost",
    );
  } else {
    assert.equal(next.since?.toISOString(), at("14:50:00").toISOString());
    assert.equal(
      w.value("lead_a"),
      "v3",
      "poll cursor: the next poll reads the in-flight change",
    );
  }
}

/**
 * Case 3 — the overlap re-read writes no duplicates and never rolls a row
 * back. Records sit inside the 10-minute overlap of two consecutive polls,
 * and a webhook delivered a newer version in between.
 */
{
  const w = new World();
  w.update("opp_a", at("13:55:00"), "v1");
  w.update("opp_b", at("13:58:00"), "v1");
  w.poll("new", at("14:00:00"));
  const first = w.poll("new", at("15:00:00"));
  assert.deepEqual(
    [...first.read].sort(),
    ["opp_a", "opp_b"],
    "both rows sit in the overlap (since 13:50) and are re-read",
  );
  w.update("opp_b", at("15:20:00"), "v2");
  w.webhook("opp_b", at("15:20:02"));
  const second = w.poll("new", at("16:00:00"));
  assert.deepEqual(second.read, ["opp_b"]);

  const ids = w.live.map(r => r.id).sort();
  assert.deepEqual(ids, ["opp_a", "opp_b"], "one live row per record");
  assert.equal(w.value("opp_a"), "v1");
  assert.equal(w.value("opp_b"), "v2");

  // A re-read of an older version (source index lag) cannot roll back the
  // webhook's newer row: newer source ts wins.
  w.merge(
    { id: "opp_b", updatedAt: at("15:10:00"), value: "stale" },
    at("16:05:00"),
  );
  assert.equal(w.value("opp_b"), "v2");
  assert.equal(w.live.length, 2);
}

console.log("poll-cursor.test.ts: all assertions passed");
