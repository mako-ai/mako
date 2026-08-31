import assert from "node:assert/strict";
import { scopedKeyMayAccess } from "./scoped-key-routes";

const WS = "6846e6a01b05af0948070582";
const read = ["mcp", "query:read"] as const;
const mcpOnly = ["mcp"] as const;

// The MCP endpoint is always reachable; its own scope check lives in the route.
assert.equal(scopedKeyMayAccess("POST", "/api/mcp", mcpOnly), true);
assert.equal(scopedKeyMayAccess("GET", "/api/mcp/", mcpOnly), true);

// query:read opens exactly the binding read routes, by slug or id.
for (const app of ["latest-sales", "68b0c0ffee0000000000abcd"]) {
  const base = `/api/workspaces/${WS}/apps/${app}/bindings`;
  assert.equal(scopedKeyMayAccess("GET", base, read), true);
  assert.equal(
    scopedKeyMayAccess("GET", `${base}/latest_sales/artifact`, read),
    true,
  );
  assert.equal(
    scopedKeyMayAccess("POST", `${base}/latest_sales/materialize`, read),
    true,
  );
  // Wrong verb on an allowed path is not allowed.
  assert.equal(scopedKeyMayAccess("POST", base, read), false);
  assert.equal(
    scopedKeyMayAccess("DELETE", `${base}/latest_sales/artifact`, read),
    false,
  );
  assert.equal(
    scopedKeyMayAccess("GET", `${base}/latest_sales/materialize`, read),
    false,
  );
  // Without query:read, nothing outside /api/mcp opens.
  assert.equal(scopedKeyMayAccess("GET", base, mcpOnly), false);
  assert.equal(
    scopedKeyMayAccess("GET", `${base}/latest_sales/artifact`, mcpOnly),
    false,
  );
}

// Neighbouring app routes stay closed to scoped keys.
for (const path of [
  `/api/workspaces/${WS}/apps`,
  `/api/workspaces/${WS}/apps/latest-sales`,
  `/api/workspaces/${WS}/apps/latest-sales/file`,
  `/api/workspaces/${WS}/apps/latest-sales/exec`,
  `/api/workspaces/${WS}/apps/latest-sales/commit`,
  `/api/workspaces/${WS}/apps/latest-sales/bindings/x/artifact/extra`,
  `/api/workspaces/${WS}/api-keys`,
  `/api/mcp/other`,
]) {
  assert.equal(scopedKeyMayAccess("GET", path, read), false, path);
  assert.equal(scopedKeyMayAccess("POST", path, read), false, path);
}

// Path traversal / odd encodings do not match.
assert.equal(
  scopedKeyMayAccess(
    "GET",
    `/api/workspaces/${WS}/apps/../../api-keys/bindings`,
    read,
  ),
  false,
);

console.log("scoped-key-routes: ok");
