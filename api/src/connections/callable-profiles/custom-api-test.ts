/**
 * Test for a Custom API connection: one GET on the test path (or a
 * `{ __typename }` query with GraphQL on), then the optional `test_expect`
 * check. Moved unchanged from the deleted `connectors/custom_api/connector.ts`
 * (its `testConnection`).
 */
import type { ConnectionTestResult } from "../../connectors/base/BaseConnector";
import type { ISourceConnection } from "../../database/workspace-schema";
import type { CallableConnection } from "../callable";
import { forward } from "../forward";

/** A JSON field Test needs in the answer, and the value it needs there. */
interface TestExpectation {
  path: string;
  raw: string;
}

/**
 * APIs that answer 200 with an error in the body, the field that says so,
 * and a path that needs the credential (their root may only redirect).
 * Used when the connection sets no `test_expect` of its own.
 */
const DEFAULT_EXPECTATIONS: { host: RegExp; expect: string; path: string }[] = [
  { host: /(^|\.)slack\.com$/i, expect: "ok=true", path: "/auth.test" },
];

/** `path=value` (or `path==value`), or null when it is not that shape. */
export function parseTestExpectation(text: string): TestExpectation | null {
  const match = /^\s*([^=\s]+)\s*==?\s*(.*?)\s*$/.exec(text);
  return match ? { path: match[1], raw: match[2] } : null;
}

/**
 * What Test checks in the answer: the connection's own `test_expect`, or a
 * known API's default together with that API's test path when none is set.
 */
function testExpectation(config: Record<string, unknown>): {
  expectation?: TestExpectation;
  defaultPath?: string;
  error?: string;
} {
  if (typeof config.test_expect === "string" && config.test_expect.trim()) {
    const expectation = parseTestExpectation(config.test_expect);
    return expectation
      ? { expectation }
      : {
          error: `Test expects must be path=value (e.g. ok=true), not "${config.test_expect.trim().slice(0, 100)}".`,
        };
  }
  if (config.graphql === true || typeof config.base_url !== "string") {
    return {};
  }
  let host: string;
  try {
    host = new URL(config.base_url).hostname;
  } catch {
    return {};
  }
  const known = DEFAULT_EXPECTATIONS.find(d => d.host.test(host));
  const expectation = known && parseTestExpectation(known.expect);
  return expectation ? { expectation, defaultPath: known.path } : {};
}

/**
 * Why the answer does not meet the expectation, or null when it does. The
 * value is compared as JSON (true, 1, null, "x", {"a":1}) and, failing that,
 * as text.
 */
export function unmetExpectation(
  body: unknown,
  expectation: TestExpectation,
): string | null {
  let actual: unknown = body;
  for (const key of expectation.path.split(".")) {
    actual =
      actual !== null && typeof actual === "object"
        ? (actual as Record<string, unknown>)[key]
        : undefined;
  }
  let expected: unknown = expectation.raw;
  try {
    expected = JSON.parse(expectation.raw);
  } catch {
    // A bare word such as `active`: compared as text.
  }
  const same =
    actual === expected ||
    (typeof expected === "object" &&
      expected !== null &&
      JSON.stringify(actual) === JSON.stringify(expected)) ||
    (typeof actual !== "object" && String(actual) === expectation.raw);
  if (same) return null;
  const shown =
    actual === undefined ? "missing" : JSON.stringify(actual).slice(0, 200);
  const error =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>).error
      : undefined;
  return `The service answered, but ${expectation.path} is ${shown}, not ${expectation.raw}${
    typeof error === "string" ? ` (error: ${error.slice(0, 200)})` : ""
  }.`;
}

/** Test a Custom API connection through `callable` (customApiProfile's). */
export async function testCustomApiConnection(
  sourceConnection: ISourceConnection,
  callable: CallableConnection,
): Promise<ConnectionTestResult> {
  // A missing or non-http(s) address is refused by the proxy's own check
  // (connections/forward.ts `urlUnder`), with a message the form shows.
  const config = sourceConnection.config ?? {};
  const { expectation, defaultPath, error } = testExpectation(config);
  if (error) return { success: false, message: error };
  const testPath =
    typeof config.test_path === "string" && config.test_path.trim()
      ? config.test_path.trim()
      : (defaultPath ?? "/");
  try {
    const answer = await forward(
      sourceConnection,
      callable,
      config.graphql === true
        ? { method: "POST", path: "/", body: { query: "{ __typename }" } }
        : { method: "GET", path: testPath },
      { timeoutMs: 15_000 },
    );
    if (answer.status === 401 || answer.status === 403) {
      return {
        success: false,
        message: `The service refused the credential (HTTP ${answer.status}).`,
      };
    }
    if (answer.status >= 400) {
      return {
        success: false,
        message: `The service answered HTTP ${answer.status}. Set a test path that exists.`,
      };
    }
    const problem = expectation && unmetExpectation(answer.body, expectation);
    if (problem) return { success: false, message: problem };
    return {
      success: true,
      message: `Connected (HTTP ${answer.status}).`,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "The request failed",
    };
  }
}
