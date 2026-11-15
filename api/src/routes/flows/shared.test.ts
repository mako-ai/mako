import assert from "node:assert/strict";
import { z } from "@hono/zod-openapi";
import { createRouter } from "../../openapi/core";
import { FlowRequestError } from "../../services/flow-request-error";
import {
  ANY_JSON_BODY,
  flowFailure,
  flowRoute,
  queryParam,
  thrownMessage,
} from "./shared";

async function main() {
  // The spec a route used to spell out by hand: one path param per `{name}`,
  // after workspaceId, and the summary from method + path.
  const spec = flowRoute("get", "/{flowId}/executions/{executionId}", {
    query: z.object({ limit: queryParam("limit") }),
  });
  assert.equal(spec.summary, "GET /{flowId}/executions/{executionId}");
  assert.deepEqual(spec.tags, ["Flows"]);
  assert.deepEqual(Object.keys(spec.request?.params?.shape ?? {}), [
    "workspaceId",
    "flowId",
    "executionId",
  ]);
  assert.ok(spec.request?.query);
  assert.equal(
    Object.keys(flowRoute("post", "/dry-run").request?.params?.shape ?? {})
      .length,
    1,
    "a collection route has only workspaceId",
  );

  // The generated OpenAPI is the same shape the hand-written specs produced.
  const app = createRouter();
  app.openapi(
    flowRoute("post", "/{flowId}/run", { body: ANY_JSON_BODY }),
    async c => c.json({ ok: true }),
  );
  const doc = app.getOpenAPIDocument({
    openapi: "3.0.0",
    info: { title: "t", version: "1" },
  });
  const op = doc.paths?.["/{flowId}/run"]?.post;
  assert.ok(op);
  assert.equal(op.summary, "POST /{flowId}/run");
  assert.deepEqual(
    (op.parameters as Array<{ name: string; in: string }>).map(p => [
      p.name,
      p.in,
    ]),
    [
      ["workspaceId", "path"],
      ["flowId", "path"],
    ],
  );

  // flowFailure: a FlowRequestError answers with its own status and extras;
  // anything else with the fallback status and its message.
  const errors = createRouter();
  errors.get("/typed", c =>
    flowFailure(
      c,
      new FlowRequestError(404, "Flow not found", { data: { x: 1 } }),
      400,
    ),
  );
  errors.get("/plain", c => flowFailure(c, new Error("boom"), 400));
  errors.get("/thrown", c => flowFailure(c, "not an error", 500));

  const typed = await errors.request("/typed");
  assert.equal(typed.status, 404);
  assert.deepEqual(await typed.json(), {
    success: false,
    error: "Flow not found",
    data: { x: 1 },
  });
  const plain = await errors.request("/plain");
  assert.equal(plain.status, 400);
  assert.deepEqual(await plain.json(), { success: false, error: "boom" });
  const thrown = await errors.request("/thrown");
  assert.equal(thrown.status, 500);
  assert.deepEqual(await thrown.json(), {
    success: false,
    error: "Unknown error",
  });

  assert.equal(thrownMessage(new Error("m")), "m");
  assert.equal(thrownMessage(42), "Unknown error");

  console.log("flow route shared helpers: all assertions passed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
