/**
 * General-purpose process tools backed by Mako's own services.
 *
 * Each tool is the narrowest useful capability with an explicit effect class.
 * Credentials come only from the connection slot the tool declares, bound by
 * a workspace admin on the process installation.
 */
import { Types } from "mongoose";
import { defineTool, z } from "../sdk";
import { DatabaseConnection } from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { safeFetch } from "../../services/safe-fetch.service";
import { getWebSearchProvider } from "../../services/web-search.service";
import { emailService } from "../../services/email.service";

const MAX_ROWS = 200;

/** Read-only SQL against the database bound to the `warehouse` slot. */
export const sqlQuery = defineTool({
  name: "mako.sql.query",
  description:
    "Run a read-only SQL query against the bound warehouse/database. Returns at most " +
    `${MAX_ROWS} rows; always add a LIMIT and select only the columns you need.`,
  effect: "read",
  connections: ["warehouse"],
  timeout: "2m",
  input: z.object({
    sql: z.string().min(1).describe("A single read-only SQL statement"),
    database: z
      .string()
      .optional()
      .describe("Database/dataset name, if the engine needs one"),
  }),
  output: z.object({
    rowCount: z.number(),
    rows: z.array(z.record(z.string(), z.unknown())),
    truncated: z.boolean(),
  }),
  async execute({ sql, database }, t) {
    const bound = await t.connection("warehouse");
    const connection = await DatabaseConnection.findOne({
      _id: new Types.ObjectId(bound.id),
      workspaceId: new Types.ObjectId(t.workspaceId),
    });
    if (!connection) {
      throw new Error("Bound warehouse connection no longer exists");
    }
    const result = await databaseConnectionService.executeQuery(
      connection.toObject({ getters: true }),
      sql,
      {
        readOnly: true,
        signal: t.signal,
        ...(database ? { databaseName: database } : {}),
      },
    );
    if (!result.success) throw new Error(result.error ?? "Query failed");
    const rows = (Array.isArray(result.data) ? result.data : []) as Record<
      string,
      unknown
    >[];
    return {
      rowCount: result.rowCount ?? rows.length,
      rows: rows.slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
    };
  },
});

export const webSearch = defineTool({
  name: "web.search",
  description: "Search the public web. Returns titles, URLs and snippets.",
  effect: "read",
  timeout: "30s",
  input: z.object({
    query: z.string().min(2),
    maxResults: z.number().int().min(1).max(10).default(5),
  }),
  async execute({ query, maxResults }, t) {
    const provider = getWebSearchProvider();
    if (!provider) {
      throw new Error("Web search is not configured (TAVILY_API_KEY)");
    }
    return { results: await provider.search(query, maxResults, t.signal) };
  },
});

export const webFetch = defineTool({
  name: "web.fetch",
  description:
    "Fetch a public web page and return its text content (HTML stripped, truncated to 20k chars).",
  effect: "read",
  timeout: "30s",
  input: z.object({ url: z.string().url() }),
  async execute({ url }, t) {
    const response = await safeFetch(url, {
      signal: t.signal,
      maxBytes: 2_000_000,
    });
    const raw = response.body.toString("utf8");
    const text = response.contentType.includes("html")
      ? raw
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : raw;
    return {
      url: response.url,
      status: response.status,
      text: text.slice(0, 20_000),
      truncated: text.length > 20_000,
    };
  },
});

/**
 * Send an email through Mako's mail provider (logged, not sent, in dev
 * without SENDGRID_API_KEY). `write`: the ledger guarantees one send per call
 * even if the step retries after the send succeeded.
 */
export const emailSend = defineTool({
  name: "email.send",
  description:
    "Send a plain email (subject + text body) to one or more recipients.",
  effect: "write",
  timeout: "30s",
  input: z.object({
    to: z.array(z.string().email()).min(1).max(20),
    subject: z.string().min(1).max(200),
    text: z.string().min(1),
  }),
  output: z.object({ sent: z.number() }),
  async execute({ to, subject, text }) {
    const html = `<pre style="font-family: inherit; white-space: pre-wrap">${text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")}</pre>`;
    await emailService.sendFlowRunNotificationEmails(to, {
      subject,
      text,
      html,
    });
    return { sent: to.length };
  },
});
