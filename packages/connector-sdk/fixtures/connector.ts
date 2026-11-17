/**
 * The connector the SDK's own tests run. Deliberately written the way an
 * agent would write one: declared config, declared schema, a paginated read.
 */
import { defineConnector } from "../index.js";

const PEOPLE = Array.from({ length: 25 }, (_, i) => ({
  id: `p${i + 1}`,
  email: `person${i + 1}@example.com`,
  updated_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
}));

export default defineConnector({
  name: "fixture",
  version: "1.0.0",
  documentationUrl: "https://example.com/docs",
  config: {
    required: ["apiKey"],
    properties: {
      apiKey: { type: "string", title: "API key", airbyte_secret: true },
    },
  },
  check: async ctx => {
    if (ctx.config.apiKey !== "good-key") throw new Error("401: that key was revoked");
    return true;
  },
  entities: {
    people: {
      primaryKey: ["id"],
      cursorField: "updated_at",
      schema: { id: "string", email: "string", updated_at: "timestamp" },
      async *read(ctx, state) {
        const pageSize = 10;
        let offset = Number(state.offset ?? 0);
        while (offset < PEOPLE.length) {
          const records = PEOPLE.slice(offset, offset + pageSize);
          offset += records.length;
          // Test knobs: a log line per page, and a connector that never
          // says whether another page exists.
          if (ctx.config.logEveryPage) ctx.log(ctx.config.logEveryPage);
          // frozenState: a connector that reports the same state every page.
          const pageState = ctx.config.frozenState ? { offset: 10 } : { offset };
          yield ctx.config.omitHasMore
            ? { records, state: pageState }
            : { records, state: { offset }, hasMore: offset < PEOPLE.length };
        }
      },
    },
  },
  webhooks: {
    verification: {
      scheme: "hmac-sha256",
      secretEncoding: "utf8",
      signedPayload: ["header:x-fixture-timestamp", "literal:.", "body"],
      signatureHeader: "x-fixture-signature",
      signatureEncoding: "hex",
      signaturePrefix: "sha256=",
    },
    events: ["person.updated", "person.deleted"],
    // A partial payload carries only the id: the row is "re-fetched" from
    // the fixture's data, as a real handler would call its API.
    async handleBatch(ctx, events) {
      if (ctx.config.wrongCount) return events.slice(1);
      if (ctx.config.throwInHandler) throw new Error("vendor said 500");
      return events.map(event => {
        const id = (event.rawPayload as { id?: string } | null)?.id;
        if (event.eventType !== "person.updated" && event.eventType !== "person.deleted") {
          return { eventId: event.eventId, outcome: "unmapped" as const };
        }
        if (!id) return { eventId: event.eventId, outcome: "extract_failed" as const };
        if (event.eventType === "person.deleted") {
          return {
            eventId: event.eventId,
            outcome: "records" as const,
            records: [{ entity: "people", recordId: id, operation: "delete" as const, payload: { id } }],
          };
        }
        const row = PEOPLE.find(p => p.id === id);
        if (!row) return { eventId: event.eventId, outcome: "skipped" as const, reason: "gone" };
        return {
          eventId: event.eventId,
          outcome: "records" as const,
          records: [
            {
              entity: "people",
              recordId: id,
              operation: "upsert" as const,
              payload: { ...row, apiKeySeen: ctx.config.apiKey === "good-key" },
              changeId: event.eventId,
            },
          ],
        };
      });
    },
  },
});
