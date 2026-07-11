import assert from "node:assert/strict";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  AppV2LeaseRotateSchema,
  AppV2MaxFileContentCharacters,
  AppV2MaxPathCharacters,
  AppV2WriteFileSchema,
} from "@mako/schemas";
import type { AuthEnv } from "../openapi/core";
import { appsV2Routes } from "../routes/apps-v2";

const validState = {
  ifRevision: 0,
  expectedWipOid: "a".repeat(40),
  leaseEpoch: 1,
};

assert.equal(
  AppV2WriteFileSchema.safeParse({
    ...validState,
    path: "src/App.tsx",
    content: "export default function App() { return null; }",
  }).success,
  true,
);
for (const missing of ["ifRevision", "expectedWipOid", "leaseEpoch"] as const) {
  const input: Record<string, unknown> = {
    ...validState,
    path: "src/App.tsx",
    content: "",
  };
  delete input[missing];
  assert.equal(AppV2WriteFileSchema.safeParse(input).success, false);
}
assert.equal(
  AppV2WriteFileSchema.safeParse({
    ...validState,
    path: "x".repeat(AppV2MaxPathCharacters + 1),
    content: "",
  }).success,
  false,
);
assert.equal(
  AppV2WriteFileSchema.safeParse({
    ...validState,
    path: "src/App.tsx",
    content: "x".repeat(AppV2MaxFileContentCharacters + 1),
  }).success,
  false,
);
assert.equal(AppV2LeaseRotateSchema.safeParse(validState).success, true);

async function verifyDisabledRoute(): Promise<void> {
  const previous = process.env.APPS_V2_ENABLED;
  process.env.APPS_V2_ENABLED = "false";
  try {
    const app = new OpenAPIHono<AuthEnv>();
    app.route("/api/workspaces/:workspaceId/apps-v2", appsV2Routes);
    const response = await app.request(
      "/api/workspaces/507f1f77bcf86cd799439011/apps-v2",
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      success: false,
      error: "Apps v2 feature is unavailable",
    });
  } finally {
    if (previous === undefined) delete process.env.APPS_V2_ENABLED;
    else process.env.APPS_V2_ENABLED = previous;
  }
}

void verifyDisabledRoute().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
