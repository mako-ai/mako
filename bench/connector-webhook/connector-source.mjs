/**
 * The connector the E2B webhook bench runs, as source text. The same one
 * as api/src/connectors/workspace/webhook-batch.docker.test.ts: its handler
 * reports what its run can see, and a `hang` event never returns.
 */
export default `
import fs from "node:fs";
import path from "node:path";
import { defineConnector } from "@makoai/connector-sdk";

export default defineConnector({
  name: "hooks",
  version: "1.0.0",
  config: { required: ["api_key"], properties: { api_key: { type: "string", airbyte_secret: true } } },
  entities: { items: { schema: { id: "string" }, async *read() { yield { records: [], hasMore: false }; } } },
  webhooks: {
    verification: {
      scheme: "hmac-sha256",
      secretEncoding: "hex",
      signedPayload: ["header:x-ts", "body"],
      signatureHeader: "x-sig",
      signatureEncoding: "hex",
    },
    async handleBatch(ctx, events) {
      if (events.some(e => e.eventType === "hang")) {
        await new Promise(() => setInterval(() => {}, 1000));
      }
      const argv = process.argv;
      const inputDir = path.dirname(argv[argv.indexOf("--batch") + 1]);
      let others = 0;
      for (const pid of fs.readdirSync("/proc").filter(p => /^\\d+$/.test(p))) {
        try {
          if (fs.statSync("/proc/" + pid).uid !== process.getuid()) others++;
        } catch {}
      }
      const seen = {
        inputs: fs.readdirSync(inputDir).filter(f => f.endsWith(".json")).sort(),
        env: Object.keys(process.env).sort(),
        uid: process.getuid(),
        apiKey: ctx.config.api_key,
        others,
      };
      return events.map(e => ({
        eventId: e.eventId,
        outcome: "records",
        records: [{ entity: "items", recordId: e.eventId, operation: "upsert", payload: { id: e.eventId, seen } }],
      }));
    },
  },
});
`;
