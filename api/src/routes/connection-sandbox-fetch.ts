/**
 * Public, token-gated: a proxied workspace connector's `ctx.http` sends each
 * request here from its sandbox (connections/sandbox-fetch.service.ts). The
 * bearer is a short-lived run token naming one connection, never a key.
 */
import { bodyLimit } from "hono/body-limit";
import { createRouter } from "../openapi/core";
import {
  SandboxFetchError,
  sandboxFetch,
  type SandboxFetchInput,
} from "../connections/sandbox-fetch.service";
import { SafeFetchError } from "../services/safe-fetch.service";

export const connectionSandboxFetchRoutes = createRouter();

connectionSandboxFetchRoutes.post(
  "/",
  bodyLimit({ maxSize: 20 * 1024 * 1024 }),
  async c => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    const input = (await c.req
      .json()
      .catch(() => null)) as SandboxFetchInput | null;
    if (!input || typeof input !== "object") {
      return c.json({ error: "A JSON request is required" }, 400);
    }
    try {
      return c.json(await sandboxFetch(token, input, c.req.raw.signal));
    } catch (error) {
      if (error instanceof SandboxFetchError) {
        return c.json({ error: error.message }, error.status);
      }
      if (error instanceof SafeFetchError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
  },
);
