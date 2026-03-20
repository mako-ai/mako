/**
 * Generates self-contained pagination helper code that runs inside the E2B sandbox.
 * This code uses native `fetch` and must not import any Node-specific modules.
 *
 * The generated code provides a `paginate()` async generator that supports
 * cursor-based, offset-based, and link-based pagination strategies.
 */

export function getPaginateHelperCode(): string {
  return `
/**
 * Pagination helper — available as ctx.paginate() inside connector pull().
 *
 * @param {Object} options
 * @param {string} options.url - Base URL for the first request
 * @param {Object} [options.headers] - HTTP headers for each request
 * @param {"cursor"|"offset"|"link"} [options.strategy] - Pagination strategy (default: "cursor")
 * @param {string} [options.cursorParam] - Query param name for cursor (default: "cursor")
 * @param {string} [options.cursorPath] - JSON path to next cursor in response (default: "next_cursor")
 * @param {string} [options.dataPath] - JSON path to data array in response (default: "data")
 * @param {string} [options.offsetParam] - Query param name for offset (default: "offset")
 * @param {string} [options.limitParam] - Query param name for limit (default: "limit")
 * @param {number} [options.limit] - Page size (default: 100)
 * @param {string} [options.nextLinkPath] - JSON path to next page URL (for link strategy)
 * @param {string} [options.method] - HTTP method (default: "GET")
 * @param {*} [options.body] - Request body (for POST pagination)
 * @param {number} [options.maxPages] - Safety limit on total pages (default: 1000)
 * @returns {AsyncGenerator<any[]>} Yields arrays of records per page
 */
async function* paginate(options) {
  const {
    url,
    headers = {},
    strategy = "cursor",
    cursorParam = "cursor",
    cursorPath = "next_cursor",
    dataPath = "data",
    offsetParam = "offset",
    limitParam = "limit",
    limit = 100,
    nextLinkPath = "next",
    method = "GET",
    body,
    maxPages = 1000,
  } = options;

  function getNestedValue(obj, path) {
    return path.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
  }

  let pageCount = 0;

  if (strategy === "cursor") {
    let cursor = null;
    while (pageCount < maxPages) {
      const reqUrl = new URL(url);
      if (cursor) reqUrl.searchParams.set(cursorParam, cursor);
      reqUrl.searchParams.set(limitParam, String(limit));

      const fetchOpts = { method, headers: { ...headers } };
      if (body && method !== "GET") fetchOpts.body = typeof body === "string" ? body : JSON.stringify(body);

      const res = await fetch(reqUrl.toString(), fetchOpts);
      if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()));
      const json = await res.json();

      const data = getNestedValue(json, dataPath);
      if (!Array.isArray(data) || data.length === 0) break;
      yield data;
      pageCount++;

      cursor = getNestedValue(json, cursorPath);
      if (!cursor) break;
    }
  } else if (strategy === "offset") {
    let offset = 0;
    while (pageCount < maxPages) {
      const reqUrl = new URL(url);
      reqUrl.searchParams.set(offsetParam, String(offset));
      reqUrl.searchParams.set(limitParam, String(limit));

      const fetchOpts = { method, headers: { ...headers } };
      if (body && method !== "GET") fetchOpts.body = typeof body === "string" ? body : JSON.stringify(body);

      const res = await fetch(reqUrl.toString(), fetchOpts);
      if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()));
      const json = await res.json();

      const data = getNestedValue(json, dataPath);
      if (!Array.isArray(data) || data.length === 0) break;
      yield data;
      pageCount++;
      offset += data.length;

      if (data.length < limit) break;
    }
  } else if (strategy === "link") {
    let nextUrl = url;
    while (nextUrl && pageCount < maxPages) {
      const fetchOpts = { method, headers: { ...headers } };
      if (body && method !== "GET") fetchOpts.body = typeof body === "string" ? body : JSON.stringify(body);

      const res = await fetch(nextUrl, fetchOpts);
      if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()));
      const json = await res.json();

      const data = getNestedValue(json, dataPath);
      if (!Array.isArray(data) || data.length === 0) break;
      yield data;
      pageCount++;

      nextUrl = getNestedValue(json, nextLinkPath) || null;
    }
  }
}
`;
}
