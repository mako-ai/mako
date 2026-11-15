/** Key links: an agent-created connection's key, pasted by a person. */
import { createRoute, z } from "@hono/zod-openapi";
import {
  KeyRequestError,
  type KeyLinkAuthorizer,
  loadKeyRequest,
  submitKey,
} from "../../connectors/connection-key-request.service";
import { loggers } from "../../logging";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import {
  changeRefusal,
  mayChangeSourceConnection,
  type Caller,
} from "../../access/source-connection-access";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { WorkspaceParam, callerOf } from "./shared";
import { fail } from "../lib/respond";

const logger = loggers.connector();

export const sourceConnectionKeyLinkRoutes = createRouter();

// --- Key links ---------------------------------------------------------------
// An agent creates a connection without its key and hands the user a link
// (connectors/connection-key-request.service.ts). These two routes are the
// link's page: what it asks for and where the key goes, and the key the
// person pastes. A person in the app only — never an API key or MCP client —
// and one of the connection's managers, the bar for editing its key. The
// token travels in the body, never in a path a log or analytics records.

const KeyTokenBody = z.object({
  token: z.string().min(1).max(200).openapi({
    description: "The token from the key link's fragment.",
  }),
});

const KEY_REQUEST_HTTP_STATUS = {
  not_found: 404,
  expired: 410,
  forbidden: 403,
  invalid_input: 400,
  check_failed: 422,
} as const;

/** Refusal for a caller who may not use a key link at all, or null. */
function keyLinkRefusal(c: AuthenticatedContext): Response | null {
  if (c.get("authType") !== "session" || !c.get("user")) {
    return fail(c, 403, "Key links are opened in the app, signed in");
  }
  return null;
}

/** The manager check, run on the connection the token names. */
function keyLinkAuthorizer(caller: Caller): KeyLinkAuthorizer {
  return async connection =>
    (await mayChangeSourceConnection(caller, connection))
      ? null
      : changeRefusal(caller.role);
}

function keyRequestErrorResponse(c: AuthenticatedContext, error: unknown) {
  if (error instanceof KeyRequestError) {
    return fail(c, KEY_REQUEST_HTTP_STATUS[error.code], error.message, {
      code: error.code,
    });
  }
  logger.error("Key link endpoint error", {
    error: error instanceof Error ? error.message : String(error),
  });
  return fail(c, 500, "Could not use this key link");
}

sourceConnectionKeyLinkRoutes.openapi(
  createRoute({
    method: "post",
    path: "/key-requests/lookup",
    tags: ["Source Connections"],
    summary:
      "What a key link asks for: the connection, where its key is sent, and its secret fields",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: { content: { "application/json": { schema: KeyTokenBody } } },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const { workspaceId } = c.req.valid("param");
    const refused = keyLinkRefusal(c);
    if (refused) return refused;
    try {
      const { token } = c.req.valid("json");
      const caller = await callerOf(c, workspaceId);
      return c.json({
        success: true,
        data: await loadKeyRequest(
          workspaceId,
          token,
          keyLinkAuthorizer(caller),
        ),
      });
    } catch (error) {
      return keyRequestErrorResponse(c, error);
    }
  },
);

sourceConnectionKeyLinkRoutes.openapi(
  createRoute({
    method: "post",
    path: "/key-requests/submit",
    tags: ["Source Connections"],
    summary:
      "Set a waiting connection's key through its one-time key link (checked, then stored encrypted)",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        content: {
          "application/json": {
            schema: KeyTokenBody.extend({
              config: z.record(z.string(), z.string()).openapi({
                description:
                  "Values for the fields the link asks for, keyed by field name.",
              }),
              confirmedDestination: z.boolean().openapi({
                description:
                  "The person confirmed the address and settings the page showed.",
              }),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const { workspaceId } = c.req.valid("param");
    const refused = keyLinkRefusal(c);
    if (refused) return refused;
    try {
      const { token, config, confirmedDestination } = c.req.valid("json");
      const caller = await callerOf(c, workspaceId);
      const result = await submitKey({
        workspaceId,
        token,
        userId: (c.get("user") as { id: string }).id,
        values: config,
        confirmedDestination,
        authorize: keyLinkAuthorizer(caller),
      });
      return c.json({ success: true, data: result });
    } catch (error) {
      return keyRequestErrorResponse(c, error);
    }
  },
);
