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
          yield { records, state: { offset } };
        }
      },
    },
  },
});
