/* eslint-disable no-console, no-process-exit */
/**
 * Integration tests for the OpenAPI router foundation (`createRouter`).
 *
 * Run with: tsx src/openapi/core.test.ts
 *
 * Exercises the shared validation hook and helpers end-to-end via
 * `app.request(...)` — no database or network required.
 */
import assert from "node:assert/strict";
import { createRoute, z } from "@hono/zod-openapi";

import {
  AUTH_SECURITY,
  STD_ERRORS,
  createRouter,
  dataResponse,
  jsonBody,
  jsonContent,
} from "./core";

function buildApp() {
  const app = createRouter();

  app.openapi(
    createRoute({
      method: "post",
      path: "/echo",
      tags: ["Test"],
      request: { body: jsonBody(z.object({ name: z.string().min(1) })) },
      responses: {
        200: jsonContent(
          z.object({ success: z.literal(true), name: z.string() }),
          "ok",
        ),
        ...STD_ERRORS,
      },
    }),
    c => {
      const { name } = c.req.valid("json");
      return c.json({ success: true as const, name }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/items/{id}",
      tags: ["Test"],
      request: {
        params: z.object({
          id: z.string().openapi({ param: { name: "id", in: "path" } }),
        }),
      },
      responses: {
        200: dataResponse(z.object({ id: z.string() }), "item"),
        ...STD_ERRORS,
      },
    }),
    c => {
      const { id } = c.req.valid("param");
      return c.json({ success: true as const, data: { id } }, 200);
    },
  );

  return app;
}

async function testValidBodyPasses() {
  const app = buildApp();
  const res = await app.request("/echo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Ada" }),
  });
  assert.equal(res.status, 200, "valid body should pass validation");
  const json = (await res.json()) as { success: boolean; name: string };
  assert.equal(json.success, true);
  assert.equal(json.name, "Ada");
}

async function testInvalidBodyReturnsEnvelope() {
  const app = buildApp();
  const res = await app.request("/echo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "" }), // fails .min(1)
  });
  assert.equal(res.status, 400, "invalid body should be rejected by the hook");
  const json = (await res.json()) as { success: boolean; error: string };
  assert.equal(json.success, false, "error envelope: success=false");
  assert.equal(typeof json.error, "string", "error envelope: error string");
}

async function testMissingBodyReturns400() {
  const app = buildApp();
  const res = await app.request("/echo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400, "missing required field rejected");
}

async function testPathParamRoute() {
  const app = buildApp();
  const res = await app.request("/items/abc123");
  assert.equal(res.status, 200);
  const json = (await res.json()) as { data: { id: string } };
  assert.equal(json.data.id, "abc123");
}

function testAuthSecurityShape() {
  assert.deepEqual(AUTH_SECURITY, [{ cookieAuth: [] }, { bearerAuth: [] }]);
}

async function main() {
  await testValidBodyPasses();
  await testInvalidBodyReturnsEnvelope();
  await testMissingBodyReturns400();
  await testPathParamRoute();
  testAuthSecurityShape();
  console.log("core.test: OK — validation hook + helpers behave as expected");
  process.exit(0);
}

void main();
