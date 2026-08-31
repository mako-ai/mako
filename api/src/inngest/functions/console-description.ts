/**
 * Console description + embedding derivation (apps.md §16.4).
 *
 * One debounced function replaces the three fire-and-forget generators that
 * used to race each other in routes/consoles.ts: a burst of saves on one
 * console collapses into one LLM call once it settles, and the write is
 * guarded on the content it derived from. Idempotent — a console whose
 * `descriptionSourceSha` already equals its `sourceBlobSha` is a no-op.
 */
import { inngest } from "../client";
import { loggers } from "../../logging";
import {
  CONSOLE_DESCRIPTION_EVENT,
  deriveConsoleDescription,
  type ConsoleDescriptionEventData,
} from "../../apps/workspace-consoles.service";

const log = loggers.api("console-description");

export const consoleDescriptionFunction = inngest.createFunction(
  {
    id: "console-description",
    name: "Consoles: derive description + embedding",
    debounce: {
      key: "event.data.consoleId",
      period: "60s",
      timeout: "5m",
    },
    concurrency: [{ key: "event.data.workspaceId", limit: 3 }],
    retries: 2,
  },
  { event: CONSOLE_DESCRIPTION_EVENT },
  async ({ event, step }) => {
    const data = event.data as ConsoleDescriptionEventData;
    const outcome = await step.run("derive", () =>
      deriveConsoleDescription(data.consoleId, {
        context: data.context,
        tracking: data.tracking,
      }),
    );
    log.debug("Console description derived", {
      consoleId: data.consoleId,
      outcome,
    });
    return { outcome };
  },
);
