/**
 * PandaDoc `members` is the seat roster. Every poll must re-read it whole,
 * so a seat deactivated after the backfill reaches the destination as
 * `is_active: false`. The old `since` filter dropped such a seat: PandaDoc
 * leaves `date_modified` at the seat's last profile edit.
 *
 * The destination is append_dedup, which upserts rows by `id`. The test
 * applies each poll's rows to a map keyed by `id`, as that write mode does.
 * A seat PandaDoc deletes outright leaves no row to upsert. That needs a
 * snapshot-complete marker the runtime does not have, so it is not covered.
 *
 * Run: node --import tsx --test src/connectors/workspace/pandadoc-members-full-read.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const seat = (n: number, isActive: boolean) => ({
  user_id: `user_${n}`,
  membership_id: `membership_${n}`,
  email: `member${n}@example.test`,
  first_name: "Member",
  last_name: `N${n}`,
  is_active: isActive,
  role: "Member",
  date_created: "2026-08-01T09:00:00.000Z",
  // Older than the `since` below, and unchanged by a deactivation.
  date_modified: "2026-08-02T09:00:00.000Z",
});

type Row = Record<string, unknown>;

void test("a seat deactivated after the backfill turns inactive on the next poll", async () => {
  const { ensureFolderInstalled, readFolder, requestKey, startReplayServer } =
    await import("../../../../connectors/pandadoc/fixtures/harness.mjs");
  ensureFolderInstalled();

  const route = requestKey("GET", "/public/v1/members");
  const interactions = new Map<string, { status: number; body: unknown }>([
    [
      route,
      {
        status: 200,
        body: { results: [seat(1, true), seat(2, true), seat(3, true)] },
      },
    ],
  ]);
  const server = await startReplayServer(interactions);

  try {
    const config = {
      api_key: "api_test_members_full_read",
      api_base_url: server.url,
    };
    const destination = new Map<unknown, Row>();
    const apply = (rows: Row[]) => {
      for (const row of rows) destination.set(row.id, row);
    };

    const backfill = await readFolder({
      entity: "members",
      config,
      maxIterations: 10,
    });
    apply(backfill.rows);
    assert.equal(backfill.rows.length, 3);
    assert.equal(destination.get("membership_2")?.is_active, true);

    // Seat 2 is deactivated in PandaDoc. Its date_modified does not move.
    interactions.set(route, {
      status: 200,
      body: { results: [seat(1, true), seat(2, false), seat(3, true)] },
    });

    // The 15-minute poll: Mako sends `since` after the backfill.
    const poll = await readFolder({
      entity: "members",
      config,
      since: "2026-11-18T00:00:00.000Z",
      maxIterations: 10,
    });
    assert.equal(poll.rows.length, 3, "the poll re-reads every seat");
    apply(poll.rows);

    assert.equal(destination.size, 3);
    assert.equal(destination.get("membership_2")?.is_active, false);
    assert.equal(destination.get("membership_1")?.is_active, true);
    assert.equal(destination.get("membership_3")?.is_active, true);
    assert.deepEqual(server.misses, []);
    assert.deepEqual(
      server.requests(config.api_key),
      [route, route],
      "one members request a poll",
    );
  } finally {
    await server.close();
  }
});
