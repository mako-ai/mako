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
  // The laptop dev loop builds the local binding text (POST only).
  assert.equal(
    scopedKeyMayAccess("POST", `${base}/latest_sales/dev-build`, read),
    true,
  );
  assert.equal(
    scopedKeyMayAccess("GET", `${base}/latest_sales/dev-build`, read),
    false,
  );
  assert.equal(
    scopedKeyMayAccess("POST", `${base}/latest_sales/dev-build`, mcpOnly),
    false,
  );
  // The viewer lookup behind `__data/viewer.json` in a laptop `vite dev`.
  assert.equal(
    scopedKeyMayAccess("GET", `/api/workspaces/${WS}/apps/${app}/viewer`, read),
    true,
  );
  assert.equal(
    scopedKeyMayAccess(
      "POST",
      `/api/workspaces/${WS}/apps/${app}/viewer`,
      read,
    ),
    false,
  );
  assert.equal(
    scopedKeyMayAccess(
      "GET",
      `/api/workspaces/${WS}/apps/${app}/viewer`,
      mcpOnly,
    ),
    false,
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

// `mako dbt run`: start, follow and cancel a laptop run — with dbt:personal
// or warehouse:write, never with a read-only login. Which ENVIRONMENT a
// scope may build is the route's decision (local-run.service), not this one.
const dbtPersonal = ["mcp", "query:read", "dbt:personal"] as const;
const warehouse = ["mcp", "query:read", "warehouse:write"] as const;
const localRuns = `/api/workspaces/${WS}/dbt/local-runs`;
const RUN = "68b0c0ffee0000000000abcd";
for (const scopes of [dbtPersonal, warehouse]) {
  assert.equal(scopedKeyMayAccess("POST", localRuns, scopes), true);
  assert.equal(scopedKeyMayAccess("GET", `${localRuns}/${RUN}`, scopes), true);
  assert.equal(
    scopedKeyMayAccess("POST", `${localRuns}/${RUN}/cancel`, scopes),
    true,
  );
  // Wrong verbs, and the rest of the dbt surface, stay closed.
  assert.equal(scopedKeyMayAccess("GET", localRuns, scopes), false);
  assert.equal(
    scopedKeyMayAccess("DELETE", `${localRuns}/${RUN}`, scopes),
    false,
  );
  for (const path of [
    `/api/workspaces/${WS}/dbt/projects`,
    `/api/workspaces/${WS}/dbt/projects/${RUN}/runs`,
    `/api/workspaces/${WS}/dbt/projects/${RUN}/jobs/${RUN}/trigger`,
    `/api/workspaces/${WS}/dbt/projects/${RUN}/files/models/a.sql`,
    `/api/workspaces/${WS}/dbt/projects/${RUN}/command`,
  ]) {
    assert.equal(scopedKeyMayAccess("GET", path, scopes), false, path);
    assert.equal(scopedKeyMayAccess("POST", path, scopes), false, path);
  }
}
assert.equal(scopedKeyMayAccess("POST", localRuns, read), false);
assert.equal(scopedKeyMayAccess("GET", `${localRuns}/${RUN}`, read), false);
assert.equal(
  scopedKeyMayAccess("POST", `${localRuns}/${RUN}/cancel`, read),
  false,
);

console.log("scoped-key-routes: ok");
