/* eslint-disable no-console, no-process-exit */
/**
 * Structural tests for the generated OpenAPI document.
 *
 * Run with: tsx src/openapi/openapi.test.ts
 *
 * These assert the document is a well-formed OpenAPI 3.1 spec, that security
 * schemes are registered, that every operation declares responses, and that
 * the tightened modules expose real (non-empty) response schemas rather than
 * an open `{}` body.
 */
import assert from "node:assert/strict";

import { buildOpenApiDocument } from "./document";

type AnyObj = Record<string, unknown>;

const doc = buildOpenApiDocument() as unknown as {
  openapi: string;
  info: { title: string; version: string };
  servers: unknown[];
  security: unknown[];
  paths: Record<string, Record<string, AnyObj>>;
  components: { securitySchemes: Record<string, unknown> };
};

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
]);

function operations(): Array<{ path: string; method: string; op: AnyObj }> {
  const out: Array<{ path: string; method: string; op: AnyObj }> = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (HTTP_METHODS.has(method)) {
        out.push({ path, method, op: op as AnyObj });
      }
    }
  }
  return out;
}

function get200Schema(op: AnyObj): AnyObj | undefined {
  const responses = op.responses as AnyObj | undefined;
  const ok = (responses?.["200"] ?? responses?.["201"]) as AnyObj | undefined;
  const content = ok?.content as AnyObj | undefined;
  const json = content?.["application/json"] as AnyObj | undefined;
  return json?.schema as AnyObj | undefined;
}

function testDocumentEnvelope() {
  assert.equal(doc.openapi, "3.1.0", "must be OpenAPI 3.1.0");
  assert.equal(doc.info.title, "Mako REST API");
  assert.ok(doc.info.version, "info.version must be set");
  assert.ok(Array.isArray(doc.servers) && doc.servers.length > 0, "servers");
}

function testSecuritySchemes() {
  const schemes = doc.components.securitySchemes;
  assert.ok(schemes.cookieAuth, "cookieAuth scheme registered");
  assert.ok(schemes.bearerAuth, "bearerAuth scheme registered");
}

function testHasManyPaths() {
  const ops = operations();
  assert.ok(
    Object.keys(doc.paths).length >= 150,
    `expected >= 150 paths, got ${Object.keys(doc.paths).length}`,
  );
  assert.ok(ops.length >= 200, `expected >= 200 operations, got ${ops.length}`);
}

function testEveryOperationHasResponsesAndMetadata() {
  for (const { path, method, op } of operations()) {
    const where = `${method.toUpperCase()} ${path}`;
    assert.ok(op.responses, `${where} must declare responses`);
    const codes = Object.keys(op.responses as AnyObj);
    assert.ok(codes.length > 0, `${where} must declare >=1 response`);
    assert.ok(
      codes.some(c => c.startsWith("2")),
      `${where} must declare a 2xx response`,
    );
    assert.ok(op.tags && (op.tags as unknown[]).length > 0, `${where} tags`);
    assert.ok(op.operationId, `${where} operationId`);
  }
}

function testPathParamsAreDeclared() {
  // Every `{param}` in a path template must have a matching path parameter.
  for (const { path, method, op } of operations()) {
    const where = `${method.toUpperCase()} ${path}`;
    const templated = [...path.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
    if (templated.length === 0) continue;
    const params = (op.parameters ?? []) as Array<AnyObj>;
    const declared = new Set(
      params.filter(p => p.in === "path").map(p => p.name),
    );
    for (const name of templated) {
      assert.ok(
        declared.has(name),
        `${where} missing path parameter declaration for {${name}}`,
      );
    }
  }
}

function testTightenedModulesHaveTypedResponses() {
  // These endpoints were modelled field-by-field; their 200 schema must be a
  // concrete object/array (a $ref or typed schema), never an empty `{}`.
  const tightened = [
    ["get", "/api/connectors/types"],
    ["get", "/api/databases/types"],
    ["get", "/api/workspaces/{workspaceId}/usage/summary"],
    ["get", "/api/workspaces/{workspaceId}/custom-prompt"],
    ["get", "/api/workspaces/{workspaceId}/dashboards/{id}"],
  ];
  for (const [method, path] of tightened) {
    const op = doc.paths[path]?.[method] as AnyObj | undefined;
    assert.ok(op, `expected operation ${method} ${path}`);
    const schema = get200Schema(op);
    assert.ok(schema, `${method} ${path} must have a 200 JSON schema`);
    const keys = Object.keys(schema);
    assert.ok(
      keys.includes("$ref") ||
        keys.includes("type") ||
        keys.includes("properties") ||
        keys.includes("allOf"),
      `${method} ${path} 200 schema must be typed, got ${JSON.stringify(schema)}`,
    );
    // Must not be a bare `{}` (open body).
    assert.ok(keys.length > 0, `${method} ${path} 200 schema is empty`);
  }
}

function testErrorSchemaComponentExists() {
  const components = doc.components as AnyObj;
  const schemas = (components.schemas ?? {}) as AnyObj;
  assert.ok(schemas.Error, "Error schema component must be registered");
  assert.ok(
    schemas.ErrorEnvelope,
    "ErrorEnvelope schema component must be registered",
  );
  assert.ok(
    schemas.GenericJsonResponse,
    "GenericJsonResponse schema component must be registered",
  );
  assert.ok(schemas.Dashboard, "Dashboard schema component must be registered");
}

function testErrorResponsesAreTyped() {
  // Every declared 4xx/5xx JSON response must reference a typed schema, never
  // an open `{}` body. This enforces that no endpoint regresses to `z.any()`
  // for its error envelope.
  let checked = 0;
  for (const { path, method, op } of operations()) {
    const responses = (op.responses ?? {}) as Record<string, AnyObj>;
    for (const [code, resp] of Object.entries(responses)) {
      if (code !== "default" && !/^[45]\d\d$/.test(code)) continue;
      const content = resp.content as AnyObj | undefined;
      const json = content?.["application/json"] as AnyObj | undefined;
      if (!json) continue; // some errors are content-less by design
      const schema = json.schema as AnyObj | undefined;
      assert.ok(
        schema && Object.keys(schema).length > 0,
        `${method.toUpperCase()} ${path} ${code} error must reference a typed schema`,
      );
      checked++;
    }
  }
  assert.ok(
    checked >= 50,
    `expected many typed error responses, got ${checked}`,
  );
}

function testNoPlaceholderStatusExplosion() {
  for (const { path, method, op } of operations()) {
    const responses = (op.responses ?? {}) as Record<string, AnyObj>;
    const codes = Object.keys(responses);
    assert.ok(
      codes.length <= 8,
      `${method.toUpperCase()} ${path} declares too many response statuses: ${codes.join(", ")}`,
    );
  }
}

function testAppsOperationsRegisteredAndSecured() {
  // Apps is always registered and always available (no feature flag).
  // Unlike the parallel-branch draft, API keys are deliberately ALLOWED —
  // external harnesses (CLI/MCP, see apps.md §4.8) authenticate with them —
  // so every operation must carry auth security, not cookie-only security.
  const appsOps = operations().filter(({ path }) => path.includes("/apps"));
  assert.ok(appsOps.length >= 12, "Apps operations registered");
  for (const { path, method, op } of appsOps) {
    const where = `${method.toUpperCase()} ${path}`;
    const security = (op.security ?? []) as Array<Record<string, unknown>>;
    assert.ok(
      security.some(s => "cookieAuth" in s || "bearerAuth" in s),
      `${where} must require authentication`,
    );
  }
}

function main() {
  testDocumentEnvelope();
  testAppsOperationsRegisteredAndSecured();
  testSecuritySchemes();
  testHasManyPaths();
  testEveryOperationHasResponsesAndMetadata();
  testPathParamsAreDeclared();
  testTightenedModulesHaveTypedResponses();
  testErrorSchemaComponentExists();
  testErrorResponsesAreTyped();
  testNoPlaceholderStatusExplosion();

  const ops = operations();
  console.log(
    `openapi.test: OK — ${Object.keys(doc.paths).length} paths, ${ops.length} operations`,
  );
  process.exit(0);
}

main();
