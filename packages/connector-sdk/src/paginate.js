/**
 * `ctx.paginate`: the four shapes almost every REST API uses.
 *
 * Measured against 509 Airbyte manifests, pagination is cursor, offset, page
 * number, or a link in the response — and getting one of them subtly wrong
 * (an off-by-one page, a cursor that repeats forever) is the most common way
 * a hand-written connector silently loses or duplicates rows. So the loop
 * lives here once, with a stop condition that cannot spin.
 */

/**
 * Walk a dotted path: `"data.items"`, `"meta.next_cursor"`.
 * Returns undefined rather than throwing, because a missing `next` is how
 * most APIs say "last page".
 */
export function pick(object, path) {
  if (!path) return object;
  return String(path)
    .split(".")
    .reduce((value, key) => (value == null ? undefined : value[key]), object);
}

/**
 * @yields {{ records: unknown[], cursor: unknown }} one page at a time, with
 * the cursor to resume AFTER that page. Yielding the resume point with the
 * page is what makes a chunk boundary safe: the caller can stop at any page
 * and come back exactly there.
 */
export async function* paginate({
  fetchPage,
  style = "cursor",
  recordsPath,
  cursorPath,
  linkPath,
  pageSize = 100,
  startCursor,
  startPage = 1,
  maxPages = Infinity,
}) {
  let cursor = startCursor;
  let page = startPage;
  let offset = typeof startCursor === "number" ? startCursor : 0;
  let pages = 0;
  const seenCursors = new Set();

  while (pages < maxPages) {
    const response = await fetchPage({ cursor, page, offset, pageSize });
    if (response == null) return;

    const records = recordsPath ? (pick(response, recordsPath) ?? []) : response;
    const list = Array.isArray(records) ? records : [records];

    let next;
    if (style === "cursor") next = pick(response, cursorPath);
    else if (style === "link") next = pick(response, linkPath);
    else if (style === "page") next = list.length < pageSize ? undefined : page + 1;
    else if (style === "offset") next = list.length < pageSize ? undefined : offset + list.length;
    else throw new Error(`Unknown pagination style "${style}"`);

    pages += 1;
    yield { records: list, cursor: next };

    if (next == null || next === "" || next === false) return;
    // An API that returns the cursor it was given is a real failure mode, and
    // without this check the connector fetches the same page until the chunk
    // budget runs out — forever, in a scheduled flow.
    if (style === "cursor" || style === "link") {
      const key = String(next);
      if (seenCursors.has(key)) {
        throw new Error(
          `Pagination stopped: the API returned a cursor it had already returned (${key.slice(0, 120)}). ` +
            `This would loop forever. Check cursorPath.`,
        );
      }
      seenCursors.add(key);
    }
    if (list.length === 0 && (style === "cursor" || style === "link")) return;

    cursor = next;
    if (style === "page") page = next;
    if (style === "offset") offset = next;
  }
}
