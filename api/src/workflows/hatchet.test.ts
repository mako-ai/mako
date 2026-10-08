import assert from "node:assert/strict";

import { parseWorkspaceApiKeyScopes } from "../auth/api-key-scopes";
import {
  HatchetError,
  isHatchetId,
  resolveHatchetRead,
  tenantFromToken,
} from "./hatchet";

/**
 * The Hatchet pass-through is the one place a browser's path reaches Hatchet,
 * so the allowlist is the tenancy boundary on Mako's side: the tenant in the
 * target must always be the server's, and nothing outside the list resolves.
 */
const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";

assert.equal(
  resolveHatchetRead("runs", TENANT),
  `/api/v1/stable/tenants/${TENANT}/workflow-runs`,
);
assert.equal(
  resolveHatchetRead(`runs/${RUN}`, TENANT),
  `/api/v1/stable/workflow-runs/${RUN}`,
);
assert.equal(
  resolveHatchetRead(`runs/${RUN}/task-events`, TENANT),
  `/api/v1/stable/workflow-runs/${RUN}/task-events`,
);
assert.equal(
  resolveHatchetRead(`tasks/${RUN}/logs`, TENANT),
  `/api/v1/stable/tasks/${RUN}/logs`,
);
assert.equal(
  resolveHatchetRead("workers", TENANT),
  `/api/v1/tenants/${TENANT}/worker`,
);
assert.equal(
  resolveHatchetRead("crons", TENANT),
  `/api/v1/tenants/${TENANT}/workflows/crons`,
);

// Not on the list: other Hatchet routes, a caller-chosen tenant, traversal.
for (const path of [
  "",
  "api-tokens",
  `tenants/${RUN}/workflows`,
  `tenants/${RUN}/api-tokens`,
  "runs/not-a-uuid",
  `runs/${RUN}/../../tenants`,
  `runs/${RUN}/cancel`,
  "../users/current",
  "workflows/crons/extra",
]) {
  assert.equal(resolveHatchetRead(path, TENANT), null, `must refuse ${path}`);
}

assert.equal(isHatchetId(RUN), true);
assert.equal(isHatchetId("../x"), false);
assert.equal(isHatchetId(`${RUN}/logs`), false);

// A person cannot mint the worker's scope: it carries model access.
assert.throws(
  () => parseWorkspaceApiKeyScopes(["mcp", "workflows:runtime"]),
  /reserved/,
);

// A Hatchet token is the whole connection: tenant and API address come from it.
const jwt = (claims: object) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const token = jwt({ sub: TENANT, server_url: "https://hatchet.example/" });
delete process.env.HATCHET_API_URL;
assert.deepEqual(tenantFromToken(token), {
  tenantId: TENANT,
  token,
  apiUrl: "https://hatchet.example",
});
// HATCHET_API_URL wins over the address in the token.
process.env.HATCHET_API_URL = "http://10.0.0.1:8080";
assert.equal(tenantFromToken(token).apiUrl, "http://10.0.0.1:8080");
delete process.env.HATCHET_API_URL;
for (const bad of [
  "",
  "not-a-token",
  jwt({ server_url: "https://x" }),
  jwt({ sub: TENANT }),
]) {
  assert.throws(() => tenantFromToken(bad), HatchetError, `must refuse ${bad}`);
}

console.log("workflows hatchet tests passed");
