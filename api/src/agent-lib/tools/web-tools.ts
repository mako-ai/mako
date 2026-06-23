import { tool } from "ai";
import { z } from "zod";
import type { AgentToolExecutionContext } from "../../agents/types";
import { loggers } from "../../logging";
import { extractReadable } from "../../services/extract-readable";
import { SafeFetchError, safeFetch } from "../../services/safe-fetch.service";
import { getWebSearchProvider } from "../../services/web-search.service";
import {
  isAgentToolAbortError,
  registerAgentExecution,
  throwIfAborted,
} from "./shared/truncation";

const logger = loggers.agent();

const fetchUrlSchema = z.object({
  url: z.string().url().describe("The public URL to fetch and read"),
  max_chars: z
    .number()
    .int()
    .positive()
    .max(50_000)
    .optional()
    .default(20_000)
    .describe("Maximum characters of extracted content to return"),
});

const webSearchSchema = z.object({
  query: z.string().min(1).describe("Search query for current web information"),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(5)
    .describe("Maximum number of search results to return"),
});

export const createWebTools = (
  toolExecutionContext?: AgentToolExecutionContext,
) => {
  const tools = {
    fetch_url: tool({
      description:
        "Fetch a public URL and return readable content as text or markdown. Handles HTML, PDF, CSV, JSON, and plain text. Use when the user pastes a link or you need to read a specific page. Does not execute JavaScript — use web_search first to discover URLs, then fetch_url to read them in full.",
      inputSchema: fetchUrlSchema,
      execute: async ({ url, max_chars }) => {
        const { signal, release } = registerAgentExecution(
          toolExecutionContext,
          "agent-fetch-url",
        );
        try {
          throwIfAborted(signal);
          const fetched = await safeFetch(url, { signal });
          throwIfAborted(signal);
          const extracted = await extractReadable(
            fetched.body,
            fetched.contentType,
            fetched.url,
            max_chars ?? 20_000,
          );
          return {
            success: true as const,
            url: fetched.url,
            status: fetched.status,
            title: extracted.title,
            content: extracted.content,
            contentType: extracted.contentType,
            truncated: extracted.truncated,
            unsupported: extracted.unsupported ?? false,
          };
        } catch (error) {
          logger.debug("fetch_url failed", {
            url,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            success: false as const,
            error: isAgentToolAbortError(error)
              ? "URL fetch cancelled because the chat stopped."
              : error instanceof SafeFetchError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : "Failed to fetch URL",
          };
        } finally {
          release();
        }
      },
    }),
  };

  const searchProvider = getWebSearchProvider();
  if (!searchProvider) {
    return tools;
  }

  return {
    ...tools,
    web_search: tool({
      description:
        "Search the web for current information. Returns ranked results with title, url, and snippet. Follow up with fetch_url to read a result page in full.",
      inputSchema: webSearchSchema,
      execute: async ({ query, max_results }) => {
        const { signal, release } = registerAgentExecution(
          toolExecutionContext,
          "agent-web-search",
        );
        try {
          throwIfAborted(signal);
          const results = await searchProvider.search(
            query,
            max_results ?? 5,
            signal,
          );
          return {
            success: true as const,
            query,
            results,
          };
        } catch (error) {
          logger.debug("web_search failed", {
            query,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            success: false as const,
            error: isAgentToolAbortError(error)
              ? "Web search cancelled because the chat stopped."
              : error instanceof Error
                ? error.message
                : "Failed to search the web",
          };
        } finally {
          release();
        }
      },
    }),
  };
};
