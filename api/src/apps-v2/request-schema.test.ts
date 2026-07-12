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
import {
  isAppV2RegistryPackageSpec,
  validateAppV2PackageSpecs,
} from "./package-spec";
import { APP_V2_SESSION_MAX_PACKAGE_COUNT } from "./config";

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
for (const spec of [
  "react",
  "react@18.3.1",
  "react@>=18 <19",
  "@scope/package@latest",
]) {
  assert.equal(isAppV2RegistryPackageSpec(spec), true, spec);
}
for (const spec of [
  "--ignore-scripts",
  "file:../private-package",
  "https://example.com/package.tgz",
  "git+ssh://git@example.com/package.git",
  "safe-package; touch /tmp/not-data",
  "alias@npm:other-package",
]) {
  assert.equal(isAppV2RegistryPackageSpec(spec), false, spec);
}
assert.throws(() => validateAppV2PackageSpecs([]));
assert.throws(() =>
  validateAppV2PackageSpecs(
    Array.from({ length: APP_V2_SESSION_MAX_PACKAGE_COUNT + 1 }, () => "react"),
  ),
);

async function verifyDisabledRouteStillRequiresAuthentication(): Promise<void> {
  const previous = process.env.APPS_V2_ENABLED;
  process.env.APPS_V2_ENABLED = "false";
  try {
    const app = new OpenAPIHono<AuthEnv>();
    app.route("/api/workspaces/:workspaceId/apps-v2", appsV2Routes);
    const response = await app.request(
      "/api/workspaces/507f1f77bcf86cd799439011/apps-v2",
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: "Unauthorized",
    });
  } finally {
    if (previous === undefined) delete process.env.APPS_V2_ENABLED;
    else process.env.APPS_V2_ENABLED = previous;
  }
}

void verifyDisabledRouteStillRequiresAuthentication().catch(error => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
