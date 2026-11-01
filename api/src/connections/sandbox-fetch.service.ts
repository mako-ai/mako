/**
 * The other end of a proxied workspace connector's `ctx.http`
 * (connections/placeholders.ts): one request from a sandbox, with
 * placeholders where its keys would be.
 *
 * The run token names the one connection whose keys may be spent. Mako swaps
 * that connection's placeholders for its stored values in the URL, headers
 * (a basic-auth header too) and body, sends the request through the
 * SSRF-hardened transport (public hosts only, no redirect followed), and
 * returns the answer with every secret value removed.
 *
 * This is sync traffic: the writers list does not apply (a workspace
 * connector's requests are its reads, as today), live reads do not apply,
 * and there is no extra rate gate: `ctx.http` keeps its own spacing.
 */
import { Types } from "mongoose";
import { SourceConnection } from "../database/workspace-schema";
import { sourceConnectionManager } from "../sync/database-data-source-manager";
import { loadConnectorDefinition } from "../connectors/workspace/resolver";
import {
  isWorkspaceConnectorType,
  secretFieldsOfSpec,
  slugFromType,
} from "../connectors/workspace/SandboxedConnector";
import { loggers } from "../logging";
import { ALLOWED_METHODS, cleanAnswer, sendRequest } from "./forward";
import {
  PlaceholderError,
  hasPlaceholder,
  swapHeader,
  swapPlaceholders,
  verifyRunToken,
} from "./placeholders";

const logger = loggers.connector("sandbox-fetch");

export class SandboxFetchError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404,
  ) {
    super(message);
    this.name = "SandboxFetchError";
  }
}

export interface SandboxFetchInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Text, or base64 when `bodyEncoding` is "base64". */
  body?: string;
  bodyEncoding?: "text" | "base64";
}

export interface SandboxFetchResult {
  status: number;
  headers: Record<string, string>;
  /** Base64 of the answer's bytes, the secret values removed. */
  body: string;
}

/** Headers a sandbox may not send: the transport is Mako's. */
const DROPPED = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
]);

export async function sandboxFetch(
  token: string | undefined,
  input: SandboxFetchInput,
  signal?: AbortSignal,
): Promise<SandboxFetchResult> {
  const claims = verifyRunToken(token);
  if (!claims) {
    throw new SandboxFetchError("The run token is missing or expired.", 401);
  }
  const { workspaceId, connectionId } = claims;
  const row = await SourceConnection.findOne(
    {
      _id: new Types.ObjectId(connectionId),
      workspaceId: new Types.ObjectId(workspaceId),
    },
    { type: 1 },
  ).lean();
  if (!row || !isWorkspaceConnectorType(row.type)) {
    throw new SandboxFetchError("No such workspace connection.", 404);
  }
  const definition = await loadConnectorDefinition(
    workspaceId,
    slugFromType(row.type),
  );
  if (definition.credentials !== "proxied") {
    throw new SandboxFetchError(
      `${row.type} is not set to \`credentials: proxied\` in its connector.yaml.`,
      403,
    );
  }

  const method = (input.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new SandboxFetchError(`Method ${input.method} is not allowed.`, 400);
  }
  if (typeof input.url !== "string" || !/^https?:\/\//i.test(input.url)) {
    throw new SandboxFetchError("An absolute http(s) URL is required.", 400);
  }

  const loaded =
    await sourceConnectionManager.getSourceConnection(connectionId);
  const config = (loaded?.connection ?? {}) as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const field of secretFieldsOfSpec(definition.spec)) {
    if (typeof config[field] === "string" && config[field]) {
      values[field] = config[field] as string;
    }
  }

  let url: string;
  const headers: Record<string, string> = {};
  let body: string | undefined;
  try {
    url = swapPlaceholders(input.url, connectionId, values);
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (typeof value !== "string" || DROPPED.has(name.toLowerCase())) {
        continue;
      }
      headers[name.toLowerCase()] = swapHeader(
        name,
        value,
        connectionId,
        values,
      );
    }
    if (input.body !== undefined) {
      const text =
        input.bodyEncoding === "base64"
          ? Buffer.from(input.body, "base64").toString("utf8")
          : input.body;
      body = swapPlaceholders(text, connectionId, values);
    }
  } catch (error) {
    if (error instanceof PlaceholderError) {
      logger.warn("Refused a sandbox request with a foreign placeholder", {
        workspaceId,
        connectionId,
      });
      throw new SandboxFetchError(error.message, 403);
    }
    throw error;
  }
  if (
    hasPlaceholder(url) ||
    Object.values(headers).some(hasPlaceholder) ||
    (body !== undefined && hasPlaceholder(body))
  ) {
    throw new SandboxFetchError("A placeholder was left unswapped.", 400);
  }

  const answer = await sendRequest(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
    signal,
  });
  const secrets = Object.values(values);
  const { headers: cleanHeaders, text } = cleanAnswer(answer, secrets, [
    "authorization",
  ]);
  // Text answers are scrubbed; a binary one (an image, a zip) holds no key
  // Mako could find in text, and is passed as its bytes.
  const textual =
    /json|text|xml|html|csv|javascript|urlencoded/i.test(
      cleanHeaders["content-type"] ?? "text/plain",
    ) || secrets.some(secret => answer.body.includes(secret));
  return {
    status: answer.status,
    headers: cleanHeaders,
    body: (textual ? Buffer.from(text, "utf8") : answer.body).toString(
      "base64",
    ),
  };
}
