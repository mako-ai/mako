/**
 * Claap on @makoai/connector-sdk: `spec`, `check`, `discover`, `read` and
 * `webhooks`.
 *
 * 3 entities with their schemas, pagination, quota checkpoints, incremental
 * anchors and webhook handling, ported from the in-process connector
 * (deleted). `fixtures/golden/` holds the rows it reads from the recorded
 * Claap responses, checked byte for byte by an API test
 * (`api/src/connectors/claap-folder.test.ts`).
 *
 * - `recordings`: list pages of 50 (`sort=created_asc`), every recording
 *   re-read from its detail. `state.mako.since`, moved back by
 *   `recordings_lookback_days` (at most 7), is `createdAfter`.
 * - `recording_transcripts`: list pages of 50, every transcript language
 *   downloaded. `createdAfter` is `since` minus 2 days.
 * - `workspace`: `GET /v1/workspaces/mine`, one row.
 *
 * Read state carries the fields the in-process `FetchState` had: `cursor`,
 * `pageOffset`, `createdAfter`, `totalCount`, `recordingsSeen`,
 * `totalProcessed`, next to Mako's `mako.since`.
 */
import { defineConnector } from "@makoai/connector-sdk";
import type {
  Context,
  EntityDefinition,
  EntitySchema,
} from "@makoai/connector-sdk";
import {
  CLAAP_DEFAULT_BASE_URL,
  createClaapClient,
  type ClaapClient,
} from "./client.ts";
import {
  readClaapRecordings,
  type ClaapReadContext,
  type RecordingsState,
} from "./recordings.ts";
import { claapJsonSchema, ENTITY_FIELDS } from "./schema.ts";
import {
  CLAAP_TRANSCRIPTS_ENTITY,
  TRANSCRIPT_TIMEOUT_MS,
  downloadSignedUrl,
  readClaapTranscripts,
  type TranscriptDeps,
  type TranscriptsState,
} from "./transcripts.ts";
import {
  CLAAP_WEBHOOK_EVENTS,
  CLAAP_WEBHOOK_VERIFICATION,
  handleClaapWebhookBatch,
} from "./webhooks.ts";

const PAGE_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 200;
/** A webhook batch has 60 s in all; one slow link must not use them up. */
const WEBHOOK_DOWNLOAD_TIMEOUT_MS = 15_000;

interface ClaapConfig {
  api_key: string;
  api_base_url?: string;
  recordings_lookback_days?: number | string;
  __page_size?: number;
  __rate_limit_delay_ms?: number;
}

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

function positive(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function client(ctx: Context<ClaapConfig>): ClaapClient {
  return createClaapClient({
    apiKey: ctx.config.api_key,
    baseUrl: ctx.config.api_base_url,
    log: message => ctx.log(message),
  });
}

function readContext(ctx: Context<ClaapConfig>): ClaapReadContext {
  return {
    api: client(ctx),
    sleep,
    log: message => ctx.log(message),
    batchSize: positive(ctx.config.__page_size, PAGE_SIZE),
    rateLimitDelay: positive(
      ctx.config.__rate_limit_delay_ms,
      RATE_LIMIT_DELAY_MS,
    ),
    recordingsLookbackDays: ctx.config.recordings_lookback_days,
  };
}

function transcriptDeps(
  read: ClaapReadContext,
  timeoutMs: number,
): TranscriptDeps {
  return {
    api: read.api,
    sleep: read.sleep,
    log: read.log,
    rateLimitDelay: read.rateLimitDelay,
    download: url => downloadSignedUrl(url, timeoutMs),
  };
}

function parseSince(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`state.mako.since is not a date: ${value}`);
  }
  return date;
}

/** Every batch keeps Mako's `since` in the state it hands back. */
async function* withAnchor(
  anchor: string | undefined,
  batches: AsyncGenerator<{
    records: Record<string, unknown>[];
    state: Record<string, unknown>;
    hasMore: boolean;
  }>,
) {
  for await (const batch of batches) {
    yield {
      ...batch,
      state: { ...batch.state, ...(anchor ? { mako: { since: anchor } } : {}) },
    };
  }
}

async function* readWorkspace(ctx: Context<ClaapConfig>) {
  const response = await client(ctx).get("/v1/workspaces/mine");
  const workspace = (response.data as { result?: { workspace?: unknown } })
    ?.result?.workspace;
  yield {
    records:
      workspace && typeof workspace === "object"
        ? [workspace as Record<string, unknown>]
        : [],
    state: { totalProcessed: 1 },
    hasMore: false,
  };
}

const LAYOUT = {
  partitionField: "createdAt",
  partitionGranularity: "day" as const,
  clusterFields: ["_dataSourceId", "id"],
};

function entity(
  name: string,
  label: string,
  description: string,
  extra: Partial<EntityDefinition<ClaapConfig>>,
): EntityDefinition<ClaapConfig> {
  return {
    label,
    description,
    primaryKey: ["id"],
    schema: { ...ENTITY_FIELDS[name] },
    discoverSchema: () => claapJsonSchema(name) as unknown as EntitySchema,
    read: () => {
      throw new Error(`No read for ${name}`);
    },
    ...extra,
  };
}

export default defineConnector<ClaapConfig>({
  name: "claap",
  version: "1.0.0",
  title: "Claap",
  documentationUrl: "https://docs.claap.io/api-reference",
  config: {
    required: ["api_key"],
    properties: {
      api_key: {
        type: "string",
        title: "API Key",
        description:
          "Claap workspace API key (X-Claap-Key). Generate in Claap settings.",
        airbyte_secret: true,
        order: 0,
      },
      api_base_url: {
        type: "string",
        title: "API Base URL",
        default: CLAAP_DEFAULT_BASE_URL,
        order: 1,
      },
      recordings_lookback_days: {
        type: "number",
        title: "Recordings re-read window (days)",
        default: 0,
        examples: ["0"],
        description:
          "Incremental runs re-read recordings created this many days before the last sync, picking up AI fields Claap generates later. 0 reads only new recordings, max 7. Every poll re-reads the whole window at one API call per recording, so the cost is window × polls per day.",
        order: 2,
      },
    },
  },
  async check(ctx) {
    await client(ctx).get("/v1/workspaces/mine");
    return true;
  },
  entities: {
    recordings: entity(
      "recordings",
      "Recordings",
      "Claap meeting and clip recordings",
      {
        cursorField: "createdAt",
        incremental: "created-anchor",
        layout: LAYOUT,
        read: (ctx, state) => {
          const anchor = (state as { mako?: { since?: string } }).mako?.since;
          return withAnchor(
            anchor,
            readClaapRecordings(
              readContext(ctx),
              state as RecordingsState,
              parseSince(anchor),
            ),
          );
        },
      },
    ),
    [CLAAP_TRANSCRIPTS_ENTITY]: entity(
      CLAAP_TRANSCRIPTS_ENTITY,
      "Recording transcripts",
      "Transcript text and speaker segments, one row per recording and language",
      {
        // No cursor field: rows carry no time the engine reads, so it stamps
        // them with the sync time.
        incremental: "created-anchor",
        layout: {
          partitionField: "recordingCreatedAt",
          partitionGranularity: "day",
          clusterFields: ["recordingId"],
        },
        read: (ctx, state) => {
          const anchor = (state as { mako?: { since?: string } }).mako?.since;
          const read = readContext(ctx);
          return withAnchor(
            anchor,
            readClaapTranscripts(
              read,
              transcriptDeps(read, TRANSCRIPT_TIMEOUT_MS),
              state as TranscriptsState,
              parseSince(anchor),
            ),
          );
        },
      },
    ),
    workspace: entity("workspace", "Workspace", "Claap workspace metadata", {
      layout: LAYOUT,
      read: ctx => readWorkspace(ctx),
    }),
  },
  webhooks: {
    verification: CLAAP_WEBHOOK_VERIFICATION,
    events: CLAAP_WEBHOOK_EVENTS,
    eventIdPath: "eventId",
    eventTypePath: "event.type",
    handleBatch: (ctx, events, options) => {
      const read = readContext(ctx);
      return handleClaapWebhookBatch(
        {
          api: read.api,
          sleep,
          log: read.log,
          transcripts: transcriptDeps(read, WEBHOOK_DOWNLOAD_TIMEOUT_MS),
        },
        events,
        options,
      );
    },
  },
});
