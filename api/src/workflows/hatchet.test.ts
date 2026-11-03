import assert from "node:assert/strict";

import { parseWorkspaceApiKeyScopes } from "../auth/api-key-scopes";
import { HatchetError, isHatchetId, tenantFromToken } from "./hatchet";

const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";

// A run id from a request goes into a Hatchet path, so it must be a UUID.
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
